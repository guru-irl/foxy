import { encodeFolderTitle, isSyncableUrl } from "./codec.js";
import { mergeRoots, readTree } from "./tree.js";
import { matchGroups, matchTabs } from "./match.js";

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
export async function rebuild({ api, state, outbound, inbound }) {
  const knownRootId = state.rootId, previousOpen = [...new Set([...state.openFolders, ...state.missing])];
  // Browser-session ids can be reused. Clear before the first outbound operation.
  state.groups = {};
  state.tabs = {};
  state.pendingRemovals = {};
  state.failedCreates = {};
  state.quietUntil = {};
  state.expectedMoves = {};
  delete state.lastFocusedNormalWindowId;
  state.openFolders = [];
  Object.assign(state, await mergeRoots(api, knownRootId));
  const tree = await readTree(api, state.rootId);
  const tabs = (await api.tabs.query({})).filter(tab => !tab.incognito).sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  const normalIds = new Set((await api.windows.getAll({ windowTypes: ["normal"] }))
    .filter(win => !win.incognito && win.type === "normal").map(win => win.id));
  const groups = (await api.tabGroups.query({})).filter(group => normalIds.has(group.windowId)
    && tabs.some(tab => tab.groupId === group.id && !tab.pinned && isSyncableUrl(tab.url, api.runtime.getURL(""))));
  const matches = matchGroups(groups.map(group => ({ groupId: group.id,
    title: group.title, color: group.color, urls: tabs.filter(tab => tab.groupId === group.id).map(tab => tab.url) })), tree.folders);

  function bindTabs(local, folder) {
    const match = matchTabs(local.map(tab => ({ tabId: tab.id, url: tab.url })), folder.bookmarks);
    for (const pair of match.pairs) {
      const tab = local.find(tab => tab.id === pair.tabId);
      state.tabs[tab.id] = { bookmarkId: pair.bookmarkId, folderId: folder.id,
        url: tab.url, title: tab.title ?? "" };
    }
    return match;
  }
  // Bind ALL pairs before reconciliation, so cross-folder identity is available.
  const matched = [];
  for (const pair of matches.pairs) {
    const folder = tree.folders.find(folder => folder.id === pair.folderId);
    const group = groups.find(group => group.id === pair.groupId);
    state.groups[group.id] = { folderId: folder.id, title: encodeFolderTitle(group) };
    state.openFolders.push(folder.id);
    matched.push({ folder, match: bindTabs(tabs.filter(tab => tab.groupId === group.id && !tab.pinned), folder) });
  }
  for (const { folder, match } of matched) {
    for (const tabId of match.unmatchedTabs) await outbound.syncTab(tabId);
    await inbound.reconcileFolder(folder.id);
  }
  for (const groupId of matches.unmatchedGroups) await outbound.syncGroup(groupId);
  const existing = new Set(tree.folders.map(folder => folder.id));
  state.missing = previousOpen.filter(id => existing.has(id) && !state.openFolders.includes(id));
  state.deferred = state.deferred.filter(id => id === state.pinnedId || existing.has(id));
  for (const id of Object.keys(state.cantReopen)) {
    if (id !== state.pinnedId && !existing.has(id)) delete state.cantReopen[id];
  }
  const pins = bindTabs(tabs.filter(tab => tab.pinned), tree.pinned);
  for (const tabId of pins.unmatchedTabs) await outbound.syncTab(tabId);
  // Inbound implements folder-relative pin order and Firefox's create-then-discard rule.
  await inbound.reconcileFolder(state.pinnedId);
}
