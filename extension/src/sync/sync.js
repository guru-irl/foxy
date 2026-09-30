import { handleMessage } from "../close.js";
import { isOpenableUrl, encodeFolderTitle } from "./codec.js";
import { createQueue, loadState, saveState, groupOfFolder } from "./state.js";
import { ensurePinnedFolder, readTree } from "./tree.js";
import { createOutbound } from "./outbound.js";
import { createInbound } from "./inbound.js";
import { settle, rebuild } from "./startup.js";

/** One controller per event-page lifetime. Only storage.session marks a browser session. */
export function createSync({ api, now = Date.now, removeDelayMs, quietMs,
  settleMs = 3000, maxWaitMs = 20000 }) {
  const queue = createQueue();
  let state, starting;
  const save = () => saveState(api, state);
  const outbound = createOutbound({ api, getState: () => state, save, now, removeDelayMs, quietMs,
    extensionBaseUrl: api.runtime.getURL(""),
    schedule: ms => setTimeout(() => queue.run(flush).catch(() => {}), ms),
  });
  // Losing OS focus doesn't stop showing the last Firefox window's active tab.
  // Keep this adapter local to sync; never mutate the injected browser object.
  const inboundApi = { ...api, bookmarks: { ...api.bookmarks,
    async get(ids) {
      const nodes = await api.bookmarks.get(ids);
      for (const node of nodes) {
        if (node.type === "folder" && groupOfFolder(state, node.id) !== null && node.parentId !== state.rootId) {
          // A safety-blocked removal keeps its mapping until the shown tab is
          // released. Do not import changes from that now-unmanaged folder.
          throw new Error(`Invalid bookmark ID: ${node.id}`);
        }
      }
      return nodes;
    },
  }, windows: { ...api.windows,
    async getLastFocused(options) {
      const win = await api.windows.getLastFocused(options);
      return { ...win, focused: true };
    },
  } };
  const inbound = createInbound({ api: inboundApi, getState: () => state, save, now, quietMs });

  async function rebuildMaps() {
    await rebuild({ api, state, outbound, inbound });
    await save();
  }
  async function ensureTree() {
    if (!state.rootId) await rebuildMaps();
    if (!state.pinnedId) {
      state.pinnedId = await ensurePinnedFolder(api, state.rootId);
      await save();
      for (const tab of await api.tabs.query({ pinned: true })) await outbound.syncTab(tab.id);
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
      }).catch(error => { starting = undefined; throw error; });
    }
    // Every wake drains durable removal deadlines, not just browser startup.
    return starting.then(() => queue.run(async () => {
      await ensureTree();
      await flush();
    }));
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
  async function syncGroup(groupId) {
    if (await managedGroup(groupId)) await outbound.syncGroup(groupId);
  }
  async function syncTab(tabId) {
    let tab;
    try { tab = await api.tabs.get(tabId); }
    catch { return outbound.syncTab(tabId); } // Outbound owns missing-tab reads/logging.
    if (tab.pinned || await managedGroup(tab.groupId)) await outbound.syncTab(tabId);
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
  async function changed(id, node) {
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
    "tabs.onRemoved": (id, info) => outbound.tabRemoved(id, info),
    "tabs.onMoved": syncTab,
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
      if (id !== api.windows.WINDOW_ID_NONE) await applyDeferred();
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
  async function onMessage(message, sender) {
    if (typeof message?.type !== "string" || !message.type.startsWith("foxy:")) {
      await start();
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
            const result = await openSaved(id, message.windowId); // Inner function, never this queue.
            if (!result.ok) ok = false;
          }
          state.missing = [];
          await save();
          return { ok };
        }
        case "foxy:dismiss-missing": state.missing = []; await save(); return { ok: true };
        case "foxy:reconcile": await inbound.reconcileAll(); return { ok: true };
        default: return undefined;
      }
    });
  }
  return { start, handlers, onMessage, idle: () => queue.idle() };
}
