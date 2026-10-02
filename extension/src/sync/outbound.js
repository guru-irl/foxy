import { encodeFolderTitle, decodeFolderTitle, decodePinTitle, encodePageTitle, isSyncableUrl } from "./codec.js";
import { folderOfGroup, groupOfFolder, probeMissingBookmark, wasRemoved } from "./state.js";

/**
 * Call every method through the controller's serial queue, including flush().
 * Removal deadlines are drained by flush, not by an out-of-queue timer. The
 * schedule(delayMs) asks the controller to enqueue that drain, without awaiting
 * the controller's queue from inside a job. Inbound owns quietUntil
 * (and uses quietMs when it navigates or creates a tab).
 */
export function createOutbound({
  api, getState, save, now = Date.now, removeDelayMs = 2000, quietMs = 10000, extensionBaseUrl,
  schedule = () => {}, lostIdentity = () => {},
}) {
  const warn = error => console.warn("Foxy: outbound sync failed", error);
  const guarded = fn => async (...args) => {
    try { await fn(...args); } catch (error) {
      if (error?.foxyMissingId) console.debug("Foxy: outbound identity unavailable", error);
      else warn(error);
    }
  };
  async function read(fn) {
    // Tabs, groups and bookmarks may disappear between queued events.
    try { return await fn(); }
    catch (error) { console.debug("Foxy: outbound read skipped", error); return null; }
  }

  async function bookmarkCall(ids, fn) {
    try { return await fn(); }
    catch (error) {
      for (const id of ids) {
        if (!await probeMissingBookmark(api, id)) continue;
        if (!wasRemoved(getState(), id, now())) lostIdentity(id);
        const missing = new Error("Foxy: outbound identity unavailable", { cause: error });
        missing.foxyMissingId = id;
        throw missing;
      }
      throw error;
    }
  }
  async function readBookmark(id) {
    try { return await bookmarkCall([id], () => api.bookmarks.get(id)); }
    catch (error) {
      if (error?.foxyMissingId) {
        if (wasRemoved(getState(), id, now())) return null;
        throw error; // Abort neighbour/create paths too.
      }
      console.debug("Foxy: outbound read skipped", error); return null;
    }
  }

  function scheduleRemoval(tabId) {
    const state = getState(), entry = state.tabs[tabId], pending = state.pendingRemovals[tabId];
    if (!entry || (pending?.bookmarkId === entry.bookmarkId && pending.folderId === entry.folderId)) return;
    state.pendingRemovals[tabId] = { bookmarkId: entry.bookmarkId, folderId: entry.folderId, due: now() + removeDelayMs };
    const saved = save();
    try { schedule(removeDelayMs); } catch (error) { warn(error); }
    return saved;
  }

  function cancelRemoval(tabId) {
    const state = getState();
    if (!state.pendingRemovals[tabId]) return;
    delete state.pendingRemovals[tabId];
    return save();
  }

  // Query current positions, never the numeric-key order of state.tabs.
  async function position(tab, folderId, bookmark) {
    const state = getState();
    const members = (await api.tabs.query({ windowId: tab.windowId,
      ...(tab.pinned ? { pinned: true } : { groupId: tab.groupId }) }))
      .filter(other => other.id !== tab.id && state.tabs[other.id]?.folderId === folderId);
    async function neighbour(candidates) {
      for (const other of candidates) {
        const nodes = await readBookmark(state.tabs[other.id].bookmarkId);
        if (nodes?.[0]?.parentId === folderId) return nodes[0];
      }
      return null;
    }
    const previous = await neighbour(members.filter(other => other.index < tab.index).sort((a, b) => b.index - a.index));
    const next = await neighbour(members.filter(other => other.index > tab.index).sort((a, b) => a.index - b.index));
    if (bookmark?.parentId === folderId) {
      // No position satisfies inverted neighbours. Follow the earlier tab's bookmark.
      if (previous && next && previous.index > next.index) return bookmark.index < previous.index ? previous.index : previous.index + 1;
      // Firefox move() interprets index AFTER removing the moving bookmark.
      if (previous && bookmark.index < previous.index) return previous.index;
      if (next && bookmark.index > next.index) return next.index;
      // Unmapped bookmarks and other windows' pins may stay between neighbours.
      return bookmark.index;
    }
    if (previous) return previous.index + 1;
    if (next) return next.index;
    return tab.pinned ? (await bookmarkCall([folderId], () => api.bookmarks.getChildren(folderId))).length : 0;
  }

  const syncTab = guarded(async tabId => {
    const tab = await read(() => api.tabs.get(tabId));
    if (!tab) return;
    let state = getState();
    if (state.failedCreates[tabId] !== undefined && state.failedCreates[tabId] !== tab.url) {
      delete state.failedCreates[tabId];
      await save();
    }
    let folderId = tab.pinned ? state.pinnedId : folderOfGroup(state, tab.groupId);
    if (!tab.pinned && tab.groupId != null && tab.groupId !== -1 && !folderId
      && isSyncableUrl(tab.url, extensionBaseUrl)) {
      await syncGroup(tab.groupId);
      state = getState();
      folderId = folderOfGroup(state, tab.groupId);
    }
    const entry = state.tabs[tabId];
    if (!folderId || !isSyncableUrl(tab.url, extensionBaseUrl)) {
      if (folderId && entry?.folderId === folderId) await cancelRemoval(tabId);
      else await scheduleRemoval(tabId);
      return;
    }
    await cancelRemoval(tabId);
    const nodes = entry ? await readBookmark(entry.bookmarkId) : null;
    const bookmark = nodes?.[0];
    if (entry && !bookmark) return; // A remote deletion belongs to inbound.
    if (!entry && state.failedCreates[tabId] === tab.url) return;
    const index = await position(tab, folderId, bookmark);
    const title = tab.title ?? "";
    const bookmarkTitle = encodePageTitle(title);
    if (!entry) {
      if (!(await readBookmark(folderId))?.[0]) return;
      let created;
      try { created = await bookmarkCall([folderId], () => api.bookmarks.create({ parentId: folderId, index, url: tab.url, title: bookmarkTitle })); }
      catch (error) {
        if (error?.foxyMissingId) throw error;
        state.failedCreates[tabId] = tab.url;
        warn(error);
        await save();
        return;
      }
      state.tabs[tabId] = { bookmarkId: created.id, folderId, url: tab.url, title };
      await save();
      return;
    }
    if (bookmark.parentId !== folderId || bookmark.index !== index) {
      const at = now();
      if (!state.expectedMoves || typeof state.expectedMoves !== "object" || Array.isArray(state.expectedMoves)) {
        state.expectedMoves = {};
      }
      const expected = state.expectedMoves;
      for (const [id, moves] of Object.entries(expected)) {
        const fresh = Array.isArray(moves) ? moves.filter(move => move && move.at <= at && at - move.at <= 60000) : [];
        if (fresh.length) expected[id] = fresh;
        else delete expected[id];
      }
      const record = { parentId: folderId, index, at };
      const moves = expected[entry.bookmarkId] = [...(expected[entry.bookmarkId] ?? []), record].slice(-8);
      await save();
      try { await bookmarkCall([entry.bookmarkId, folderId], () => api.bookmarks.move(entry.bookmarkId, { parentId: folderId, index })); }
      catch (error) {
        const remaining = moves.filter(move => move !== record);
        if (remaining.length) expected[entry.bookmarkId] = remaining;
        else delete expected[entry.bookmarkId];
        await save();
        throw error;
      }
    }
    if (entry.folderId !== folderId) {
      entry.folderId = folderId;
      await save();
    }
    const named = tab.pinned && folderId === state.pinnedId && decodePinTitle(bookmark.title) !== null;
    // Compare direction against lastSynced, not against the live bookmark.
    // If the actual bookmark already matches, advance bookkeeping without an echo.
    if (tab.status === "complete" && tab.url !== entry.url && !(state.quietUntil[tabId] > now())) {
      if (bookmark.url !== tab.url || (!named && bookmark.title !== bookmarkTitle)) {
        await bookmarkCall([entry.bookmarkId], () => api.bookmarks.update(entry.bookmarkId,
          named ? { url: tab.url } : { url: tab.url, title: bookmarkTitle }));
      }
      entry.url = tab.url;
      if (!named) entry.title = title;
      await save();
    } else if (!named && tab.status === "complete" && tab.url === entry.url && title !== entry.title) {
      if (bookmark.title !== bookmarkTitle) await bookmarkCall([entry.bookmarkId], () => api.bookmarks.update(entry.bookmarkId, { title: bookmarkTitle }));
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
        const nodes = await readBookmark(entry.folderId);
        if (!nodes?.[0]) return;
        if (nodes[0].title !== title) await bookmarkCall([entry.folderId], () => api.bookmarks.update(entry.folderId, { title }));
        entry.title = title;
        await save();
      }
      return;
    }
    if (!(await readBookmark(state.rootId))?.[0]) return;
    const created = await bookmarkCall([state.rootId], () => api.bookmarks.create({ parentId: state.rootId, title }));
    state.groups[groupId] = { folderId: created.id, title };
    if (!state.openFolders.includes(created.id)) state.openFolders.push(created.id);
    await save();
    const members = await api.tabs.query({ windowId: group.windowId, groupId });
    for (const tab of members.sort((a, b) => a.index - b.index)) await syncTab(tab.id);
  });

  function tabRemoved(tabId, removeInfo = {}) {
    try {
      const state = getState(), failed = state.failedCreates[tabId] !== undefined;
      if (failed) delete state.failedCreates[tabId];
      const saved = removeInfo.isWindowClosing ? cancelRemoval(tabId) : scheduleRemoval(tabId);
      Promise.resolve(saved ?? (failed ? save() : undefined)).catch(warn);
    } catch (error) { warn(error); }
  }

  const groupRemoved = guarded(async (group, removeInfo = {}) => {
    const state = getState(), entry = state.groups[group.id];
    if (!entry) return;
    const decoded = decodeFolderTitle(entry.title);
    state.folderSnapshots ??= {};
    state.folderSnapshots[entry.folderId] = { title: decoded.title, color: decoded.color,
      urls: Object.values(state.tabs).filter(tab => tab.folderId === entry.folderId).map(tab => tab.url) };
    delete state.groups[group.id];
    if (!removeInfo.isWindowClosing) {
      state.openFolders = state.openFolders.filter(id => id !== entry.folderId);
    }
    await save();
  });

  const flush = guarded(async () => {
    for (const [tabId, removal] of Object.entries(getState().pendingRemovals)) {
      if (removal.due > now()) continue;
      // A failed write stays pending for the next queue-owned drain.
      await guarded(async () => {
        const state = getState(), entry = state.tabs[tabId];
        if (!entry || entry.bookmarkId !== removal.bookmarkId || entry.folderId !== removal.folderId) {
          await cancelRemoval(tabId);
          return;
        }
        const groupId = groupOfFolder(state, entry.folderId);
        const live = entry.folderId === state.pinnedId || (groupId !== null
          && await read(() => api.tabGroups.get(groupId)));
        if (live) {
          const nodes = await readBookmark(entry.bookmarkId);
          if (nodes?.[0]) await bookmarkCall([entry.bookmarkId], () => api.bookmarks.remove(entry.bookmarkId));
        }
        delete state.tabs[tabId];
        delete state.pendingRemovals[tabId];
        await save();
      })();
    }
  });

  return { syncTab, syncGroup, tabRemoved, groupRemoved, flush };
}
