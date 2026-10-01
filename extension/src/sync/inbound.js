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
  const mapped = bookmarkId => Object.entries(getState().tabs)
    .find(([, entry]) => entry.bookmarkId === bookmarkId);
  async function bookmarks(folderId) {
    return (await api.bookmarks.getChildren(folderId))
      .filter(node => node.type === "bookmark").sort((a, b) => a.index - b.index);
  }

  // Place only an arriving tab. Existing members' relative order belongs to
  // outbound unless a bookmarkMoved event explicitly requests a whole sort.
  async function positionTab(tabId, folderId, nodes) {
    const state = getState();
    const members = await api.tabs.query(folderId === state.pinnedId
      ? { pinned: true } : { groupId: groupOfFolder(state, folderId) });
    const byId = new Map(members.map(tab => [tab.id, tab])), tab = byId.get(tabId);
    const index = nodes.findIndex(node => node.id === state.tabs[tabId]?.bookmarkId);
    if (!tab || index < 0) return;
    const neighbors = [];
    for (const node of nodes) {
      const pair = mapped(node.id);
      if (!pair || pair[1].folderId !== folderId) continue;
      const other = byId.get(Number(pair[0]));
      if (other && other.windowId === tab.windowId) {
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
    let changed = false;
    try {
      if (folderId === getState().pinnedId) {
        if (tab.groupId != null && tab.groupId !== -1) {
          await api.tabs.ungroup([tabId]);
          changed = true;
        }
        if (!tab.pinned) {
          await api.tabs.update(tabId, { pinned: true });
          changed = true;
        }
      } else {
        // A pin cannot be moved to an unpinned group index. Unpin first, before
        // attaching it to the destination window or calling tabs.group.
        if (tab.pinned) {
          await api.tabs.update(tabId, { pinned: false });
          changed = true;
        }
        if (tab.windowId !== group.windowId) {
          // Firefox 157 grouping a tab before a group in another window is
          // undefined. Attach at the target group's end before assigning it.
          const members = await api.tabs.query({ windowId: group.windowId, groupId: group.id });
          const last = members.sort((a, b) => a.index - b.index).at(-1);
          await api.tabs.move(tabId, { windowId: group.windowId, index: last.index + 1 });
          changed = true;
        }
        await api.tabs.group({ groupId: group.id, tabIds: [tabId] });
        changed = true;
      }
    } catch (error) {
      // Outbound must not interpret a half-transferred tab as a local departure
      // and remove the bookmark that already lives in the destination folder.
      if (changed) { forgetTab(tabId); defer(folderId); }
      warn(error);
      return false;
    }
    // Membership is complete. A failed sort must not discard this identity
    // and let outbound create a duplicate bookmark for the transferred tab.
    entry.folderId = folderId;
    const ordered = await attempt(async () => {
      await positionTab(tabId, folderId, await bookmarks(folderId));
      return true;
    });
    if (!ordered) defer(folderId);
    return true;
  }

  async function departure(tabId, entry) {
    const nodes = await attempt(() => api.bookmarks.get(entry.bookmarkId));
    const bookmark = nodes?.[0], state = getState();
    if (bookmark?.parentId === state.pinnedId) {
      await transfer(tabId, entry, state.pinnedId, null);
      return;
    }
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
    if (!isOpenableUrl(node.url)) return;
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
    if (!tab.pinned) {
      try { await api.tabs.group({ groupId: group.id, tabIds: [tab.id] }); }
      catch (error) {
        warn(error);
        // No mapping yet: the cleanup's onRemoved event cannot make outbound
        // delete the remote bookmark. Leave it for a later reconcile retry.
        const live = await attempt(() => api.tabs.get(tab.id));
        if (live && !await isShown(live)) await attempt(() => api.tabs.remove(tab.id));
        return;
      }
    }
    const state = getState();
    state.tabs[tab.id] = { bookmarkId: node.id, folderId, url: node.url, title: tab.title ?? "" };
    state.quietUntil[tab.id] = now() + quietMs;
    if (tab.pinned) {
      // Firefox cannot create a discarded pin. Discard failure is non-fatal.
      await attempt(() => api.tabs.discard(tab.id));
    } else {
      await positionTab(tab.id, folderId, await bookmarks(folderId));
    }
  }

  async function navigate(tabId, entry, node) {
    // Direction is relative to lastSynced, not the live tab. A local navigation
    // awaiting outbound must never be sent back to an unchanged bookmark URL.
    if (node.url === entry.url) return;
    if (!isOpenableUrl(node.url)) return;
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
    if (expected.every((id, index) => actual[index]?.id === id)) return;
    // Place a prefix in bookmark order. Mutate this detached snapshot after
    // each planned move, so later targets use final indices without n rereads.
    const moves = [], touched = new Set();
    let target = members[0]?.pinned ? 0 : members[0]?.index;
    for (const id of expected) {
      const tab = members.find(member => member.id === id), from = tab.index;
      if (from !== target) {
        moves.push({ id, index: target });
        for (const member of members) {
          const before = member.index;
          if (member.id === id) member.index = target;
          else if (from > target && member.index >= target && member.index < from) member.index++;
          else if (from < target && member.index > from && member.index <= target) member.index--;
          if (before !== member.index) touched.add(member);
        }
      }
      target = tab.index + 1;
    }
    // Do not implement a deferred move indirectly by shuffling neighbours,
    // including shown members whose departure to another folder is blocked.
    for (const tab of touched) {
      if (await isShown(tab)) { defer(folderId); return; }
    }
    for (const move of moves) await api.tabs.move(move.id, { index: move.index });
  }

  async function reconcileFolder(folderId, retryOrder = false) {
    const state = getState(), pinned = folderId && folderId === state.pinnedId;
    const groupId = groupOfFolder(state, folderId);
    if (!pinned && groupId === null) return; // Saved here, never auto-open.
    // The controller rematches late restore tabs before releasing this durable
    // quiet-period marker. Bookmark echoes must not open duplicates meanwhile.
    if (!pinned && Number.isFinite(state.groups[groupId]?.rebindUntil)) {
      if (retryOrder) state.groups[groupId].pendingOrder = true;
      return;
    }
    retryOrder ||= !!state.groups[groupId]?.pendingOrder;
    let folder;
    try { [folder] = await api.bookmarks.get(folderId); }
    catch (error) {
      // Firefox's missing-GUID error (and the strict fake's equivalent) is
      // deletion evidence. Permission/backend errors are not.
      if (/^(?:Bookmark not found[.!]?$|Invalid bookmark ID:)/i.test(error?.message ?? String(error))) {
        await folderRemoved(folderId);
      } else {
        warn(error);
        if (retryOrder) defer(folderId);
      }
      return;
    }
    if (!folder) return;
    const group = pinned ? null : await attempt(() => api.tabGroups.get(groupId));
    if (!pinned && !group) return; // A missing group at startup is not deletion.
    const nodes = await bookmarks(folderId), ids = new Set(nodes.map(n => n.id));
    const unopenable = [...new Set(nodes.filter(node => !isOpenableUrl(node.url)).map(node => node.url))];
    if (unopenable.length) state.cantReopen[folderId] = unopenable;
    else delete state.cantReopen[folderId];
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
          if (!await transfer(Number(pair[0]), pair[1], folderId, group)) return;
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
      if (retryOrder) {
        await orderMapped(folderId, nodes, await api.tabs.query({ windowId: group.windowId, groupId: group.id }));
        if (!state.deferred.includes(folderId)) delete state.groups[groupId].pendingOrder;
      }
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
    const state = getState();
    if (!state.expectedMoves || typeof state.expectedMoves !== "object" || Array.isArray(state.expectedMoves)) {
      state.expectedMoves = {};
    }
    const expected = state.expectedMoves[id];
    if (expected !== undefined) {
      const at = now(), fresh = Array.isArray(expected)
        ? expected.filter(move => move && move.at <= at && at - move.at <= 60000) : [];
      const match = fresh.findIndex(move => move.parentId === moveInfo.parentId && move.index === moveInfo.index);
      const remaining = match < 0 ? [] : fresh.slice(match + 1);
      if (remaining.length) state.expectedMoves[id] = remaining;
      else delete state.expectedMoves[id];
      if (match >= 0) return;
    }
    if (moveInfo.parentId !== moveInfo.oldParentId) {
      await reconcileFolder(moveInfo.oldParentId, true);
      await reconcileFolder(moveInfo.parentId, true);
      return;
    }
    // Several remote moves can arrive before either event is processed.
    // Sort the whole current folder, including when this bookmark is unmapped.
    await reconcileFolder(moveInfo.parentId, true);
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
