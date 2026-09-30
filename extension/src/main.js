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
  let board;
  let self;
  let generation = 0;
  let queued = false;
  let pending = false;
  let retryQueued = true;
  const held = () => ui.dragging || ui.editing;

  async function refresh(retry = true) {
    if (held()) { pending = true; return; }
    const mine = ++generation;
    try {
      const [windows, tabs, groups, current] = await Promise.all([
        api.windows.getAll({ windowTypes: ["normal"] }), api.tabs.query({}),
        api.tabGroups.query({}), api.tabs.getCurrent(),
      ]);
      if (held()) { pending = true; return; }
      if (mine !== generation) return;
      self = current;
      board = buildBoard({ windows, tabs, groups, currentWindowId: self.windowId,
        selfTabId: self.id, selfUrl: location.origin + location.pathname });
      const saved = captureView(root);
      renderBoard(root, board, ui, handlers);
      restoreView(root, saved);
      pending = false;
    } catch (error) {
      console.warn("Foxy: could not refresh board", error);
      // One bounded retry re-reads after a transient API error. Further events
      // can retry again, without a permanent failure creating a frame loop.
      if (retry) schedule(false);
    }
  }

  function schedule(retry = true) {
    pending = true;
    if (held()) return;
    if (queued) { retryQueued ||= retry; return; }
    queued = true;
    retryQueued = retry;
    requestAnimationFrame(() => {
      queued = false;
      if (held()) return;
      refresh(retryQueued);
    });
  }

  function interaction(key, active) {
    ui[key] = active;
    if (active) { ++generation; pending = true; }
    else if (!held() && pending) schedule();
  }

  async function action(run) {
    try { return await run(); }
    catch (error) { console.warn("Foxy: board action failed", error); }
    finally { await refresh(); }
  }

  const handlers = {
    onOpen: row => action(() => openTab(api, row, self, { close: history.length === 1 })),
    onCloseTab: tabId => action(() => closeTabs(api, [tabId])),
    onCloseGroup: groupId => action(() => closeGroup(api, groupId)),
    onBringHere: groupId => action(() => bringGroupHere(api, groupId, self.windowId)),
    onRename: (groupId, title) => action(() => renameGroup(api, groupId, title)),
    onRecolor: (groupId, color) => action(() => recolorGroup(api, groupId, color)),
    onTabDrop: (tabId, drop) => action(async () => {
      const target = resolveTabTarget(board, { ...drop, tabId }, self.windowId);
      const result = await dropTab(api, tabId, target);
      if (result.ok && result.groupId != null) ui.editGroupId = result.groupId;
      return result;
    }),
    onGroupDrop: (groupId, slot) => action(() =>
      dropGroup(api, groupId, resolveGroupTarget(board, groupId, slot, self.windowId))),
    onDragState: dragging => interaction("dragging", dragging),
    onEditState: editing => interaction("editing", editing),
    onEditEnd: () => {
      ui.editGroupId = null;
      interaction("editing", false);
    },
  };

  const onChange = () => schedule();
  for (const event of [api.tabs.onCreated, api.tabs.onRemoved, api.tabs.onUpdated,
    api.tabs.onMoved, api.tabs.onAttached, api.tabs.onDetached, api.tabs.onActivated,
    api.tabGroups.onCreated, api.tabGroups.onUpdated, api.tabGroups.onMoved, api.tabGroups.onRemoved,
    api.windows.onCreated, api.windows.onRemoved, api.windows.onFocusChanged]) {
    event?.addListener(onChange);
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
    if (row) focus = { tabId: row.dataset.tabId, className: active.className };
    else if (group) focus = { groupId: group.dataset.groupId, className: active.className };
  }
  return { focus, left: root.querySelector(".strip")?.scrollLeft ?? 0,
    tops: new Map([...root.querySelectorAll(".rows")].map(list => [rowsKey(list), list.scrollTop])) };
}

function restoreView(root, { focus, left, tops }) {
  if (focus) {
    const container = focus.tabId !== undefined
      ? [...root.querySelectorAll("[data-tab-id]")].find(row => row.dataset.tabId === focus.tabId)
      : [...root.querySelectorAll(".column[data-group-id]")].find(col => col.dataset.groupId === focus.groupId);
    const active = container?.className === focus.className ? container
      : [...(container?.querySelectorAll("*") ?? [])].find(el => el.className === focus.className);
    active?.focus({ preventScroll: true });
  }
  root.querySelector(".strip").scrollLeft = left;
  for (const list of root.querySelectorAll(".rows")) list.scrollTop = tops.get(rowsKey(list)) ?? 0;
}
