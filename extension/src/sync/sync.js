import { handleMessage } from "../close.js";
import { isOpenableUrl, isSyncableUrl, encodeFolderTitle, ROOT_TITLE, isPinnedFolderTitle } from "./codec.js";
import { createQueue, loadState, saveState, groupOfFolder } from "./state.js";
import { ensurePinnedFolder, readTree, mergeRoots, OTHER_BOOKMARKS } from "./tree.js";
import { createOutbound } from "./outbound.js";
import { createInbound } from "./inbound.js";
import { matchGroups, matchTabs } from "./match.js";
import { settle, rebuild } from "./startup.js";

/** One controller per event-page lifetime. Only storage.session marks a browser session. */
export function createSync({ api, now = Date.now, removeDelayMs, quietMs,
  settleMs = 3000, maxWaitMs = 20000 }) {
  const queue = createQueue();
  let state, starting;
  const returnTimers = new Map(), movedTabs = new Set();
  let moveTimer;
  const save = () => saveState(api, state);
  const outbound = createOutbound({ api, getState: () => state, save, now, removeDelayMs, quietMs,
    extensionBaseUrl: api.runtime.getURL(""),
    schedule: ms => setTimeout(() => queue.run(flush).catch(() => {}), ms),
  });
  // Losing OS focus doesn't stop showing the last Firefox window's active tab.
  // Keep this adapter local to sync; never mutate the injected browser object.
  const eligibleWindow = win => win && !win.incognito && win.type === "normal";
  async function rememberNormalWindow(win) {
    if (state.lastFocusedNormalWindowId !== win.id) {
      state.lastFocusedNormalWindowId = win.id;
      await save();
    }
    return win;
  }
  async function normalWindow(windowId) {
    if (windowId !== undefined) {
      try {
        const win = await api.windows.get(windowId);
        if (eligibleWindow(win)) return win;
      } catch (error) { console.warn("Foxy: destination window is unavailable", error); }
    }
    try {
      const win = await api.windows.getLastFocused({ windowTypes: ["normal"] });
      if (eligibleWindow(win)) return rememberNormalWindow(win);
    } catch (error) { console.warn("Foxy: last focused window is unavailable", error); }
    if (Number.isInteger(state.lastFocusedNormalWindowId)) {
      try {
        const win = await api.windows.get(state.lastFocusedNormalWindowId);
        if (eligibleWindow(win)) return win;
      } catch { /* Last normal window may have closed. Fall back to a live one. */ }
    }
    const win = (await api.windows.getAll({ windowTypes: ["normal"] })).find(eligibleWindow);
    return win ? rememberNormalWindow(win) : null;
  }
  // Explicit receiver-preserving wrappers: Firefox namespaces need not have
  // own enumerable methods. Pins and shown-tab decisions use non-private windows.
  const inboundApi = {
    tabs: {
      async get(...args) {
        const tab = await api.tabs.get(...args);
        if (tab.incognito) throw new Error("Private tabs are not synced");
        return tab;
      },
      query: async (...args) => (await api.tabs.query(...args)).filter(tab => !tab.incognito),
      create: async props => {
        if (props.windowId === api.windows.WINDOW_ID_NONE) throw new Error("No non-private normal window");
        return api.tabs.create(props);
      },
      update: (...args) => api.tabs.update(...args),
      move: (...args) => api.tabs.move(...args),
      group: (...args) => api.tabs.group(...args),
      ungroup: (...args) => api.tabs.ungroup(...args),
      remove: (...args) => api.tabs.remove(...args),
      discard: (...args) => api.tabs.discard(...args),
    },
    tabGroups: {
      async get(...args) {
        const group = await api.tabGroups.get(...args);
        if ((await api.windows.get(group.windowId)).incognito) throw new Error("Private groups are not synced");
        return group;
      },
      update: (...args) => api.tabGroups.update(...args),
    },
    bookmarks: {
      getChildren: (...args) => api.bookmarks.getChildren(...args),
      async get(ids) {
        const nodes = await api.bookmarks.get(ids);
        for (const node of nodes) {
          if (node.type === "folder" && groupOfFolder(state, node.id) !== null && node.parentId !== state.rootId) {
            // Safety-blocked removals retain mappings, not import permission.
            throw new Error(`Invalid bookmark ID: ${node.id}`);
          }
        }
        return nodes;
      },
    },
    windows: {
      async getLastFocused() {
        const win = await normalWindow();
        // No eligible window means no shown tab and no destination for pins.
        return win ? { ...win, focused: true } : { id: api.windows.WINDOW_ID_NONE, focused: false };
      },
    },
  };
  const inbound = createInbound({ api: inboundApi, getState: () => state, save, now, quietMs,
    orderReleased: members => { for (const tab of members) syncMovedTab(tab.id); },
  });

  async function rebuildMaps() {
    await rebuild({ api, state, outbound, inbound });
    await save();
  }
  async function ensureTree() {
    if (!state.rootId) await rebuildMaps();
    if (!state.pinnedId) {
      state.pinnedId = await ensurePinnedFolder(api, state.rootId);
      await save();
      for (const tab of await api.tabs.query({ pinned: true })) if (!tab.incognito) await outbound.syncTab(tab.id);
      await inbound.reconcileFolder(state.pinnedId);
    }
  }
  function start() {
    if (!starting) {
      starting = queue.run(async () => {
        state = await loadState(api);
        const session = await api.storage.session.get("foxySession");
        if (!session.foxySession) {
          await settle(api, { settleMs, maxWaitMs, now });
          await rebuildMaps();
          await api.storage.session.set({ foxySession: true });
        }
        await normalWindow();
        // Once per event-page lifetime; queue-owned timers cover later deadlines.
        await ensureTree();
        for (const id of Object.keys(state.groups)) scheduleReturningGroup(Number(id));
        await flush();
      }).catch(error => { starting = undefined; throw error; });
    }
    return starting;
  }
  async function run(fn) {
    await start();
    return queue.run(fn);
  }
  async function getNode(id) {
    try { return (await api.bookmarks.get(id))[0]; }
    catch (error) {
      if (/^(?:Bookmark not found[.!]?$|Invalid bookmark ID:)/i.test(error?.message ?? "")) return null;
      throw error;
    }
  }
  async function relevant(id, parentId) {
    if (id === state.rootId || id === state.pinnedId || groupOfFolder(state, id) !== null) return true;
    if (parentId === state.rootId) return true;
    const parent = parentId ? await getNode(parentId) : null;
    return parent?.type === "folder" && parent.parentId === state.rootId;
  }
  async function folderRemoved(id) {
    const root = id === state.rootId, pinned = id === state.pinnedId;
    await inbound.folderRemoved(id);
    let cleaned = false;
    for (const [tabId, removal] of Object.entries(state.pendingRemovals)) {
      if (removal.folderId === id) { delete state.pendingRemovals[tabId]; cleaned = true; }
    }
    if (pinned) state.pinnedId = null;
    if (pinned || cleaned) await save();
    if (root || pinned) await ensureTree();
  }
  async function managedGroup(groupId) {
    const folderId = state.groups[groupId]?.folderId;
    if (!folderId) return true;
    const node = await getNode(folderId);
    if (node?.parentId === state.rootId) return true;
    await folderRemoved(folderId);
    return false;
  }
  async function syncGroup(groupId, finishingReturn = false) {
    let group;
    try { group = await api.tabGroups.get(groupId); } catch { return false; }
    let win;
    try { win = await api.windows.get(group.windowId); }
    catch (error) { console.warn("Foxy: group window is unavailable", error); return false; }
    if (win.incognito || !await managedGroup(groupId)) return false;
    if (!state.groups[groupId]) {
      const local = (await api.tabs.query({ groupId })).filter(tab => !tab.incognito && !tab.pinned
        && isSyncableUrl(tab.url, api.runtime.getURL(""))).sort((a, b) => a.index - b.index);
      if (!local.length) return false; // Restore can announce a group before its real tabs.
      const candidates = new Set([...state.missing, ...state.openFolders]
        .filter(id => groupOfFolder(state, id) === null));
      {
        const tree = await readTree(api, state.rootId), urls = local.map(tab => tab.url);
        const counts = new Map();
        for (const url of urls) counts.set(url, (counts.get(url) ?? 0) + 1);
        const folders = tree.folders.filter(folder => {
          if (groupOfFolder(state, folder.id) !== null) return false;
          if (candidates.has(folder.id)) return folder.bookmarks.some(bookmark => counts.has(bookmark.url));
          // Firefox's saved-group reopen is not marked missing/open here. Only
          // an exact openable URL multiset plus name/colour is safe at runtime.
          const openable = folder.bookmarks.filter(bookmark => isOpenableUrl(bookmark.url));
          if (openable.length !== urls.length) return false;
          const remaining = new Map(counts);
          for (const bookmark of openable) {
            const count = remaining.get(bookmark.url) ?? 0;
            if (!count) return false;
            remaining.set(bookmark.url, count - 1);
          }
          return true;
        });
        const [pair] = matchGroups([{ groupId, title: group.title, color: group.color, urls: [...urls] }], folders).pairs;
        if (pair) {
          const folder = folders.find(folder => folder.id === pair.folderId);
          // Old window ids must not win inbound's bookmark-id lookup after History restore.
          for (const [id, entry] of Object.entries(state.tabs)) if (entry.folderId === folder.id) {
            delete state.tabs[id];
            delete state.pendingRemovals[id];
            delete state.quietUntil[id];
            delete state.failedCreates[id];
          }
          const boundAt = now(), rebindMaxUntil = boundAt + maxWaitMs;
          state.groups[groupId] = { folderId: folder.id, title: encodeFolderTitle(group),
            rebindUntil: Math.min(boundAt + (quietMs ?? 10000), rebindMaxUntil), rebindMaxUntil,
            rebindTabIds: local.map(tab => tab.id) };
          if (!state.openFolders.includes(folder.id)) state.openFolders.push(folder.id);
          state.missing = state.missing.filter(id => id !== folder.id);
          const tabs = matchTabs(local.map(tab => ({ tabId: tab.id, url: tab.url })), folder.bookmarks);
          for (const pair of tabs.pairs) {
            const tab = local.find(tab => tab.id === pair.tabId);
            state.tabs[tab.id] = { bookmarkId: pair.bookmarkId, folderId: folder.id,
              url: tab.url, title: tab.title ?? "" };
          }
          await save();
          for (const id of tabs.unmatchedTabs) await outbound.syncTab(id);
          scheduleReturningGroup(groupId);
        }
      }
    }
    if (Number.isFinite(state.groups[groupId]?.rebindUntil)) {
      const membershipChanged = await matchReturningTabs(groupId);
      if (!finishingReturn && membershipChanged) {
        const entry = state.groups[groupId];
        // Older stored deadlines did not include a cap. Never extend them.
        entry.rebindUntil = Math.min(now() + (quietMs ?? 10000), entry.rebindMaxUntil ?? entry.rebindUntil);
        await save();
        scheduleReturningGroup(groupId);
      }
    }
    await outbound.syncGroup(groupId);
    return true;
  }
  async function matchReturningTabs(groupId) {
    const entry = state.groups[groupId];
    if (!entry) return;
    const local = (await api.tabs.query({ groupId })).filter(tab => !tab.incognito && !tab.pinned
      && !state.tabs[tab.id] && isSyncableUrl(tab.url, api.runtime.getURL(""))).sort((a, b) => a.index - b.index);
    const seen = new Set(entry.rebindTabIds ?? []);
    const arrived = local.some(tab => !seen.has(tab.id));
    if (arrived) entry.rebindTabIds = [...seen, ...local.filter(tab => !seen.has(tab.id)).map(tab => tab.id)];
    const mapped = new Set(Object.values(state.tabs).map(tab => tab.bookmarkId));
    const bookmarks = (await api.bookmarks.getChildren(entry.folderId)).filter(node => node.type === "bookmark" && !mapped.has(node.id));
    const tabs = matchTabs(local.map(tab => ({ tabId: tab.id, url: tab.url })), bookmarks);
    for (const pair of tabs.pairs) {
      const tab = local.find(tab => tab.id === pair.tabId);
      state.tabs[tab.id] = { bookmarkId: pair.bookmarkId, folderId: entry.folderId,
        url: tab.url, title: tab.title ?? "" };
    }
    if (tabs.pairs.length || arrived) await save();
    return arrived || tabs.pairs.length > 0;
  }
  function scheduleReturningGroup(groupId) {
    clearTimeout(returnTimers.get(groupId));
    returnTimers.delete(groupId);
    const entry = state.groups[groupId];
    if (!Number.isFinite(entry?.rebindUntil)) return;
    returnTimers.set(groupId, setTimeout(() => {
      returnTimers.delete(groupId);
      queue.run(async () => {
        const entry = state.groups[groupId];
        if (!Number.isFinite(entry?.rebindUntil)) return;
        if (entry.rebindUntil > now()) { scheduleReturningGroup(groupId); return; }
        // The group may have moved into a private window or its folder may
        // have left Foxy while the timer waited. Use the same controller guards.
        const managed = await syncGroup(groupId, true);
        delete entry.rebindUntil;
        delete entry.rebindMaxUntil;
        delete entry.rebindTabIds;
        await save();
        if (!managed) return;
        await inbound.reconcileFolder(entry.folderId, !!entry.pendingOrder);
        // Tabs can arrive without a delivered event before quiet completes.
        // A safety-blocked order remains pending and cannot be published back.
        for (const tab of await api.tabs.query({ groupId })) await syncTab(tab.id);
      }).catch(() => {});
    }, Math.max(0, entry.rebindUntil - now())));
  }
  async function syncTab(tabId) {
    let tab;
    try { tab = await api.tabs.get(tabId); }
    catch { return outbound.syncTab(tabId); } // Outbound owns missing-tab reads/logging.
    if (tab.incognito) return;
    if (!tab.pinned && tab.groupId != null && tab.groupId !== -1) {
      // Prevent outbound's internal group creation from bypassing return matching.
      if (!await syncGroup(tab.groupId)) {
        if (state.tabs[tabId] && !state.groups[tab.groupId]
          && !isSyncableUrl(tab.url, api.runtime.getURL(""))) await outbound.syncTab(tabId);
        return;
      }
      if (state.groups[tab.groupId]?.pendingOrder) return;
    }
    await outbound.syncTab(tabId);
  }
  function syncMovedTab(tabId) {
    movedTabs.add(tabId);
    if (moveTimer === undefined) moveTimer = setTimeout(() => queue.run(flushMovedTabs).catch(() => {}), 0);
  }
  async function flushMovedTabs() {
    clearTimeout(moveTimer);
    moveTimer = undefined;
    const ids = [...movedTabs], strips = new Map();
    movedTabs.clear();
    for (const id of ids) {
      let tab;
      try { tab = await api.tabs.get(id); } catch { continue; }
      if (tab.incognito) continue;
      if (!tab.pinned && (tab.groupId == null || tab.groupId === -1)) {
        try { await syncTab(id); }
        catch (error) { console.warn("Foxy: moved-tab sync failed", error); }
        continue;
      }
      strips.set(`${tab.windowId}:${tab.pinned ? "pinned" : tab.groupId}`, { windowId: tab.windowId,
        ...(tab.pinned ? { pinned: true } : { groupId: tab.groupId }) });
    }
    // A multi-drag can invert several neighbours before any event runs. One
    // final strip-order pass per batch publishes all shifted members' deltas.
    for (const query of strips.values()) {
      try {
        const members = await api.tabs.query(query);
        for (const member of members.sort((a, b) => a.index - b.index)) await syncTab(member.id);
      } catch (error) { console.warn("Foxy: moved-tab strip sync failed", error); }
    }
  }
  async function flush() {
    for (const folderId of new Set(Object.values(state.pendingRemovals).map(removal => removal.folderId))) {
      const groupId = groupOfFolder(state, folderId);
      if (groupId !== null) await managedGroup(groupId);
    }
    await outbound.flush();
  }
  async function applyDeferred() {
    // A moved-out folder still exists, but must retry the same removal action
    // after the shown-tab guard releases. The folder id itself is durable.
    for (const id of [...state.deferred]) {
      const node = await getNode(id);
      if (node?.type === "folder" && node.parentId !== state.rootId) await folderRemoved(id);
    }
    await inbound.applyDeferred();
  }
  async function remapMergedTabs(folderId, query) {
    const nodes = (await api.bookmarks.getChildren(folderId)).filter(node => node.type === "bookmark");
    const canonical = new Set(nodes.map(node => node.id)), returning = [];
    for (const tab of await api.tabs.query(query)) {
      const entry = state.tabs[tab.id];
      if (tab.incognito || !entry) continue;
      if (canonical.has(entry.bookmarkId)) {
        entry.folderId = folderId; // The bookmark moved, retaining its GUID.
        if (state.pendingRemovals[tab.id]) state.pendingRemovals[tab.id].folderId = folderId;
      } else {
        returning.push({ tabId: tab.id, url: tab.url });
      }
    }
    const mapped = new Set(Object.values(state.tabs).map(entry => entry.bookmarkId));
    const matches = matchTabs(returning, nodes.filter(node => !mapped.has(node.id)));
    for (const { tabId, bookmarkId } of matches.pairs) {
      Object.assign(state.tabs[tabId], { bookmarkId, folderId });
      if (state.pendingRemovals[tabId]) Object.assign(state.pendingRemovals[tabId], { bookmarkId, folderId });
    }
  }
  async function changed(id, node) {
    if (node?.type === "folder" && ((id !== state.rootId && node.parentId === OTHER_BOOKMARKS && node.title === ROOT_TITLE)
      || (id !== state.pinnedId && node.parentId === state.rootId && isPinnedFolderTitle(node.title)))) {
      Object.assign(state, await mergeRoots(api, state.rootId));
      // A same-URL bookmark retained in an extra folder did not move. Bind
      // its live tab to an unused canonical counterpart before reconciling.
      // Startup rebuild already matches the merged folders from scratch.
      await remapMergedTabs(state.pinnedId, { pinned: true });
      for (const [groupId, entry] of Object.entries(state.groups)) {
        await remapMergedTabs(entry.folderId, { groupId: Number(groupId) });
      }
      await save();
      await inbound.reconcileFolder(state.pinnedId);
    }
    if (!node || !await relevant(id, node.parentId)) return;
    if (node.type === "folder") {
      if (id !== state.rootId) await inbound.reconcileFolder(id);
    } else {
      await inbound.reconcileFolder(node.parentId);
    }
  }
  const jobs = {
    "runtime.onStartup": async () => {},
    "runtime.onInstalled": async () => {},
    "tabs.onCreated": tab => syncTab(tab.id),
    "tabs.onUpdated": syncTab,
    "tabs.onRemoved": async (id, info) => {
      // A normal mapped group can subsequently move into a private window.
      // Its private close is not evidence for deleting a shared bookmark.
      let win;
      try { win = await api.windows.get(info.windowId); } catch { /* Window already closed. */ }
      if (!win?.incognito) outbound.tabRemoved(id, info);
    },
    "tabs.onMoved": syncMovedTab,
    "tabs.onAttached": syncTab,
    "tabs.onDetached": syncTab,
    "tabs.onActivated": applyDeferred,
    "tabGroups.onCreated": group => syncGroup(group.id),
    "tabGroups.onUpdated": group => syncGroup(group.id),
    "tabGroups.onRemoved": (group, info) => outbound.groupRemoved(group, info),
    "tabGroups.onMoved": async group => {
      await syncGroup(group.id);
      for (const tab of await api.tabs.query({ groupId: group.id })) await syncTab(tab.id);
    },
    "bookmarks.onCreated": (id, node) => changed(id, node),
    "bookmarks.onChanged": async id => changed(id, await getNode(id)),
    "bookmarks.onRemoved": async (id, info) => {
      if (!await relevant(id, info.parentId)) return;
      if (info.node?.type === "folder") await folderRemoved(id);
      else await inbound.reconcileFolder(info.parentId);
    },
    "bookmarks.onMoved": async (id, info) => {
      const node = await getNode(id);
      if (!node) return;
      if (node.type === "folder") {
        if (info.oldParentId === state.rootId && info.parentId !== state.rootId) await folderRemoved(id);
        else if (await relevant(id, info.parentId)) await changed(id, node);
      } else if (await relevant(id, info.parentId) || await relevant(id, info.oldParentId)) {
        await inbound.bookmarkMoved(id, info);
      }
    },
    "windows.onFocusChanged": async id => {
      if (id === api.windows.WINDOW_ID_NONE) return;
      try {
        const win = await api.windows.get(id);
        if (eligibleWindow(win)) await rememberNormalWindow(win);
      } catch (error) { console.warn("Foxy: focused window is unavailable", error); return; }
      await applyDeferred();
    },
  };
  const handlers = Object.fromEntries(Object.entries(jobs).map(([name, fn]) => [name, (...args) => run(() => fn(...args))]));

  async function saved() {
    const tree = await readTree(api, state.rootId);
    const closed = tree.folders.filter(folder => groupOfFolder(state, folder.id) === null);
    return {
      saved: closed.map(folder => ({ folderId: folder.id, title: folder.name, color: folder.color,
        count: folder.bookmarks.length,
        cantReopen: [...new Set(folder.bookmarks.filter(bookmark => !isOpenableUrl(bookmark.url)).map(bookmark => bookmark.url))],
      })),
      missing: closed.filter(folder => state.missing.includes(folder.id))
        .map(folder => ({ folderId: folder.id, title: folder.name, color: folder.color })),
    };
  }
  async function groupFolder(folderId) {
    const tree = await readTree(api, state.rootId);
    return tree.folders.find(folder => folder.id === folderId);
  }
  async function openSaved(folderId, windowId) {
    const folder = await groupFolder(folderId);
    if (!folder) return { ok: false };
    const mapped = groupOfFolder(state, folderId);
    if (mapped !== null) return { ok: true, groupId: mapped };
    const bookmarks = folder.bookmarks.filter(bookmark => isOpenableUrl(bookmark.url));
    if (!bookmarks.length) return { ok: false };
    const win = await normalWindow(windowId);
    if (!win) return { ok: false };
    windowId = win.id;
    const created = [];
    let groupId;
    try {
      for (const bookmark of bookmarks) {
        const tab = await api.tabs.create({ windowId, url: bookmark.url, title: bookmark.title,
          discarded: true, active: false });
        created.push({ tab, bookmark });
      }
      groupId = await api.tabs.group({ tabIds: created.map(({ tab }) => tab.id), createProperties: { windowId } });
      await api.tabGroups.update(groupId, { title: folder.name, color: folder.color });
    } catch (error) {
      // No mappings yet, so cleanup events cannot delete shared bookmarks.
      for (const { tab } of created) {
        try {
          const live = await api.tabs.get(tab.id);
          if (!await inbound.isShown(live)) await api.tabs.remove(tab.id);
        } catch (cleanupError) { console.warn("Foxy: could not clean up saved-group open", cleanupError); }
      }
      throw error;
    }
    state.groups[groupId] = { folderId, title: encodeFolderTitle({ title: folder.name, color: folder.color }) };
    for (const { tab, bookmark } of created) {
      state.tabs[tab.id] = { bookmarkId: bookmark.id, folderId, url: tab.url, title: tab.title ?? "" };
      state.quietUntil[tab.id] = now() + (quietMs ?? 10000);
    }
    if (!state.openFolders.includes(folderId)) state.openFolders.push(folderId);
    state.missing = state.missing.filter(id => id !== folderId);
    await save();
    return { ok: true, groupId };
  }
  /**
   * Page protocol (foxy:* replies can wait up to maxWaitMs at session start):
   * - foxy:saved -> { saved: [{ folderId, title, color, count, cantReopen }],
   *                   missing: [{ folderId, title, color }] }
   * - foxy:open-saved { folderId, windowId } -> { ok: true, groupId } on success
   * - foxy:delete-saved { folderId } -> { ok }
   * - foxy:restore-all { windowId } -> { ok } (continue after individual failures)
   * - foxy:dismiss-missing -> { ok }
   * - foxy:reconcile -> { ok }
   * Failures reply { ok: false }; unknown types are ignored. Non-foxy messages
   * go immediately to the existing trusted close helper, outside the queue.
   */
  async function onMessage(message, sender) {
    if (typeof message?.type !== "string" || !message.type.startsWith("foxy:")) {
      return handleMessage(api, message, sender);
    }
    return run(async () => {
      switch (message?.type) {
        case "foxy:saved": return saved();
        case "foxy:open-saved": return openSaved(message.folderId, message.windowId);
        case "foxy:delete-saved": {
          if (groupOfFolder(state, message.folderId) !== null || !await groupFolder(message.folderId)) return { ok: false };
          await api.bookmarks.removeTree(message.folderId);
          await folderRemoved(message.folderId);
          return { ok: true };
        }
        case "foxy:restore-all": {
          let ok = true;
          for (const id of [...state.missing]) {
            try {
              const result = await openSaved(id, message.windowId); // Inner function, never this queue.
              if (!result.ok) ok = false;
            } catch (error) {
              console.warn("Foxy: saved-group restore failed", error);
              ok = false;
            }
          }
          // openSaved removes only successfully opened folders from missing.
          await save();
          return { ok };
        }
        case "foxy:dismiss-missing": state.missing = []; await save(); return { ok: true };
        case "foxy:reconcile": await inbound.reconcileAll(); return { ok: true };
        default: return undefined;
      }
    }).catch(() => ({ ok: false })); // The queue logs failures and keeps draining.
  }
  async function idle() {
    await queue.idle();
    if (movedTabs.size) await queue.run(flushMovedTabs);
    await queue.idle();
  }
  return { start, handlers, onMessage, idle };
}
