import { encodeFolderTitle, decodePinTitle, isSyncableUrl } from "./codec.js";
import { mergeRoots, readTree } from "./tree.js";
import { matchGroups, matchTabs } from "./match.js";
import { probeMissingBookmark } from "./state.js";

/** Temporary listeners observe restore activity, independently of the serial queue. */
export function settle(api, { settleMs = 3000, maxWaitMs = 20000, now = Date.now } = {}) {
  const events = [
    ...["onCreated", "onUpdated", "onRemoved", "onMoved", "onAttached", "onDetached", "onActivated"]
      .map(name => api.tabs[name]),
    ...["onCreated", "onUpdated", "onRemoved", "onMoved"].map(name => api.tabGroups[name]),
  ];
  return new Promise(resolve => {
    const deadline = now() + maxWaitMs;
    let quietTimer, limitTimer;
    function finish() {
      clearTimeout(quietTimer);
      clearTimeout(limitTimer);
      for (const event of events) event.removeListener(activity);
      resolve();
    }
    function activity() {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, Math.max(0, Math.min(settleMs, deadline - now())));
    }
    for (const event of events) event.addListener(activity);
    limitTimer = setTimeout(finish, Math.max(0, maxWaitMs));
    activity();
  });
}

/** Never infer bookmark deletion from absent tabs, even after failed restore. */
export async function rebuild({ api, state, outbound, inbound, names, lostIdentity = false }) {
  const previous = lostIdentity ? structuredClone(state) : null;
  const pageTitles = new Map(Object.values(state.tabs).map(entry => [entry.bookmarkId, entry]));
  let knownRootId = state.rootId;
  const previousOpen = [...new Set([...state.openFolders, ...state.missing])];
  if (lostIdentity && knownRootId) {
    try { if (!(await api.bookmarks.get(knownRootId)).length) knownRootId = null; }
    catch (error) {
      if (await probeMissingBookmark(api, knownRootId)) knownRootId = null;
      else throw error;
    }
  }
  // Browser-session ids can be reused. Clear before the first outbound operation.
  state.groups = {};
  state.tabs = {};
  state.pendingRemovals = {};
  state.failedCreates = previous ? { ...previous.failedCreates } : {};
  state.quietUntil = {};
  state.expectedMoves = {};
  if (!lostIdentity) delete state.lastFocusedNormalWindowId;
  state.openFolders = [];
  const merged = await mergeRoots(api, knownRootId);
  Object.assign(state, { rootId: merged.rootId, pinnedId: merged.pinnedId });
  for (let index = 0; index < previousOpen.length; index++) previousOpen[index] = merged.folderRemaps[previousOpen[index]] ?? previousOpen[index];
  const tree = await readTree(api, state.rootId);
  // A closed/missing folder can also be silently re-IDed. Use its last known
  // name, colour and URLs, not stale GUIDs, to retain the device's open intent.
  if (previous) {
    const identityIds = previousOpen.filter(id => previous.folderSnapshots?.[id]);
    const identities = identityIds
      .map((id, groupId) => ({ groupId, ...previous.folderSnapshots[id] }));
    const pairs = matchGroups(identities, tree.folders, previousOpen).pairs;
    for (const { groupId, folderId } of pairs) {
      const oldId = identityIds[groupId];
      const index = previousOpen.indexOf(oldId);
      previousOpen[index] = folderId;
      merged.folderRemaps[oldId] = folderId;
    }
  }
  state.folderSnapshots = Object.fromEntries(tree.folders.map(folder => [folder.id,
    { title: folder.name, color: folder.color, urls: folder.bookmarks.map(node => node.url) }]));
  const tabs = (await api.tabs.query({})).filter(tab => !tab.incognito).sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  const normalIds = new Set((await api.windows.getAll({ windowTypes: ["normal"] }))
    .filter(win => !win.incognito && win.type === "normal").map(win => win.id));
  const groups = (await api.tabGroups.query({})).filter(group => normalIds.has(group.windowId)
    && tabs.some(tab => tab.groupId === group.id && !tab.pinned && isSyncableUrl(tab.url, api.runtime.getURL(""))));
  const matches = matchGroups(groups.map(group => ({ groupId: group.id,
    title: group.title, color: group.color, urls: tabs.filter(tab => tab.groupId === group.id).map(tab => tab.url) })), tree.folders, previousOpen);

  function bindTabs(local, folder) {
    const match = matchTabs(local.map(tab => ({ tabId: tab.id,
      url: previous?.tabs[tab.id]?.url ?? tab.url })), folder.bookmarks);
    for (const pair of match.pairs) {
      const tab = local.find(tab => tab.id === pair.tabId);
      const old = previous?.tabs[tab.id];
      const saved = pageTitles.get(pair.bookmarkId);
      const name = folder.id === state.pinnedId ? decodePinTitle(folder.bookmarks.find(node => node.id === pair.bookmarkId).title) : null;
      // Updates/reloads can leave the name as the label while replacing the keeper.
      // Retain only its page-title fallback by bookmark and URL, never a tab id.
      const pageTitle = name && tab.title === name
        ? (saved?.appliedName === name && saved.url === tab.url ? saved.title : tab.url)
        : tab.title ?? "";
      state.tabs[tab.id] = { bookmarkId: pair.bookmarkId, folderId: folder.id,
        url: old?.url ?? tab.url, title: old?.title ?? pageTitle,
        ...(old?.appliedName ? { appliedName: old.appliedName } : {}) };
      if (old) {
        if (previous.quietUntil[tab.id] !== undefined) state.quietUntil[tab.id] = previous.quietUntil[tab.id];
        const removal = previous.pendingRemovals[tab.id];
        if (removal?.bookmarkId === old.bookmarkId) state.pendingRemovals[tab.id] = {
          ...removal, bookmarkId: pair.bookmarkId, folderId: folder.id,
        };
        if (Array.isArray(previous.expectedMoves?.[old.bookmarkId])) state.expectedMoves[pair.bookmarkId] =
          previous.expectedMoves[old.bookmarkId].filter(move => move && typeof move.parentId === "string")
            .map(move => ({ ...move, parentId:
            move.parentId === previous.pinnedId ? state.pinnedId : merged.folderRemaps[move.parentId] ?? move.parentId }));
      }
    }
    return match;
  }
  function bindPending(folder) {
    if (!previous) return;
    const pending = Object.entries(previous.pendingRemovals).filter(([tabId, removal]) => {
      const target = removal.folderId === previous.pinnedId ? state.pinnedId : merged.folderRemaps[removal.folderId] ?? removal.folderId;
      return target === folder.id && !tabs.some(tab => tab.id === Number(tabId)) && previous.tabs[tabId];
    });
    const used = new Set(Object.values(state.tabs).map(entry => entry.bookmarkId));
    const matches = matchTabs(pending.map(([tabId]) => ({ tabId, url: previous.tabs[tabId].url })),
      folder.bookmarks.filter(node => !used.has(node.id)));
    for (const { tabId, bookmarkId } of matches.pairs) {
      state.tabs[tabId] = { ...previous.tabs[tabId], bookmarkId, folderId: folder.id };
      state.pendingRemovals[tabId] = { ...previous.pendingRemovals[tabId], bookmarkId, folderId: folder.id };
    }
  }
  // Bind ALL pairs before reconciliation, so cross-folder identity is available.
  const matched = [];
  for (const { groupId, folderId } of matches.pairs) {
    const oldFolder = previous?.groups[groupId]?.folderId;
    if (oldFolder) merged.folderRemaps[oldFolder] = folderId;
  }
  for (const pair of matches.pairs) {
    const folder = tree.folders.find(folder => folder.id === pair.folderId);
    const group = groups.find(group => group.id === pair.groupId);
    state.groups[group.id] = { ...(previous?.groups[group.id] ?? {}), folderId: folder.id, title: encodeFolderTitle(group) };
    state.openFolders.push(folder.id);
    matched.push({ folder, match: bindTabs(tabs.filter(tab => tab.groupId === group.id && !tab.pinned), folder) });
  }
  for (const { folder, match } of matched) {
    bindPending(folder);
    for (const tabId of match.unmatchedTabs) await outbound.syncTab(tabId);
    await inbound.reconcileFolder(folder.id);
  }
  for (const groupId of matches.unmatchedGroups) await outbound.syncGroup(groupId);
  const existing = new Set(tree.folders.map(folder => folder.id));
  state.missing = [...new Set(previousOpen)].filter(id => existing.has(id) && !state.openFolders.includes(id));
  state.deferred = state.deferred.map(id => id === previous?.pinnedId ? state.pinnedId : merged.folderRemaps[id] ?? id)
    .filter(id => id === state.pinnedId || existing.has(id));
  for (const id of Object.keys(state.cantReopen)) {
    if (id !== state.pinnedId && !existing.has(id)) delete state.cantReopen[id];
  }
  const pins = bindTabs(tabs.filter(tab => tab.pinned), tree.pinned);
  bindPending(tree.pinned);
  for (const tabId of pins.unmatchedTabs) await outbound.syncTab(tabId);
  // Inbound implements folder-relative pin order and Firefox's create-then-discard rule.
  await inbound.reconcileFolder(state.pinnedId);
  await names?.applyAll();
}
