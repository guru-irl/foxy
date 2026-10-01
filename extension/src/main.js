import { formatDate, formatTime, msUntilNextMinute } from "./model.js";
import { buildBoard } from "./board/model.js";
import { renderBoard } from "./board/render.js";
import { resolveTabTarget, resolveGroupTarget } from "./board/targets.js";
import { openTab, closeTabs, closeGroup, bringGroupHere, renameGroup, recolorGroup,
  dropTab, dropGroup } from "./board/moves.js";

const root = document.getElementById("board");
if (root) {
  startClock(document.getElementById("time"), document.getElementById("date"));
  createController(root, globalThis.browser).refresh();
}

// Updates on each minute boundary, and again whenever the page becomes visible,
// because Firefox throttles timers in background tabs.
function startClock(timeEl, dateEl) {
  let timer = 0;
  const tick = () => {
    const now = new Date();
    timeEl.textContent = formatTime(now);
    dateEl.textContent = formatDate(now);
    clearTimeout(timer);
    timer = setTimeout(tick, msUntilNextMinute(now));
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tick();
  });
  tick();
}

/** All board interactions share this state; DnD and editors set it via handlers. */
export function createController(root, api, ui = { editGroupId: null, dragging: false, editing: false }) {
  ui.confirmFolderId ??= null;
  ui.busy ??= new Set();
  let board;
  let self;
  let generation = 0;
  let queued = false;
  let pending = false;
  let retryQueued = true;
  let lastRenderedKey;
  let actionsInFlight = 0;
  let requestedEditGroupId = null;
  const held = () => actionsInFlight > 0 || ui.dragging || ui.editing || ui.editGroupId != null;
  // An editor holds board reads/renders, but must not hide its own removal.
  const canCheckEdit = () => actionsInFlight === 0 && !ui.dragging && ui.editGroupId != null;
  function releaseMissingEdit() {
    ui.editGroupId = null;
    ui.editing = false;
    ++generation;
  }

  async function refresh(retry = true) {
    try {
      if (held()) {
        pending = true;
        if (!canCheckEdit()) return;
        const editId = ui.editGroupId, editGeneration = generation;
        const groups = await api.tabGroups.query({});
        // Do not let an older existence check end a newer interaction.
        if (generation !== editGeneration || ui.editGroupId !== editId || !canCheckEdit() ||
            groups.some(group => group.id === editId)) return;
        releaseMissingEdit();
      }
      const mine = ++generation;
      pending = false;
      const [windows, tabs, groups, current] = await Promise.all([
        api.windows.getAll({ windowTypes: ["normal"] }), api.tabs.query({}),
        api.tabGroups.query({}), api.tabs.getCurrent(),
      ]);
      if (held()) { pending = true; return; }
      if (mine !== generation) { pending = true; return; }
      const nextBoard = buildBoard({ windows, tabs, groups, currentWindowId: current.windowId,
        selfTabId: current.id, selfUrl: location.origin + location.pathname });
      self = current;
      board = nextBoard;
      // Introduce a newly created column/editor in the final action snapshot.
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
    }
  }

  function publish() {
    if (!board) return;
    // JSON.stringify(Set) is {}, so serialize its folder IDs explicitly.
    const key = JSON.stringify({ board, ui: { ...ui, busy: [...ui.busy].sort() } });
    if (key === lastRenderedKey) return;
    const saved = captureView(root);
    renderBoard(root, board, ui, handlers);
    restoreView(root, saved);
    lastRenderedKey = key;
  }

  function schedule(retry = true) {
    pending = true;
    if (held() && !canCheckEdit()) return;
    if (queued) { retryQueued ||= retry; return; }
    queued = true;
    retryQueued = retry;
    requestAnimationFrame(() => {
      queued = false;
      if ((held() && !canCheckEdit()) || !pending) return;
      refresh(retryQueued);
    });
  }

  function interaction(key, active) {
    ui[key] = active;
    if (active) { ++generation; pending = true; }
    else if ((!held() || canCheckEdit()) && pending) schedule();
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

  const handlers = {
    onConfirmDelete: folderId => {
      if (ui.confirmFolderId === folderId) return;
      ui.confirmFolderId = folderId;
      if (held()) pending = true;
      else publish();
    },
    onOpen: row => action(() => openTab(api, row, self, { close: history.length === 1 })),
    onCloseTab: tabId => action(() => closeTabs(api, [tabId], self?.id)),
    onCloseGroup: groupId => action(() => closeGroup(api, groupId, self?.id)),
    onBringHere: groupId => action(() => bringGroupHere(api, groupId, self.windowId)),
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
    onGroupDrop: (groupId, slot) => {
      if (!board?.columns.some(column => column.id === groupId)) {
        console.debug("Foxy: ignored drop of a group not on the board", groupId);
        return;
      }
      return action(() => dropGroup(api, groupId, resolveGroupTarget(board, groupId, slot, self.windowId)));
    },
    onDragState: dragging => interaction("dragging", dragging),
    onEditState: (editing, groupId) => {
      if (editing && groupId != null) ui.editGroupId = groupId;
      interaction("editing", editing);
    },
    onEditEnd: groupId => {
      if (groupId != null && ui.editGroupId !== groupId) return;
      ui.editGroupId = null;
      pending = true;
      interaction("editing", false);
    },
  };

  const onChange = () => schedule();
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
  return { refresh, schedule, handlers, ui };
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
    else if (active.matches(".strip")) focus = { strip: true };
    else if (group) focus = { groupId: group.dataset.groupId, className: active.className,
      index: [...root.querySelectorAll(".column[data-group-id]")].indexOf(group) };
  }
  return { focus, left: root.querySelector(".strip")?.scrollLeft ?? 0,
    tops: new Map([...root.querySelectorAll(".rows")].map(list => [rowsKey(list), list.scrollTop])) };
}

function restoreView(root, { focus, left, tops }) {
  const editor = root.querySelector(".name-editor");
  if (focus && !editor) {
    let active;
    const list = [...root.querySelectorAll(".rows")].find(list => rowsKey(list) === focus.rowsKey);
    if (focus.strip) active = root.querySelector(".strip");
    else if (focus.tabId === undefined && focus.rowsKey !== undefined) active = list;
    else {
      const container = focus.tabId !== undefined
        ? [...root.querySelectorAll("[data-tab-id]")].find(row => row.dataset.tabId === focus.tabId)
        : [...root.querySelectorAll(".column[data-group-id]")].find(col => col.dataset.groupId === focus.groupId);
      active = container?.className === focus.className ? container
        : [...(container?.querySelectorAll("*") ?? [])].find(el => el.className === focus.className);
      if (!container && focus.tabId !== undefined) {
        const rows = [...(list?.querySelectorAll(".row") ?? [])];
        active = rows[Math.min(focus.index, rows.length - 1)]?.querySelector(".row-open") ?? list ?? root.querySelector(".strip");
      } else if (!container && focus.groupId !== undefined) {
        const columns = [...root.querySelectorAll(".column[data-group-id]")];
        const neighbour = columns[Math.min(focus.index, columns.length - 1)];
        active = [...(neighbour?.querySelectorAll("button, .rows") ?? [])]
          .find(el => el.className === focus.className) ?? neighbour?.querySelector(".rows") ?? root.querySelector(".strip");
      }
    }
    active?.focus({ preventScroll: true });
  }
  root.querySelector(".strip").scrollLeft = left;
  for (const list of root.querySelectorAll(".rows")) list.scrollTop = tops.get(rowsKey(list)) ?? 0;
  // A new group's input can be beyond the old horizontal viewport.
  editor?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
