import { slotFromPointer, resolveTabTarget, resolveGroupTarget } from "./targets.js";

const TAB = "application/x-foxy-tab", GROUP = "application/x-foxy-group";
const bindings = new WeakMap();

/** Attach once; renders publish handlers and the snapshot for no-op feedback. */
export function attachDnd(root, handlers, board) {
  const existing = bindings.get(root);
  if (existing) { existing.handlers = handlers; existing.board = board; return; }
  const state = { handlers, board, dragging: false, suppressClick: false, source: null };
  bindings.set(root, state);
  let frame = 0, edge = 0, pointer, clickTimer = 0;

  function clearFeedback() {
    root.querySelectorAll(".drop-line").forEach(line => line.remove());
    root.querySelectorAll(".drop-target").forEach(column => column.classList.remove("drop-target"));
  }
  function stopScroll() {
    cancelAnimationFrame(frame);
    frame = 0; edge = 0; pointer = null;
  }
  function kindOf(transfer) {
    // Payloads are protected until drop in Firefox. Never getData on dragover.
    const types = Array.from(transfer?.types ?? []);
    if (types.includes(TAB)) return "tab";
    if (types.includes(GROUP)) return "group";
    return null;
  }
  function targetAt(kind, target) {
    if (!(target instanceof Element) || !root.contains(target) || target.closest('[data-zone="saved"]')) return null;
    if (kind === "tab") return target.closest('.rows[data-zone="group"], .rows[data-zone="pinned"], .rows[data-zone="tabs"], .new-group, .column-header, .column-title, .other-window');
    if (kind === "group" && !target.closest(".new-group, .fixed, .saved")) return target.closest(".strip");
    return null;
  }
  function dropZone(target) {
    return target.matches(".column-header, .column-title, .other-window")
      ? target.closest(".column").querySelector(".rows") : target;
  }
  function placement(kind, target, x, y) {
    const zone = dropZone(target);
    // Headings explicitly mean the start, even when the list is scrolled.
    if (zone !== target) return { slot: 0, offset: zone.scrollTop };
    if (target.classList.contains("new-group")) return { slot: 0 };
    const horizontal = kind === "group";
    const items = [...target.querySelectorAll(horizontal ? ":scope > .column.group" : ":scope > .row")];
    const rects = items.map(item => item.getBoundingClientRect());
    const slot = slotFromPointer(rects.map(r => horizontal ? (r.left + r.right) / 2 : (r.top + r.bottom) / 2), horizontal ? x : y);
    const before = rects[slot], after = rects[slot - 1], bounds = target.getBoundingClientRect();
    const start = horizontal ? "left" : "top", end = horizontal ? "right" : "bottom";
    const windowBoundary = !horizontal && before && after &&
      items[slot].dataset.windowId !== items[slot - 1].dataset.windowId;
    const coordinate = windowBoundary ? after.bottom
      : before && after ? (before[start] + after[end]) / 2
      : before ? before[start] : after ? after[end] : bounds[start];
    return { slot, offset: coordinate - bounds[start] + (horizontal ? target.scrollLeft : target.scrollTop) };
  }
  function feedback(kind, target, x, y) {
    clearFeedback();
    if (!target) return;
    const { slot, offset } = placement(kind, target, x, y);
    if (kind === "tab") target.closest(".column").classList.add("drop-target");
    if (target.classList.contains("new-group")) return;
    if (state.board && state.source?.kind === kind) {
      // windowOrder starts with the current window. Use the same resolver as
      // the controller: an adjacent remote boundary can still mean a move.
      const currentWindowId = state.board.windowOrder[0], id = state.source.id;
      const zone = dropZone(target);
      const resolved = kind === "group"
        ? resolveGroupTarget(state.board, id, slot, currentWindowId)
        : resolveTabTarget(state.board, { zone: zone.dataset.zone, groupId: Number(zone.dataset.groupId), slot, tabId: id }, currentWindowId);
      if (!resolved) return;
    }
    const line = document.createElement("div");
    line.className = "drop-line";
    line.setAttribute("aria-hidden", "true");
    if (kind === "group") { line.classList.add("vertical"); line.style.left = `${offset - 1}px`; }
    else line.style.top = `${Math.max(0, offset - 1)}px`;
    dropZone(target).append(line);
  }
  function scrollStep() {
    frame = 0;
    const strip = root.querySelector(".strip");
    if (!edge || !strip || !pointer || !root.isConnected) { stopScroll(); return; }
    const old = strip.scrollLeft;
    // Small per-frame steps keep edge scrolling smooth without repeatedly
    // restarting a browser smooth-scroll animation on every dragover.
    strip.scrollLeft += edge * 12;
    if (strip.scrollLeft !== old) {
      const target = document.elementFromPoint(pointer.x, pointer.y);
      feedback(pointer.kind, targetAt(pointer.kind, target), pointer.x, pointer.y);
    }
    frame = requestAnimationFrame(scrollStep);
  }
  function edgeScroll(kind, target, x, y) {
    const strip = root.querySelector(".strip");
    const bounds = strip?.getBoundingClientRect();
    if (!kind || !bounds || !strip.contains(target) || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) {
      stopScroll(); return;
    }
    const threshold = Math.min(48, bounds.width / 2);
    edge = x < bounds.left + threshold ? -1 : x > bounds.right - threshold ? 1 : 0;
    pointer = { x, y, kind };
    if (!edge) { stopScroll(); return; }
    if (!frame) frame = requestAnimationFrame(scrollStep);
  }

  root.addEventListener("dragstart", event => {
    const source = event.target.closest?.(".row, .column-header");
    if (!source || !root.contains(source) || !event.dataTransfer || event.target.closest("input, textarea") ||
        source.closest(".column")?.querySelector(".name-editor, .color-picker")) return;
    const row = source.matches(".row");
    const id = row ? source.dataset.tabId : source.closest(".column[data-group-id]")?.dataset.groupId;
    if (id === undefined) return;
    event.dataTransfer.setData(row ? TAB : GROUP, id);
    event.dataTransfer.effectAllowed = "move";
    source.classList.add("dragging");
    clearTimeout(clickTimer);
    state.source = { kind: row ? "tab" : "group", id: Number(id) };
    state.dragging = true; state.suppressClick = true;
    state.handlers.onDragState?.(true);
  });
  root.addEventListener("dragover", event => {
    const kind = kindOf(event.dataTransfer), target = targetAt(kind, event.target);
    feedback(kind, target, event.clientX, event.clientY);
    edgeScroll(kind, event.target, event.clientX, event.clientY);
    if (!target) { if (event.dataTransfer) event.dataTransfer.dropEffect = "none"; return; }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  });
  root.addEventListener("drop", event => {
    const kind = kindOf(event.dataTransfer), target = targetAt(kind, event.target);
    stopScroll(); clearFeedback();
    if (!target) return;
    event.preventDefault();
    const value = event.dataTransfer.getData(kind === "tab" ? TAB : GROUP);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return;
    const id = Number(value), { slot } = placement(kind, target, event.clientX, event.clientY);
    if (kind === "group") state.handlers.onGroupDrop?.(id, slot);
    else {
      const zone = dropZone(target);
      const drop = { zone: zone.dataset.zone, slot, tabId: id };
      if (zone.dataset.groupId !== undefined) drop.groupId = Number(zone.dataset.groupId);
      state.handlers.onTabDrop?.(id, drop);
    }
  });
  root.addEventListener("dragleave", event => {
    const kind = kindOf(event.dataTransfer), target = targetAt(kind, event.target);
    if (!target?.contains(event.relatedTarget)) clearFeedback();
    if (!root.querySelector(".strip")?.contains(event.relatedTarget)) stopScroll();
  });
  root.addEventListener("dragend", () => {
    stopScroll(); clearFeedback();
    root.querySelectorAll(".dragging").forEach(source => source.classList.remove("dragging"));
    if (!state.dragging) return;
    state.dragging = false; state.source = null;
    clickTimer = setTimeout(() => { state.suppressClick = false; }, 0);
    state.handlers.onDragState?.(false);
  });
  // Capture before row/close handlers: the click generated by a drag must
  // never activate a tab and close this page. A fresh pointerdown is deliberate.
  root.addEventListener("click", event => {
    if (!state.suppressClick) return;
    state.suppressClick = false;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  root.addEventListener("pointerdown", () => {
    if (!state.dragging) state.suppressClick = false;
  });
}
