import { slotFromPointer, resolveTabTarget } from "./targets.js";

const TAB = "application/x-foxy-tab";
const bindings = new WeakMap();

/** Attach once; renders publish handlers and the snapshot for no-op feedback. */
export function attachDnd(root, handlers, board) {
  const existing = bindings.get(root);
  if (existing) { existing.handlers = handlers; existing.board = board; return; }
  const state = { handlers, board, dragging: false, suppressClick: false, source: null };
  bindings.set(root, state);
  let clickTimer = 0;

  function clearFeedback() {
    root.querySelectorAll(".drop-line").forEach(line => line.remove());
    root.querySelectorAll(".drop-target").forEach(tile => tile.classList.remove("drop-target"));
  }
  function accepts(transfer) {
    // Payloads are protected until drop in Firefox. Never getData on dragover.
    return Array.from(transfer?.types ?? []).includes(TAB);
  }
  function targetAt(target) {
    if (!(target instanceof Element) || !root.contains(target)) return null;
    const column = target.closest('.tile[data-kind="group"], .tile[data-kind="pinned"], .rail');
    if (!column) return null;
    return target.closest(".rows, .column-header, .column-title, .other-window") ?? column;
  }
  function dropZone(target) {
    return target.matches(".rows") ? target : target.closest(".column").querySelector(".rows");
  }
  function placement(target, y) {
    const zone = dropZone(target);
    // Headings and card padding mean the start, even when the list is scrolled.
    if (zone !== target) return { slot: 0, offset: zone.scrollTop };
    const items = [...target.querySelectorAll(":scope > .row")];
    const rects = items.map(item => item.getBoundingClientRect());
    const slot = slotFromPointer(rects.map(r => (r.top + r.bottom) / 2), y);
    const before = rects[slot], after = rects[slot - 1], bounds = target.getBoundingClientRect();
    const windowBoundary = before && after && items[slot].dataset.windowId !== items[slot - 1].dataset.windowId;
    const coordinate = windowBoundary ? after.bottom
      : before && after ? (before.top + after.bottom) / 2
      : before ? before.top : after ? after.bottom : bounds.top;
    return { slot, offset: coordinate - bounds.top + target.scrollTop };
  }
  function feedback(target, y) {
    clearFeedback();
    if (!target) return;
    const { slot, offset } = placement(target, y);
    target.closest(".column").classList.add("drop-target");
    const zone = dropZone(target);
    if (state.board && state.source != null) {
      const resolved = resolveTabTarget(state.board, { zone: zone.dataset.zone,
        groupId: Number(zone.dataset.groupId), slot, tabId: state.source }, state.board.windowOrder[0]);
      if (!resolved) return;
    }
    const line = document.createElement("div");
    line.className = "drop-line";
    line.setAttribute("aria-hidden", "true");
    line.style.top = `${Math.max(0, offset - 1)}px`;
    zone.append(line);
  }

  root.addEventListener("dragstart", event => {
    const source = event.target.closest?.(".row");
    if (!source || !root.contains(source) || !event.dataTransfer || event.target.closest("input, textarea") ||
        source.closest(".column")?.querySelector(".name-editor, .color-picker")) return;
    const id = source.dataset.tabId;
    if (id === undefined) return;
    event.dataTransfer.setData(TAB, id);
    event.dataTransfer.effectAllowed = "move";
    source.classList.add("dragging");
    clearTimeout(clickTimer);
    state.source = Number(id);
    state.dragging = true; state.suppressClick = true;
    root.toggleAttribute("data-dragging", true);
    state.handlers.onDragState?.(true);
  });
  root.addEventListener("dragover", event => {
    const target = accepts(event.dataTransfer) ? targetAt(event.target) : null;
    feedback(target, event.clientY);
    if (!target) { if (event.dataTransfer) event.dataTransfer.dropEffect = "none"; return; }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  });
  root.addEventListener("drop", event => {
    const target = accepts(event.dataTransfer) ? targetAt(event.target) : null;
    clearFeedback();
    if (!target) return;
    event.preventDefault();
    const value = event.dataTransfer.getData(TAB);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return;
    const id = Number(value), { slot } = placement(target, event.clientY), zone = dropZone(target);
    const drop = { zone: zone.dataset.zone, slot, tabId: id };
    if (zone.dataset.groupId !== undefined) drop.groupId = Number(zone.dataset.groupId);
    state.handlers.onTabDrop?.(id, drop);
  });
  root.addEventListener("dragleave", event => {
    const target = accepts(event.dataTransfer) ? targetAt(event.target) : null;
    if (!target?.contains(event.relatedTarget)) clearFeedback();
  });
  root.addEventListener("dragend", () => {
    clearFeedback();
    root.querySelectorAll(".dragging").forEach(source => source.classList.remove("dragging"));
    if (!state.dragging) return;
    state.dragging = false; state.source = null;
    root.toggleAttribute("data-dragging", false);
    clickTimer = setTimeout(() => { state.suppressClick = false; }, 0);
    state.handlers.onDragState?.(false);
  });
  // Capture before row/close handlers: a post-drag click must not open a tab.
  root.addEventListener("click", event => {
    if (!state.suppressClick) return;
    state.suppressClick = false;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  root.addEventListener("pointerdown", () => {
    if (!state.dragging) state.suppressClick = false;
  });
}
