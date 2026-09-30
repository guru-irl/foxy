import { encodeFolderTitle, isSyncableUrl } from "./codec.js";
import { folderOfGroup, groupOfFolder } from "./state.js";

/**
 * Call every method through the controller's serial queue, including flush().
 * Removal deadlines are drained by flush, not by an out-of-queue timer. The
 * controller schedules that drain after removeDelayMs. Inbound owns quietUntil
 * (and uses quietMs when it navigates or creates a tab).
 */
export function createOutbound({
  api, getState, save, now = Date.now, removeDelayMs = 2000, quietMs = 10000, extensionBaseUrl,
}) {
  const pending = new Map();
  const warn = error => console.warn("Foxy: outbound sync failed", error);
  const guarded = fn => async (...args) => {
    try { await fn(...args); } catch (error) { warn(error); }
  };
  async function read(fn) {
    try { return await fn(); } catch (error) { warn(error); return null; }
  }

  function scheduleRemoval(tabId) {
    const entry = getState().tabs[tabId];
    if (!entry || pending.has(tabId)) return;
    pending.set(tabId, { bookmarkId: entry.bookmarkId, folderId: entry.folderId, due: now() + removeDelayMs });
  }

  // Query current positions, never the numeric-key order of state.tabs.
  async function position(tab, folderId, bookmark) {
    const state = getState();
    const earlier = (await api.tabs.query({ windowId: tab.windowId,
      ...(tab.pinned ? { pinned: true } : { groupId: tab.groupId }) }))
      .filter(other => other.index < tab.index && state.tabs[other.id]?.folderId === folderId)
      .sort((a, b) => b.index - a.index);
    for (const other of earlier) {
      const nodes = await read(() => api.bookmarks.get(state.tabs[other.id].bookmarkId));
      const previous = nodes?.[0];
      if (!previous || previous.parentId !== folderId) continue;
      // Firefox move() interprets index AFTER removing the moving bookmark.
      return previous.index + 1 - Number(bookmark?.parentId === folderId && bookmark.index < previous.index);
    }
    return 0;
  }

  const syncTab = guarded(async tabId => {
    const tab = await read(() => api.tabs.get(tabId));
    if (!tab) return;
    let state = getState();
    let folderId = tab.pinned ? state.pinnedId : folderOfGroup(state, tab.groupId);
    if (!tab.pinned && tab.groupId != null && tab.groupId !== -1 && !folderId) {
      await syncGroup(tab.groupId);
      state = getState();
      folderId = folderOfGroup(state, tab.groupId);
    }
    if (!folderId || !isSyncableUrl(tab.url, extensionBaseUrl)) {
      scheduleRemoval(tabId);
      return;
    }
    pending.delete(tabId);
    const entry = state.tabs[tabId];
    const nodes = entry ? await read(() => api.bookmarks.get(entry.bookmarkId)) : null;
    const bookmark = nodes?.[0];
    if (entry && !bookmark) return; // A remote deletion belongs to inbound.
    const index = await position(tab, folderId, bookmark);
    const title = tab.title ?? "";
    if (!entry) {
      const created = await api.bookmarks.create({ parentId: folderId, index, url: tab.url, title });
      state.tabs[tabId] = { bookmarkId: created.id, folderId, url: tab.url, title };
      await save();
      return;
    }
    if (bookmark.parentId !== folderId || bookmark.index !== index) {
      await api.bookmarks.move(entry.bookmarkId, { parentId: folderId, index });
    }
    if (entry.folderId !== folderId) {
      entry.folderId = folderId;
      await save();
    }
    // Compare direction against lastSynced, not against the live bookmark.
    // If the actual bookmark already matches, advance bookkeeping without an echo.
    if (tab.status === "complete" && tab.url !== entry.url && !(state.quietUntil[tabId] > now())) {
      if (bookmark.url !== tab.url || bookmark.title !== title) {
        await api.bookmarks.update(entry.bookmarkId, { url: tab.url, title });
      }
      entry.url = tab.url;
      entry.title = title;
      await save();
    } else if (tab.status === "complete" && tab.url === entry.url && title !== entry.title) {
      if (bookmark.title !== title) await api.bookmarks.update(entry.bookmarkId, { title });
      entry.title = title;
      await save();
    }
  });

  const syncGroup = guarded(async groupId => {
    const group = await read(() => api.tabGroups.get(groupId));
    if (!group) return;
    const state = getState(), title = encodeFolderTitle(group), entry = state.groups[groupId];
    if (entry) {
      if (title !== entry.title) {
        const nodes = await read(() => api.bookmarks.get(entry.folderId));
        if (!nodes?.[0]) return;
        if (nodes[0].title !== title) await api.bookmarks.update(entry.folderId, { title });
        entry.title = title;
        await save();
      }
      return;
    }
    const created = await api.bookmarks.create({ parentId: state.rootId, title });
    state.groups[groupId] = { folderId: created.id, title };
    if (!state.openFolders.includes(created.id)) state.openFolders.push(created.id);
    await save();
    const members = await api.tabs.query({ windowId: group.windowId, groupId });
    for (const tab of members.sort((a, b) => a.index - b.index)) await syncTab(tab.id);
  });

  function tabRemoved(tabId, removeInfo = {}) {
    if (removeInfo.isWindowClosing) {
      pending.delete(tabId);
      return;
    }
    scheduleRemoval(tabId);
  }

  const groupRemoved = guarded(async (group, removeInfo = {}) => {
    const state = getState(), entry = state.groups[group.id];
    if (!entry) return;
    delete state.groups[group.id];
    if (!removeInfo.isWindowClosing) {
      state.openFolders = state.openFolders.filter(id => id !== entry.folderId);
    }
    await save();
  });

  const flush = guarded(async () => {
    for (const [tabId, removal] of pending) {
      if (removal.due > now()) continue;
      // A failed write stays pending for the next queue-owned drain.
      await guarded(async () => {
        const state = getState(), entry = state.tabs[tabId];
        if (!entry || entry.bookmarkId !== removal.bookmarkId || entry.folderId !== removal.folderId) {
          pending.delete(tabId);
          return;
        }
        const groupId = groupOfFolder(state, entry.folderId);
        const live = entry.folderId === state.pinnedId || (groupId !== null
          && await read(() => api.tabGroups.get(groupId)));
        if (live) {
          const nodes = await read(() => api.bookmarks.get(entry.bookmarkId));
          if (nodes?.[0]) await api.bookmarks.remove(entry.bookmarkId);
        }
        delete state.tabs[tabId];
        pending.delete(tabId);
        await save();
      })();
    }
  });

  return { syncTab, syncGroup, tabRemoved, groupRemoved, flush };
}
