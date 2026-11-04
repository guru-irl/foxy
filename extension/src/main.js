import { createMemoryController } from "./tiles/memory.js";
import { msUntilNextMinute } from "./model.js";
import { showPinnedTooltip } from "./tiles/pinned.js";
import { buildBoard } from "./board/model.js";
import { renderBoard, updateScrollEdges, updateClock, positionTiles } from "./board/render.js";
import { resolveTabTarget } from "./board/targets.js";
import { openTab, closeTabs, closeGroup, bringGroupHere, renameGroup, recolorGroup,
  dropTab } from "./board/moves.js";

import { buildView } from './kanban/view.js';
import { createBoardStore } from './kanban/store.js';
import { renderSettings, settingActions, resetLayout } from './settings/pane.js';
import { loadSettings, saveSetting, cardAlpha } from "./settings/store.js";
import { startWeather } from "./tiles/weather.js";
export { renderTime, updateClock } from "./board/render.js";

function validFoldersReply(reply) {
  return reply?.ok !== false && Array.isArray(reply?.saved) && Array.isArray(reply?.missing) &&
    reply.folders !== null && typeof reply.folders === "object" && !Array.isArray(reply.folders) &&
    Object.values(reply.folders).every(id => typeof id === "string" && id.length > 0);
}

const root = document.getElementById("board");
// Only the real page gets network and location; tests inject their own or none.
if (root) createController(root, globalThis.browser, undefined, {
  weather: { fetch: globalThis.fetch.bind(globalThis), geolocation: navigator.geolocation },
}).refresh();

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
  { maxWait = 30000, weather = null } = {}) {
  const memory = createMemoryController(root, api);
  ui.confirmFolderId ??= null;
  ui.layoutDragging ??= false;
  ui.busy ??= new Set();
  let board;
  let view;
  let layoutState;
  let layoutRead;
  let storageVersion = 0;
  let loadedVersion = -1;
  let pendingLayout = false;
  let pendingView = false;
  let hasSavedReply = false;
  let hasValidSavedReply = false;
  let firstPaintReady = false;
  let firstPaintTimer = 0;
  let persistence = Promise.resolve();
  const boardStore = createBoardStore(api);
  const settingsPane = root.parentElement?.querySelector(":scope > .settings-pane");
  const paneHandlers = settingActions(api, async () => {
    await persistence;
    await resetLayout(api);
  }, weather?.fetch);
  const page = root.parentElement?.matches(".page") ? root.parentElement : root;
  const pageWidth = () => page.getBoundingClientRect().width;
  const gear = () => root.querySelector(".settings-gear");
  function setPaneOpen(open) {
    if (!settingsPane) return;
    settingsPane.hidden = !open;
    gear()?.setAttribute("aria-expanded", String(open));
    if (open) settingsPane.querySelector("button, input")?.focus({ preventScroll: true });
    else gear()?.focus({ preventScroll: true });
  }
  root.addEventListener("click", event => {
    if (event.target.closest(".settings-gear")) setPaneOpen(settingsPane?.hidden);
  });
  window.addEventListener("keydown", event => {
    if (!event.defaultPrevented && event.key === "Escape" && root.isConnected && settingsPane && !settingsPane.hidden) {
      event.preventDefault(); setPaneOpen(false);
    }
  });
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
  const held = () => actionsInFlight > 0 || ui.dragging || ui.layoutDragging || ui.editing || ui.editGroupId != null;
  // An editor holds board reads/renders, but must not hide its own removal.
  const canCheckEdit = () => actionsInFlight === 0 && !ui.dragging && !ui.layoutDragging && (ui.editGroupId != null || ui.editTabId != null);
  function releaseMissingEdit() {
    ui.editGroupId = null;
    ui.editTabId = null;
    ui.editing = false;
    ++generation;
  }

  // Reads are independent of tab snapshots, and never publish across a gesture.
  async function readLayout() {
    if (layoutState && loadedVersion === storageVersion) return true;
    if (!layoutRead) {
      const version = storageVersion;
      layoutRead = (async () => {
        await persistence;
        const layout = await boardStore.load();
        const settings = await loadSettings(api);
        return { layout, ...settings, version, writable: true };
      })().catch(error => {
        console.warn('Foxy: could not read board layout', error);
        return layoutState ? { ...layoutState, writable: false, version } : null;
      });
    }
    const next = await layoutRead; layoutRead = null;
    if (!next) return false;
    if (held() || next.version !== storageVersion) { pendingLayout = true; enqueue(); return false; }
    layoutState = next; loadedVersion = next.version; pendingLayout = false;
    return true;
  }

  async function refreshLayout() {
    if (await readLayout()) {
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
      if (!await readLayout()) { pending = true; return; }
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
      const nextBoard = buildBoard({ ...nextSnapshot, ...savedReply, otherWindows: layoutState.synced.otherWindows });
      snapshot = nextSnapshot;
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

  function liveIds() {
    return new Set([...Object.values(savedReply.folders ?? {}).map(id => `group:${id}`),
      ...board.saved.map(g => `group:${g.folderId}`), ...board.missing.map(g => `group:${g.folderId}`)]);
  }

  function publish() {
    if (ui.layoutDragging) { pendingView = true; return; }
    if (!board || !layoutState || !firstPaintReady) return;
    board = buildBoard({ ...snapshot, ...savedReply, otherWindows: layoutState.synced.otherWindows });
    const synced = weather ? layoutState.synced : { ...layoutState.synced, showWeather: false };
    view = buildView(board, { board: layoutState.layout, synced, device: layoutState.device,
      contentWidth: pageWidth(), folders: savedReply.folders ?? {} });
    pendingView = false;
    const key = JSON.stringify({ board, view, settings: layoutState.synced, device: layoutState.device,
      ui: { ...ui, busy: [...ui.busy].sort() } });
    if (key !== lastRenderedKey) {
      const saved = captureView(root);
      root.style.setProperty('--card-alpha-dark', cardAlpha(layoutState.synced.transparency, 'dark'));
      root.style.setProperty('--card-alpha-light', cardAlpha(layoutState.synced.transparency, 'light'));
      root.style.setProperty('--row', layoutState.device.density === 'compact' ? '24px' : '32px');
      renderBoard(root, board, view, ui, handlers, layoutState.synced);
      memory.update();
      gear()?.setAttribute('aria-expanded', String(settingsPane ? !settingsPane.hidden : false));
      if (settingsPane?.id) gear()?.setAttribute('aria-controls', settingsPane.id);
      restoreView(root, saved);
      lastRenderedKey = key;
      if (hasValidSavedReply) boardStore.observe(liveIds());
    }
    if (settingsPane) renderSettings(settingsPane, { synced: layoutState.synced, device: layoutState.device }, paneHandlers);
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
      if ((held() && !(pending && canCheckEdit())) || (!pending && !pendingSaved && !pendingLayout && !pendingView)) return;
      if (pending) refresh(retryQueued);
      else if (pendingLayout) refreshLayout();
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
    } else if (pending || pendingSaved || pendingLayout || pendingView) enqueue();
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
      pinsMoveHere: layoutState.synced.pinsMoveHere })),
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
        if (result.ok && result.groupId != null) requestedEditGroupId = result.groupId;
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

  api.storage.onChanged.addListener((changes, area) => {
    if (!root.isConnected) return;
    if ((area === 'sync' && ('board' in changes || 'settings' in changes)) ||
        (area === 'local' && 'deviceSettings' in changes)) {
      ++storageVersion; pendingLayout = true; enqueue();
    }
  });
  window.addEventListener("resize", () => {
    if (!root.isConnected) return;
    pendingView = true;
    enqueue();
  });
  startClock(root, () => layoutState?.synced);
  const weatherLoop = weather && startWeather(root, { api, ...weather,
    settings: () => layoutState && { synced: layoutState.synced, device: layoutState.device } });

  const onChange = () => schedule();
  window.addEventListener("pagehide", () => {
    unloaded = true;
    memory.stop();
    weatherLoop?.stop();
  }, { once: true });

  const onGroupRemoved = group => {
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
    const tip = active.closest('[data-pin-tooltip]');
    const row = active.closest("[data-tab-id]") ?? (tip && [...root.querySelectorAll('.pin-icon')]
      .find(row => row.dataset.tabId === tip.dataset.pinTooltip));
    const group = active.closest(".column[data-group-id]");
    const memoryRow = active.closest('[data-kind="memory"] .memory-row');
    if (memoryRow) {
      focus = { memoryHost: memoryRow.dataset.host,
        index: [...memoryRow.parentElement.querySelectorAll('.memory-row')].indexOf(memoryRow) };
    } else if (row) {
      const list = row.closest(".rows");
      focus = { tabId: row.dataset.tabId, className: active.className,
        rowsKey: rowsKey(list), index: [...list.querySelectorAll(".row")].indexOf(row) };
    } else if (active.matches(".rows")) focus = { rowsKey: rowsKey(active) };
    else if (active.matches(".kanban")) focus = { kanban: true };
    else if (active.matches(".settings-gear")) focus = { gear: true };
    else if (active.closest(".weather")) focus = { weather: active.className };
    else if (group) focus = { groupId: group.dataset.groupId, className: active.className,
      index: [...root.querySelectorAll(".column[data-group-id]")].indexOf(group) };
  }
  return { focus, top: root.querySelector(".kanban")?.scrollTop ?? 0, widgetsTop: root.querySelector(".widgets")?.scrollTop ?? 0,
    tops: new Map([...root.querySelectorAll(".rows")].map(list => [rowsKey(list), list.scrollTop])) };
}

function restoreView(root, { focus, top, widgetsTop, tops }) {
  const editor = root.querySelector(".name-editor");
  if (focus && !editor) {
    let active;
    const list = [...root.querySelectorAll(".rows")].find(list => rowsKey(list) === focus.rowsKey);
    if (focus.memoryHost !== undefined) {
      const sites = root.querySelector('[data-kind="memory"] .memory-sites');
      const rows = [...(sites?.querySelectorAll('.memory-row') ?? [])];
      const row = rows.find(row => row.dataset.host === focus.memoryHost) ?? rows[Math.min(focus.index, rows.length - 1)];
      active = row?.querySelector('.memory-unload') ?? sites ?? root.querySelector('.kanban');
    } else if (focus.gear) active = root.querySelector(".settings-gear");
    else if (focus.weather !== undefined) {
      active = [...root.querySelectorAll(".weather button, .weather [tabindex]")].find(node => node.className === focus.weather);
    }
    else if (focus.kanban) active = root.querySelector(".kanban");
    else if (focus.tabId === undefined && focus.rowsKey !== undefined) active = list;
    else {
      const container = focus.tabId !== undefined
        ? [...root.querySelectorAll("[data-tab-id]")].find(row => row.dataset.tabId === focus.tabId)
        : [...root.querySelectorAll(".column[data-group-id]")].find(col => col.dataset.groupId === focus.groupId);
      if (focus.className === 'pin-allow' && container) {
        const tip = [...root.querySelectorAll('[data-pin-tooltip]')].find(tip => tip.dataset.pinTooltip === focus.tabId);
        showPinnedTooltip(tip);
        active = tip?.querySelector('.pin-allow') ?? container.querySelector('.row-open');
      } else active = container?.className === focus.className ? container
        : [...(container?.querySelectorAll("*") ?? [])].find(el => el.className === focus.className);
      if (!container && focus.tabId !== undefined) {
        const rows = [...(list?.querySelectorAll(".row") ?? [])];
        active = rows[Math.min(focus.index, rows.length - 1)]?.querySelector(".row-open") ?? list ?? root.querySelector(".kanban");
      } else if (!container && focus.groupId !== undefined) {
        const columns = [...root.querySelectorAll(".column[data-group-id]")];
        const neighbour = columns[Math.min(focus.index, columns.length - 1)];
        active = [...(neighbour?.querySelectorAll("button, .rows") ?? [])]
          .find(el => el.className === focus.className) ?? neighbour?.querySelector(".rows") ?? root.querySelector(".kanban");
      }
    }
    active?.focus({ preventScroll: true });
  }
  root.querySelector(".kanban").scrollTop = top;
  root.querySelector(".widgets").scrollTop = widgetsTop;
  for (const list of root.querySelectorAll(".rows")) list.scrollTop = tops.get(rowsKey(list)) ?? 0;
  // A new group's input can be below the old grid viewport.
  editor?.scrollIntoView({ block: "nearest", inline: "nearest" });
  updateScrollEdges(root);
}
