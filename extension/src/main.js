import { msUntilNextMinute } from "./model.js";
import { buildBoard } from "./board/model.js";
import { renderBoard, updateScrollEdges, updateClock } from "./board/render.js";
import { resolveTabTarget } from "./board/targets.js";
import { openTab, closeTabs, closeGroup, bringGroupHere, renameGroup, recolorGroup,
  dropTab } from "./board/moves.js";

import { buildView } from "./grid/view.js";
import { attachGridDrag } from "./grid/drag.js";
import { place, changedTiles, railLimits } from "./grid/layout.js";
import { renderSettings, settingActions, resetLayout } from "./settings/pane.js";
import { tileKey, loadLayout, saveTiles, pruneTiles, watchStorage } from "./grid/store.js";
import { loadSettings, saveSetting, cardAlpha } from "./settings/store.js";
export { renderTime, updateClock } from "./board/render.js";

function validFoldersReply(reply) {
  return reply?.ok !== false && Array.isArray(reply?.saved) && Array.isArray(reply?.missing) &&
    reply.folders !== null && typeof reply.folders === "object" && !Array.isArray(reply.folders) &&
    Object.values(reply.folders).every(id => typeof id === "string" && id.length > 0);
}

const root = document.getElementById("board");
if (root) createController(root, globalThis.browser).refresh();

// Minute boundaries and visibility changes update the tile without a board read.
function startClock(root, settings) {
  let timer = 0;
  const tick = () => {
    clearTimeout(timer);
    if (!root.isConnected) return;
    const now = new Date();
    updateClock(root, settings(), now);
    timer = setTimeout(tick, msUntilNextMinute(now));
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tick();
  });
  tick();
}

/** All board interactions share this state; DnD and editors set it via handlers. */
export function createController(root, api, ui = { editGroupId: null, dragging: false, editing: false },
  { maxWait = 30000, newGroupDelay = 1000 } = {}) {
  ui.confirmFolderId ??= null;
  ui.gridDragging ??= false;
  ui.busy ??= new Set();
  let board;
  let view;
  let gridState;
  let gridRead;
  let storageVersion = 0;
  let tileWriteVersion = 0;
  let loadedVersion = -1;
  let pendingGrid = false;
  let pendingView = false;
  let hasSavedReply = false;
  let hasValidSavedReply = false;
  let firstPaintReady = false;
  let firstPaintTimer = 0;
  let pruned = false;
  let persistence = Promise.resolve();
  const pendingTiles = new Map();
  const settingsPane = root.parentElement?.querySelector(":scope > .settings-pane");
  const paneHandlers = settingActions(api, async () => {
    await persistence;
    await resetLayout(api);
    pendingTiles.clear();
  });
  const gear = () => root.querySelector(".settings-button");
  function setPaneOpen(open) {
    if (!settingsPane) return;
    settingsPane.hidden = !open;
    gear()?.setAttribute("aria-expanded", String(open));
    if (open) settingsPane.querySelector("button, input")?.focus({ preventScroll: true });
    else gear()?.focus({ preventScroll: true });
  }
  root.addEventListener("click", event => {
    if (event.target.closest(".settings-button")) setPaneOpen(settingsPane?.hidden);
  });
  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && root.isConnected && settingsPane && !settingsPane.hidden) {
      event.preventDefault(); setPaneOpen(false);
    }
  });
  const deferredGroups = new Map();
  let firstPaintGroups;
  let unloaded = false;
  let self;
  let generation = 0;
  let queued = false;
  let pending = false;
  let pendingSaved = false;
  let readsInFlight = 0;
  let savedReadsInFlight = 0;
  let savedDirty = false;
  let savedDirtyRetry = false;
  let savedGeneration = 0;
  let savedReply = { saved: [], missing: [], pins: {}, folders: {} };
  let snapshot;
  let warnedSaved = false;
  let retryQueued = true;
  let lastRenderedKey;
  let actionsInFlight = 0;
  let requestedEditGroupId = null;
  let draggedTileId;
  const held = () => actionsInFlight > 0 || ui.dragging || ui.gridDragging || ui.editing || ui.editGroupId != null;
  // An editor holds board reads/renders, but must not hide its own removal.
  const canCheckEdit = () => actionsInFlight === 0 && !ui.dragging && !ui.gridDragging && (ui.editGroupId != null || ui.editTabId != null);
  function releaseMissingEdit() {
    ui.editGroupId = null;
    ui.editTabId = null;
    ui.editing = false;
    ++generation;
  }

  function clearDeferredGroup(groupId) {
    const entry = deferredGroups.get(groupId);
    if (entry) clearTimeout(entry.timer);
    deferredGroups.delete(groupId);
  }

  function maySaveNewGroup(groupId, tileId) {
    if (unloaded) return false;
    if (firstPaintGroups.has(groupId) || pendingTiles.has(groupId)) return true;
    if (!deferredGroups.has(groupId)) {
      const entry = { ready: false, timer: 0 };
      deferredGroups.set(groupId, entry);
      entry.timer = setTimeout(async () => {
        if (!root.isConnected) { clearDeferredGroup(groupId); return; }
        try {
          // The page receiving the drop gets the first chance to save its rect.
          const key = tileKey(tileId), stored = await api.storage.sync.get(key);
          if (deferredGroups.get(groupId) !== entry || unloaded) return;
          entry.ready = stored[key] === undefined;
          // Re-read and publish through the normal interaction and write guards.
          ++storageVersion;
          pendingGrid = true;
          enqueue();
        } catch (error) {
          console.warn("Foxy: could not check new group tile", error);
          // Let a later render schedule the check again.
          if (deferredGroups.get(groupId) === entry) deferredGroups.delete(groupId);
        }
      }, newGroupDelay);
    }
    return deferredGroups.get(groupId).ready;
  }

  // Storage reads share an order independent of tab and bookmark snapshots.
  // An old read, or one completed during an interaction, cannot apply settings.
  async function readGrid() {
    if (gridState && loadedVersion === storageVersion) return true;
    if (!gridRead) {
      const version = storageVersion, writeVersion = tileWriteVersion;
      let failed = false;
      // Stores log failures and return defaults. Track read failures separately
      // so those defaults cannot overwrite a layout we have not read.
      const readingApi = { storage: Object.fromEntries(["sync", "local"].map(area => [area, {
        get: async (...args) => {
          try { return await api.storage[area].get(...args); }
          catch (error) { failed = true; throw error; }
        },
      }])) };
      gridRead = Promise.all([loadLayout(readingApi), loadSettings(readingApi)])
        .then(([layout, settings]) => ({ layout, ...settings, version, writeVersion, writable: !failed }));
    }
    const next = await gridRead;
    gridRead = null;
    // A read can return the old layout before our queued write is visible.
    // Wait for persistence, then reject snapshots spanning a local tile write.
    let settled;
    do { settled = persistence; await settled; } while (settled !== persistence);
    if (held() || next.version !== storageVersion || next.writeVersion !== tileWriteVersion) {
      pendingGrid = true;
      enqueue();
      return false;
    }
    gridState = !next.writable && gridState ? { ...gridState, writable: false } : next;
    loadedVersion = next.version;
    pendingGrid = false;
    return true;
  }

  async function refreshGrid() {
    if (await readGrid()) {
      publish();
      if (pendingSaved) enqueue();
    }
  }

  // Saved replies have their own request order: a bookmark-only read must not
  // invalidate an in-flight tab snapshot, nor can an old reply replace a new one.
  async function readSaved(retry = true) {
    if (savedReadsInFlight) { savedDirty = true; savedDirtyRetry ||= retry; return; }
    const mine = ++savedGeneration;
    ++savedReadsInFlight;
    let reply, timer, valid = false, arrived = false;
    if (!firstPaintReady && !firstPaintTimer) {
      firstPaintTimer = setTimeout(() => {
        firstPaintTimer = 0;
        firstPaintReady = true;
        pendingView = true;
        enqueue();
      }, 500);
    }
    try {
      const responses = await Promise.race([
        Promise.all([api.runtime.sendMessage({ type: "foxy:saved" }).then(value => {
          arrived = true;
          // Pin names are a companion read, not a first-paint dependency.
          if (mine === savedGeneration && !hasSavedReply && !held()) {
            if (Array.isArray(value?.saved) && Array.isArray(value?.missing)) {
              savedReply = { ...value, pins: savedReply.pins };
              hasValidSavedReply = validFoldersReply(value);
            }
            hasSavedReply = true;
            firstPaintReady = true;
            clearTimeout(firstPaintTimer);
            firstPaintTimer = 0;
            if (snapshot) publish();
          }
          return value;
        }),
          api.runtime.sendMessage({ type: "foxy:pins" })]),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("foxy:saved timed out")), maxWait);
        }),
      ]);
      reply = { ...responses[0], pins: responses[1]?.pins ?? {} };
      if (!Array.isArray(reply?.saved) || !Array.isArray(reply?.missing)) {
        throw new Error("Background did not return saved and missing arrays");
      }
      valid = validFoldersReply(reply);
    } catch (error) {
      reply = savedReply;
      if (!warnedSaved) {
        warnedSaved = true;
        console.warn("Foxy: could not read saved groups", error);
      }
    } finally { clearTimeout(timer); --savedReadsInFlight; }
    try {
      if (mine === savedGeneration) {
        if (held()) {
          pendingSaved = true;
          enqueue();
        } else {
          // Saved data is independent of the tab snapshot's generation.
          savedReply = reply;
          hasSavedReply ||= arrived;
          hasValidSavedReply ||= valid;
          if (hasSavedReply) {
            firstPaintReady = true;
            clearTimeout(firstPaintTimer);
            firstPaintTimer = 0;
          }
          if (snapshot) {
            board = buildBoard({ ...snapshot, ...savedReply });
            publish();
          }
        }
      }
    } catch (error) {
      console.warn("Foxy: could not publish saved groups", error);
      if (retry) schedule(false);
    }
    if (savedDirty) {
      const dirtyRetry = savedDirtyRetry;
      savedDirty = false;
      savedDirtyRetry = false;
      refreshSaved(dirtyRetry);
    }
  }

  function refreshSaved(retry = true) {
    if (held()) { pendingSaved = true; return; }
    pendingSaved = false;
    return readSaved(retry);
  }

  async function refresh(retry = true) {
    let reading = false;
    try {
      if (held()) {
        pending = true;
        if (!canCheckEdit()) return;
        const editId = ui.editGroupId, editTabId = ui.editTabId, editGeneration = generation;
        let exists;
        if (editTabId != null) {
          try { exists = (await api.tabs.get(editTabId)).pinned; } catch { exists = false; }
        } else exists = (await api.tabGroups.query({})).some(group => group.id === editId);
        // Do not let an older existence check end a newer interaction.
        if (generation !== editGeneration || ui.editGroupId !== editId || ui.editTabId !== editTabId ||
            !canCheckEdit() || exists) return;
        releaseMissingEdit();
      }
      const mine = ++generation;
      if (!await readGrid()) { pending = true; return; }
      if (mine !== generation) return;
      pending = false;
      pendingSaved = false;
      // Read tabs concurrently; publish holds the first paint for up to 500ms.
      readSaved(retry);
      reading = true;
      ++readsInFlight;
      const [windows, tabs, groups, current] = await Promise.all([
        api.windows.getAll({ windowTypes: ["normal"] }), api.tabs.query({}),
        api.tabGroups.query({}), api.tabs.getCurrent(),
      ]);
      if (held()) { pending = true; return; }
      if (mine !== generation) { pending = true; return; }
      const nextSnapshot = { windows, tabs, groups, currentWindowId: current.windowId,
        selfTabId: current.id, selfUrl: location.origin + location.pathname };
      const nextBoard = buildBoard({ ...nextSnapshot, ...savedReply, otherWindows: gridState.synced.otherWindows });
      snapshot = nextSnapshot;
      const liveGroups = new Set(groups.map(group => group.id));
      for (const id of pendingTiles.keys()) if (!liveGroups.has(id)) pendingTiles.delete(id);
      for (const id of deferredGroups.keys()) if (!liveGroups.has(id)) clearDeferredGroup(id);
      self = current;
      board = nextBoard;
      // Introduce a newly created tile/editor in the final action snapshot.
      // Once published, editGroupId holds every subsequent refresh.
      if (requestedEditGroupId != null) {
        ui.editGroupId = board.columns.some(column => column.id === requestedEditGroupId)
          ? requestedEditGroupId : null;
        requestedEditGroupId = null;
      }
      publish();
    } catch (error) {
      pending = true;
      console.warn("Foxy: could not refresh board", error);
      // One bounded retry re-reads after a transient API error. Further events
      // can retry again, without a permanent failure creating a frame loop.
      if (retry) schedule(false);
    } finally { if (reading) --readsInFlight; }
  }

  function publish(save = true) {
    if (ui.gridDragging) { pendingView = true; return; }
    if (!board || !gridState || !firstPaintReady) return;
    board = buildBoard({ ...snapshot, ...savedReply, otherWindows: gridState.synced.otherWindows });
    firstPaintGroups ??= new Set(board.columns.map(group => group.id));
    for (const id of deferredGroups.keys()) {
      if (gridState.layout.some(tile => tile.id === `group:${savedReply.folders?.[id]}`)) clearDeferredGroup(id);
    }
    const options = { ...gridState, contentWidth: root.clientWidth,
      folders: savedReply.folders ?? {}, pending: new Map() };
    view = buildGridView(options);
    const knowsFolders = hasValidSavedReply && validFoldersReply(savedReply);
    const writable = save && gridState.writable && knowsFolders;
    let writes = [], prune = false;
    if (writable) {
      const groups = new Map(board.columns.map(group => [group.id, group]));
      const mapped = [...pendingTiles.keys()].filter(id => groups.has(id) && savedReply.folders[id])
        .map(id => groups.get(id));
      // Start from the shown layout, not saved off-screen/hidden rectangles or
      // pending display pushes. The new group takes priority over existing tiles.
      const beforeView = view;
      const mappedIds = new Set(mapped.map(group => `group:${savedReply.folders[group.id]}`));
      const shownBefore = beforeView.tiles.filter(tile => !mappedIds.has(tile.id) && !tile.id.startsWith("local:"));
      let shownAfter = shownBefore;
      for (const group of mapped) {
        shownAfter = place(shownAfter, `group:${savedReply.folders[group.id]}`, pendingTiles.get(group.id), view.cols);
      }
      const fresh = beforeView.newTiles.filter(tile => !mappedIds.has(tile.id));
      const changed = mapped.length ? changedTiles(shownBefore, shownAfter).filter(tile => !tile.id.startsWith("local:")) : [];
      writes = [...new Map([...fresh, ...changed].map(tile => [tile.id, tile])).values()]
        .filter(tile => {
          if (!tile.id.startsWith("group:") || gridState.layout.some(saved => saved.id === tile.id)) return true;
          const group = board.columns.find(group => tile.id === `group:${options.folders[group.id]}`);
          return maySaveNewGroup(group.id, tile.id);
        })
        .map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));
      // Hold placements in memory even on a storage failure, without retrying in
      // a loop or writing twice before storage.onChanged is delivered.
      if (writes.length) {
        gridState.layout = [...new Map([...gridState.layout, ...writes].map(tile => [tile.id, tile])).values()];
      }
      for (const group of mapped) pendingTiles.delete(group.id);
      if (mapped.length) view = buildGridView({ ...options, layout: gridState.layout });
      prune = !pruned;
      if (prune) pruned = true;
    }
    // Pending rectangles have placement priority for display too, but local ids
    // and any tiles they push are never written until a valid mapping arrives.
    displayPending(view);
    pendingView = false;
    // JSON.stringify(Set) is {}, so serialize its folder IDs explicitly.
    const { saved: savedLayout, newTiles, ...shown } = view;
    const key = JSON.stringify({ board, view: shown, settings: gridState.synced, device: gridState.device,
      ui: { ...ui, busy: [...ui.busy].sort() } });
    if (key !== lastRenderedKey) {
      const saved = captureView(root);
      root.style.setProperty("--card-alpha-dark", cardAlpha(gridState.synced.transparency, "dark"));
      root.style.setProperty("--card-alpha-light", cardAlpha(gridState.synced.transparency, "light"));
      root.style.setProperty("--row", gridState.device.density === "compact" ? "24px" : "32px");
      renderBoard(root, board, view, ui, handlers, gridState.synced);
      gear()?.setAttribute("aria-expanded", String(settingsPane ? !settingsPane.hidden : false));
      if (settingsPane?.id) gear()?.setAttribute("aria-controls", settingsPane.id);
      restoreView(root, saved);
      lastRenderedKey = key;
    }
    if (settingsPane) renderSettings(settingsPane, { synced: gridState.synced, device: gridState.device,
      railMax: railLimits(view.total).max }, paneHandlers);
    if (writes.length || prune) {
      const keep = new Set([...Object.values(savedReply.folders ?? {}),
        ...board.saved.map(group => group.folderId), ...board.missing.map(group => group.folderId)]);
      persistence = persistence.then(async () => {
        try { await saveTiles(api, writes); }
        finally { if (writes.length) ++tileWriteVersion; }
        if (prune) await pruneTiles(api, keep);
      }).catch(() => {}); // The stores log each failed write with the Foxy prefix.
    }
  }

  function schedule(retry = true) {
    pending = true;
    enqueue(retry);
  }

  function scheduleSaved() {
    pendingSaved = true;
    enqueue();
  }

  function enqueue(retry = true) {
    if (held() && !(pending && canCheckEdit())) return;
    if (queued) { retryQueued ||= retry; return; }
    queued = true;
    retryQueued = retry;
    requestAnimationFrame(() => {
      queued = false;
      if ((held() && !(pending && canCheckEdit())) || (!pending && !pendingSaved && !pendingGrid && !pendingView)) return;
      if (pending) refresh(retryQueued);
      else if (pendingGrid) refreshGrid();
      else if (pendingSaved) refreshSaved(retryQueued);
      else publish(false);
    });
  }

  function interaction(key, active) {
    ui[key] = active;
    if (active) {
      ++generation;
      // Only invalidated reads require replacement; bookmark-only updates
      // during an otherwise idle interaction must not cause tab re-read storms.
      if (readsInFlight) pending = true;
      if (savedReadsInFlight) pendingSaved = true;
    } else if (pending || pendingSaved || pendingGrid || pendingView) enqueue();
    else if (!held()) publish();
  }

  async function action(run) {
    ++actionsInFlight;
    ++generation;
    pending = true;
    try { return await run(); }
    catch (error) { console.warn("Foxy: board action failed", error); }
    finally {
      if (--actionsInFlight === 0) await refresh();
    }
  }

  function savedAction(id, message, deleting = false) {
    if (ui.busy.has(id)) return;
    ui.busy.add(id);
    // Busy is a UI-only publication, deliberately not deferred by action holds.
    publish();
    return action(async () => {
      let timer;
      try {
        const reply = await Promise.race([
          api.runtime.sendMessage(message),
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${message.type} timed out`)), maxWait);
          }),
        ]);
        if (reply?.ok !== true) throw new Error(`${message.type} was not accepted`);
        if (deleting) {
          await api.storage.sync.remove(tileKey(`group:${id}`));
          gridState.layout = gridState.layout.filter(tile => tile.id !== `group:${id}`);
        }
        return reply;
      } finally {
        clearTimeout(timer);
        ui.busy.delete(id);
        if (deleting && ui.confirmFolderId === id) ui.confirmFolderId = null;
        publish();
      }
    });
  }

  // This call must happen in the event handler, before action() or any await.
  function requestSite(origin) {
    try {
      return origin ? Promise.resolve(api.permissions.request({ origins: [origin] }))
        .catch(error => { console.warn("Foxy: could not request site access", error); return false; }) : Promise.resolve(false);
    } catch (error) { console.warn("Foxy: could not request site access", error); return Promise.resolve(false); }
  }
  const handlers = {
    onConfirmDelete: folderId => {
      if (ui.confirmFolderId === folderId) return;
      ui.confirmFolderId = folderId;
      if (held()) pending = true;
      else publish();
    },
    onOpenSaved: folderId => savedAction(folderId, {
      type: "foxy:open-saved", folderId, windowId: self?.windowId,
    }),
    onDeleteSaved: folderId => {
      if (ui.confirmFolderId !== folderId) return;
      return savedAction(folderId, { type: "foxy:delete-saved", folderId }, true);
    },
    onRestoreAll: () => savedAction("banner", { type: "foxy:restore-all", windowId: self?.windowId }),
    onDismissMissing: () => savedAction("banner", { type: "foxy:dismiss-missing" }),
    onOpen: row => action(() => openTab(api, row, self, { close: history.length === 1,
      pinsMoveHere: gridState.synced.pinsMoveHere })),
    onCloseTab: tabId => action(() => closeTabs(api, [tabId], self?.id)),
    onCloseGroup: groupId => action(() => closeGroup(api, groupId, self?.id)),
    onBringHere: groupId => action(() => bringGroupHere(api, groupId, self.windowId)),
    onRenamePin: (tabId, name, origin) => {
      const permission = requestSite(origin);
      permission.then(granted => {
        console.debug("Foxy: pin site access", granted);
        scheduleSaved();
      });
      return action(async () => {
        const reply = await api.runtime.sendMessage({ type: "foxy:rename-pin", tabId, name });
        if (reply?.ok !== true) throw new Error("foxy:rename-pin was not accepted");
      });
    },
    onAllowPin: origin => {
      const permission = requestSite(origin);
      permission.then(granted => {
        console.debug("Foxy: pin site access", granted);
        scheduleSaved();
      });
    },
    onRename: (groupId, title) => action(() => renameGroup(api, groupId, title)),
    onRecolor: (groupId, color) => action(() => recolorGroup(api, groupId, color)),
    onTabDrop: (tabId, drop) => {
      const lists = board ? [...board.pinned, ...board.tabs, ...board.columns] : [];
      if (tabId === self?.id || !lists.some(list => list.rows.some(row => row.id === tabId))) {
        console.debug("Foxy: ignored drop of a tab not on the board", tabId);
        return;
      }
      return action(async () => {
        const target = resolveTabTarget(board, { ...drop, tabId }, self.windowId);
        const result = await dropTab(api, tabId, target);
        if (result.ok && result.groupId != null) {
          requestedEditGroupId = result.groupId;
          if (result.rect) pendingTiles.set(result.groupId, result.rect);
        }
        return result;
      });
    },
    onDragState: dragging => interaction("dragging", dragging),
    onEditState: (editing, groupId, tabId) => {
      if (editing && tabId != null) ui.editTabId = tabId;
      if (editing && groupId != null) ui.editGroupId = groupId;
      interaction("editing", editing);
    },
    onEditEnd: (groupId, tabId) => {
      if (tabId != null && ui.editTabId !== tabId) return;
      if (groupId != null && ui.editGroupId !== groupId) return;
      ui.editGroupId = null;
      ui.editTabId = null;
      interaction("editing", false);
    },
  };

  function buildGridView(options) {
    // Pending groups enter through place after fit, never at phantom first-free
    // spots or through fit's overlap repair, which may move a neighbour sideways.
    return buildView({ ...board, columns: board.columns.filter(group => !pendingTiles.has(group.id)) }, options);
  }

  function displayPending(next) {
    const metadata = new Map(next.tiles.map(tile => [tile.id, tile]));
    for (const [groupId, rect] of pendingTiles) {
      const group = board.columns.find(group => group.id === groupId);
      if (!group) continue;
      const folder = savedReply.folders?.[groupId], id = folder ? `group:${folder}` : `local:${groupId}`;
      metadata.set(id, { id, kind: "group", group });
      next.tiles = place(next.tiles, id, rect, next.cols);
    }
    const order = ["clock", "pinned", ...board.columns.map(group => savedReply.folders?.[group.id]
      ? `group:${savedReply.folders[group.id]}` : `local:${group.id}`), "saved"];
    next.tiles = next.tiles.map(tile => ({ ...metadata.get(tile.id), ...tile }))
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }

  function previewTiles(tiles) {
    const metadata = new Map(view.tiles.map(tile => [tile.id, tile]));
    view.tiles = tiles.map(tile => ({ ...metadata.get(tile.id), ...tile }));
    root.querySelector(".grid").style.setProperty("--cols", view.cols);
    root.querySelector(".rail").style.setProperty("--rail-cells", view.railCells);
    const shown = new Map(view.tiles.map(tile => [tile.id, tile]));
    for (const node of root.querySelectorAll(".tile")) {
      const tile = shown.get(node.dataset.tileId);
      node.style.gridColumn = `${tile.x + 1} / span ${tile.w}`;
      node.style.gridRow = `${tile.y + 1} / span ${tile.h}`;
    }
    updateScrollEdges(root);
  }

  const detachGridDrag = attachGridDrag(root, {
    view: () => view,
    canCommit: async tile => {
      try { await api.tabGroups.get(tile.group.id); return !unloaded; }
      catch { return false; }
    },
    onState: (active, id) => {
      if (active) draggedTileId = id;
      interaction("gridDragging", active);
      if (!active) draggedTileId = undefined;
    },
    onPreview: previewTiles,
    onCancel: () => { pendingView = true; },
    onCommit: changed => {
      const rectangles = changed.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));
      for (const tile of rectangles) {
        if (tile.id.startsWith("local:")) {
          const group = board.columns.find(group => tile.id === `local:${group.id}`);
          if (group) pendingTiles.set(group.id, tile);
        }
      }
      // An unmapped tile and its pushes follow the pending-placement write rule.
      if (draggedTileId?.startsWith("local:")) return;
      const writes = rectangles.filter(tile => !tile.id.startsWith("local:"));
      gridState.layout = [...new Map([...gridState.layout, ...writes].map(tile => [tile.id, tile])).values()];
      if (!writes.length || !gridState.writable || !hasValidSavedReply || !validFoldersReply(savedReply)) return;
      persistence = persistence.then(async () => {
        try { await saveTiles(api, writes); }
        finally { ++tileWriteVersion; }
      }).catch(() => {});
    },
    onRail: (cells, commit) => {
      view = buildGridView({ ...gridState, synced: { ...gridState.synced, railCells: cells },
        contentWidth: root.clientWidth, folders: savedReply.folders ?? {}, pending: new Map() });
      displayPending(view);
      previewTiles(view.tiles);
      if (!commit) return;
      gridState.synced = { ...gridState.synced, railCells: cells };
      persistence = persistence.then(async () => {
        try { await saveSetting(api, "synced", "railCells", cells); }
        finally { ++tileWriteVersion; }
      }).catch(() => {});
    },
  });

  watchStorage(api, () => {
    ++storageVersion;
    pendingGrid = true;
    enqueue();
  });
  window.addEventListener("resize", () => {
    if (!root.isConnected) return;
    pendingView = true;
    enqueue();
  });
  startClock(root, () => gridState?.synced);

  const onChange = () => schedule();
  window.addEventListener("pagehide", () => {
    unloaded = true;
    detachGridDrag();
    for (const id of deferredGroups.keys()) clearDeferredGroup(id);
  }, { once: true });

  const onGroupRemoved = group => {
    pendingTiles.delete(group.id);
    clearDeferredGroup(group.id);
    if (group.id === ui.editGroupId) releaseMissingEdit();
    schedule();
  };
  try {
    api.tabs.onUpdated.addListener(onChange, {
      properties: ["favIconUrl", "groupId", "hidden", "pinned", "title", "url"],
    });
  } catch (error) {
    console.warn("Foxy: filtered tab updates unavailable, listening to all updates", error);
    try { api.tabs.onUpdated.addListener(onChange); }
    catch (fallbackError) { console.warn("Foxy: could not listen to tab updates", fallbackError); }
    schedule();
  }
  for (const event of [api.tabs.onCreated, api.tabs.onRemoved,
    api.tabs.onMoved, api.tabs.onAttached, api.tabs.onDetached, api.tabs.onActivated,
    api.tabGroups.onCreated, api.tabGroups.onUpdated, api.tabGroups.onMoved, api.tabGroups.onRemoved,
    api.windows.onCreated, api.windows.onRemoved, api.windows.onFocusChanged]) {
    try { event?.addListener(event === api.tabGroups.onRemoved ? onGroupRemoved : onChange); }
    catch (error) {
      console.warn("Foxy: could not listen to board changes", error);
      schedule();
    }
  }
  for (const event of [api.bookmarks?.onCreated, api.bookmarks?.onChanged,
    api.bookmarks?.onMoved, api.bookmarks?.onRemoved, api.permissions?.onAdded, api.permissions?.onRemoved]) {
    try { event?.addListener(scheduleSaved); }
    catch (error) {
      console.warn("Foxy: could not listen to bookmark changes", error);
      scheduleSaved();
    }
  }
  // Opening the board reconciles once. The initial caller's refresh remains
  // independent, and completion (including failure) requests a fresh snapshot.
  (async () => {
    try {
      const reply = await api.runtime.sendMessage({ type: "foxy:reconcile" });
      if (reply?.ok !== true) console.warn("Foxy: background reconcile was not accepted");
    } catch (error) { console.warn("Foxy: could not reconcile on board open", error); }
    finally { schedule(); }
  })();
  return { refresh, schedule, handlers, ui, get view() { return view; } };
}

function rowsKey(list) {
  return `${list.dataset.zone}:${list.dataset.groupId ?? ""}`;
}

function captureView(root) {
  const active = document.activeElement;
  let focus;
  if (root.contains(active)) {
    const row = active.closest("[data-tab-id]");
    const group = active.closest(".column[data-group-id]");
    if (row) {
      const list = row.closest(".rows");
      focus = { tabId: row.dataset.tabId, className: active.className,
        rowsKey: rowsKey(list), index: [...list.querySelectorAll(".row")].indexOf(row) };
    } else if (active.matches(".rows")) focus = { rowsKey: rowsKey(active) };
    else if (active.matches(".grid")) focus = { grid: true };
    else if (group) focus = { groupId: group.dataset.groupId, className: active.className,
      index: [...root.querySelectorAll(".column[data-group-id]")].indexOf(group) };
  }
  return { focus, top: root.querySelector(".grid")?.scrollTop ?? 0,
    tops: new Map([...root.querySelectorAll(".rows")].map(list => [rowsKey(list), list.scrollTop])) };
}

function restoreView(root, { focus, top, tops }) {
  const editor = root.querySelector(".name-editor");
  if (focus && !editor) {
    let active;
    const list = [...root.querySelectorAll(".rows")].find(list => rowsKey(list) === focus.rowsKey);
    if (focus.grid) active = root.querySelector(".grid");
    else if (focus.tabId === undefined && focus.rowsKey !== undefined) active = list;
    else {
      const container = focus.tabId !== undefined
        ? [...root.querySelectorAll("[data-tab-id]")].find(row => row.dataset.tabId === focus.tabId)
        : [...root.querySelectorAll(".column[data-group-id]")].find(col => col.dataset.groupId === focus.groupId);
      active = container?.className === focus.className ? container
        : [...(container?.querySelectorAll("*") ?? [])].find(el => el.className === focus.className);
      if (!container && focus.tabId !== undefined) {
        const rows = [...(list?.querySelectorAll(".row") ?? [])];
        active = rows[Math.min(focus.index, rows.length - 1)]?.querySelector(".row-open") ?? list ?? root.querySelector(".grid");
      } else if (!container && focus.groupId !== undefined) {
        const columns = [...root.querySelectorAll(".column[data-group-id]")];
        const neighbour = columns[Math.min(focus.index, columns.length - 1)];
        active = [...(neighbour?.querySelectorAll("button, .rows") ?? [])]
          .find(el => el.className === focus.className) ?? neighbour?.querySelector(".rows") ?? root.querySelector(".grid");
      }
    }
    active?.focus({ preventScroll: true });
  }
  root.querySelector(".grid").scrollTop = top;
  for (const list of root.querySelectorAll(".rows")) list.scrollTop = tops.get(rowsKey(list)) ?? 0;
  // A new group's input can be below the old grid viewport.
  editor?.scrollIntoView({ block: "nearest", inline: "nearest" });
  updateScrollEdges(root);
}
