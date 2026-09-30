import { decodeFolderTitle, encodeFolderTitle, isOpenableUrl } from "./codec.js";
import { emptyState, groupOfFolder, tabsInFolder } from "./state.js";

/** All methods run inside the controller's queue. Inner work never re-enqueues. */
export function createInbound({ api, getState, save, now = Date.now, quietMs = 10000 }) {
  const warn = error => console.warn("Foxy: inbound sync failed", error);
  const attempt = async fn => {
    try { return await fn(); } catch (error) { warn(error); return null; }
  };
  // Persist partial successes too; a failed later API call must not lose a
  // mapping or a safety deferral when the event page sleeps.
  const guarded = fn => async (...args) => {
    const before = JSON.stringify(getState());
    try { await fn(...args); } catch (error) { warn(error); }
    if (JSON.stringify(getState()) !== before) await attempt(save);
  };

  async function isShown(tab) {
    if (!tab.active) return false;
    try {
      const win = await api.windows.getLastFocused({ windowTypes: ["normal"] });
      return win.id === tab.windowId && win.focused;
    } catch (error) {
      warn(error);
      return true; // A failed focus read is not permission to destroy a tab.
    }
  }

  function defer(...folderIds) {
    const state = getState();
    for (const id of folderIds) if (id && !state.deferred.includes(id)) state.deferred.push(id);
  }
  function forgetTab(tabId) {
    const state = getState();
    delete state.tabs[tabId];
    delete state.quietUntil[tabId];
  }
  function cantReopen(folderId, url) {
    const state = getState(), urls = state.cantReopen[folderId] ??= [];
    if (!urls.includes(url)) urls.push(url);
  }
  const mapped = bookmarkId => Object.entries(getState().tabs)
    .find(([, entry]) => entry.bookmarkId === bookmarkId);
  async function bookmarks(folderId) {
    return (await api.bookmarks.getChildren(folderId))
      .filter(node => node.type === "bookmark").sort((a, b) => a.index - b.index);
  }

  // Place this tab only, using live indices (tab ids and bookmark indices
  // need not be contiguous). Pins are ordered within their window only.
  async function positionTab(tabId, folderId, nodes) {
    const state = getState(), tab = await api.tabs.get(tabId);
    const index = nodes.findIndex(node => node.id === state.tabs[tabId]?.bookmarkId);
    if (index < 0) return;
    const neighbors = [];
    for (const node of nodes) {
      const pair = mapped(node.id);
      if (!pair || pair[1].folderId !== folderId) continue;
      const other = await attempt(() => api.tabs.get(Number(pair[0])));
      if (other && other.windowId === tab.windowId && (tab.pinned ? other.pinned : other.groupId === tab.groupId)) {
        neighbors.push({ tab: other, index: node.index });
      }
    }
    const nodeIndex = nodes[index].index;
    const previous = neighbors.filter(n => n.index < nodeIndex).at(-1)?.tab;
    const next = neighbors.find(n => n.index > nodeIndex)?.tab;
    if ((!previous || previous.index < tab.index) && (!next || tab.index < next.index)) return;
    if (await isShown(tab)) { defer(folderId); return; }
    const target = next ? next.index - Number(tab.index < next.index)
      : previous.index + 1 - Number(tab.index < previous.index);
    await api.tabs.move(tabId, { index: target });
  }

  async function transfer(tabId, entry, folderId, group) {
    const tab = await api.tabs.get(tabId);
    if (await isShown(tab)) { defer(entry.folderId, folderId); return false; }
    if (tab.windowId !== group.windowId) {
      // Firefox 157 grouping a tab before a group in another window is
      // undefined. Attach at the target group's end before assigning it.
      const members = await api.tabs.query({ windowId: group.windowId, groupId: group.id });
      const last = members.sort((a, b) => a.index - b.index).at(-1);
      await api.tabs.move(tabId, { windowId: group.windowId, index: last.index + 1 });
    }
    await api.tabs.group({ groupId: group.id, tabIds: [tabId] });
    entry.folderId = folderId;
    await positionTab(tabId, folderId, await bookmarks(folderId));
    return true;
  }

  async function departure(tabId, entry) {
    const nodes = await attempt(() => api.bookmarks.get(entry.bookmarkId));
    const bookmark = nodes?.[0], state = getState();
    const groupId = bookmark ? groupOfFolder(state, bookmark.parentId) : null;
    const group = groupId === null ? null : await attempt(() => api.tabGroups.get(groupId));
    if (group) {
      await transfer(tabId, entry, bookmark.parentId, group);
      return;
    }
    const tab = await attempt(() => api.tabs.get(tabId));
    if (tab && await isShown(tab)) { defer(entry.folderId); return; }
    if (tab) await api.tabs.remove(tabId);
    forgetTab(tabId);
  }

  async function openBookmark(node, folderId, group) {
    if (!isOpenableUrl(node.url)) { cantReopen(folderId, node.url); return; }
    let tab;
    if (folderId === getState().pinnedId) {
      const win = await api.windows.getLastFocused({ windowTypes: ["normal"] });
      let index = 0;
      const earlier = (await bookmarks(folderId)).filter(other => other.index < node.index).reverse();
      for (const other of earlier) {
        const pair = mapped(other.id);
        if (!pair || pair[1].folderId !== folderId) continue;
        const pin = await attempt(() => api.tabs.get(Number(pair[0])));
        if (pin?.pinned && pin.windowId === win.id) { index = pin.index + 1; break; }
      }
      tab = await api.tabs.create({ windowId: win.id, index, url: node.url, pinned: true, active: false });
    } else {
      tab = await api.tabs.create({ windowId: group.windowId, url: node.url,
        title: node.title, discarded: true, active: false });
    }
    const state = getState();
    state.tabs[tab.id] = { bookmarkId: node.id, folderId, url: node.url, title: tab.title ?? "" };
    state.quietUntil[tab.id] = now() + quietMs;
    if (tab.pinned) {
      // Firefox cannot create a discarded pin. Discard failure is non-fatal.
      await attempt(() => api.tabs.discard(tab.id));
    } else {
      await api.tabs.group({ groupId: group.id, tabIds: [tab.id] });
      await positionTab(tab.id, folderId, await bookmarks(folderId));
    }
  }

  async function navigate(tabId, entry, node) {
    // Direction is relative to lastSynced, not the live tab. A local navigation
    // awaiting outbound must never be sent back to an unchanged bookmark URL.
    if (node.url === entry.url) return;
    if (!isOpenableUrl(node.url)) { cantReopen(entry.folderId, node.url); return; }
    const tab = await api.tabs.get(tabId);
    if (await isShown(tab)) { defer(entry.folderId); return; }
    const updated = await api.tabs.update(tabId, { url: node.url });
    entry.url = node.url;
    // There is no tabs.update({title}) API. Record the resulting tab title so
    // outbound's complete/title branch does not echo an immediate title write.
    entry.title = updated.title ?? "";
    getState().quietUntil[tabId] = now() + quietMs;
  }

  async function orderMapped(folderId, nodes, members) {
    members.sort((a, b) => a.index - b.index);
    const expected = nodes.map(node => mapped(node.id)).filter(pair => pair?.[1].folderId === folderId)
      .map(pair => Number(pair[0])).filter(id => members.some(tab => tab.id === id));
    const actual = members.filter(tab => expected.includes(tab.id));
    // Do not implement a deferred move indirectly by shuffling its neighbors.
    for (const [index, tab] of actual.entries()) {
      if (expected[index] !== tab.id && await isShown(tab)) { defer(folderId); return; }
    }
    for (const id of expected) await positionTab(id, folderId, nodes);
  }

  async function reconcileFolder(folderId, retryOrder = false) {
    const state = getState(), pinned = folderId && folderId === state.pinnedId;
    const groupId = groupOfFolder(state, folderId);
    if (!pinned && groupId === null) return; // Saved here, never auto-open.
    const folder = (await attempt(() => api.bookmarks.get(folderId)))?.[0];
    if (!folder) { await folderRemoved(folderId); return; }
    const group = pinned ? null : await attempt(() => api.tabGroups.get(groupId));
    if (!pinned && !group) return; // A missing group at startup is not deletion.
    const nodes = await bookmarks(folderId), ids = new Set(nodes.map(n => n.id));
    if (group) {
      const members = await api.tabs.query({ windowId: group.windowId, groupId });
      const allDeparting = members.length && members.every(tab => {
        const entry = state.tabs[tab.id];
        return entry?.folderId === folderId && !ids.has(entry.bookmarkId);
      });
      // Firefox deletes a group as soon as its last tab leaves. A batch can
      // replace all bookmarks, so open its new members before emptying it.
      if (allDeparting) {
        for (const node of nodes) {
          if (!mapped(node.id) && isOpenableUrl(node.url)) await attempt(() => openBookmark(node, folderId, group));
        }
      }
    }
    for (const [tabId, entry] of tabsInFolder(state, folderId)) {
      if (!ids.has(entry.bookmarkId)) await attempt(() => departure(tabId, entry));
    }
    for (const node of nodes) {
      await attempt(async () => {
        let pair = mapped(node.id);
        if (pair && pair[1].folderId !== folderId) {
          // Destination-first events must not create a duplicate of a tab that
          // is still mapped to its source (including a deferred source move).
          if (group) {
            if (!await transfer(Number(pair[0]), pair[1], folderId, group)) return;
          } else {
            await departure(Number(pair[0]), pair[1]);
            if (mapped(node.id)) { defer(pair[1].folderId, folderId); return; }
          }
        }
        pair = mapped(node.id);
        if (!pair) await openBookmark(node, folderId, group);
        else await navigate(Number(pair[0]), pair[1], node);
      });
    }
    if (group) {
      const decoded = decodeFolderTitle(folder.title), title = encodeFolderTitle(decoded);
      if (title !== state.groups[groupId]?.title.trim()) {
        await api.tabGroups.update(groupId, decoded);
        state.groups[groupId].title = title;
      }
      await orderMapped(folderId, nodes, await api.tabs.query({ windowId: group.windowId, groupId: group.id }));
    } else if (retryOrder) {
      // A deferred explicit pin move is retried per window. New pins already
      // use bookmark-relative placement; never move pins between windows.
      const pins = await api.tabs.query({ pinned: true });
      for (const windowId of new Set(pins.map(tab => tab.windowId))) {
        await orderMapped(folderId, nodes, pins.filter(tab => tab.windowId === windowId));
      }
    }
  }

  async function reconcileAll() {
    const state = getState();
    const folders = new Set([state.pinnedId, ...Object.values(state.groups).map(entry => entry.folderId)]);
    for (const id of folders) if (id) await attempt(() => reconcileFolder(id));
  }

  async function folderRemoved(folderId) {
    const state = getState();
    if (folderId === state.rootId) { Object.assign(state, emptyState()); return; }
    const groupId = groupOfFolder(state, folderId);
    let blocked = false;
    if (groupId !== null) {
      const members = await api.tabs.query({ groupId });
      const safe = [];
      for (const tab of members) {
        if (await isShown(tab)) { blocked = true; defer(folderId); }
        else safe.push(tab.id);
      }
      if (safe.length) await api.tabs.ungroup(safe);
      for (const [tabId] of tabsInFolder(state, folderId)) {
        if (!members.some(tab => tab.id === tabId) || safe.includes(tabId)) forgetTab(tabId);
      }
      // Keep the removed folder's identity until its shown tab can be safely
      // ungrouped. reconcileFolder detects its absence on the persisted retry.
      if (blocked) return;
      delete state.groups[groupId];
    }
    for (const [tabId] of tabsInFolder(state, folderId)) forgetTab(tabId);
    state.openFolders = state.openFolders.filter(id => id !== folderId);
    state.missing = state.missing.filter(id => id !== folderId);
    state.deferred = state.deferred.filter(id => id !== folderId);
    delete state.cantReopen[folderId];
  }

  async function bookmarkMoved(id, moveInfo) {
    if (moveInfo.parentId !== moveInfo.oldParentId) {
      await reconcileFolder(moveInfo.oldParentId);
      await reconcileFolder(moveInfo.parentId);
      return;
    }
    const folderId = moveInfo.parentId, pair = mapped(id);
    if (!pair || pair[1].folderId !== folderId) return;
    if (folderId !== getState().pinnedId && groupOfFolder(getState(), folderId) === null) return;
    await positionTab(Number(pair[0]), folderId, await bookmarks(folderId));
  }

  async function applyDeferred() {
    const state = getState(), folders = [...new Set(state.deferred)];
    state.deferred = [];
    for (const id of folders) {
      try { await reconcileFolder(id, true); } catch (error) { warn(error); defer(id); }
    }
  }

  return { reconcileFolder: guarded(reconcileFolder), reconcileAll: guarded(reconcileAll),
    folderRemoved: guarded(folderRemoved), bookmarkMoved: guarded(bookmarkMoved),
    applyDeferred: guarded(applyDeferred), isShown };
}
