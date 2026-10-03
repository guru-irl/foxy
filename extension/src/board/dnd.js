import { slotFromPointer, resolveTabTarget } from "./targets.js";
import { scrollAtEdge } from "../grid/scroll.js";
import { GAP, clampRect, defaultSize } from "../grid/layout.js";

const TAB = "application/x-foxy-tab";
const bindings = new WeakMap();

/** Attach once; renders publish handlers and the snapshot for no-op feedback. */
export function attachDnd(root, handlers, board) {
  const existing = bindings.get(root);
  if (existing) { existing.handlers = handlers; existing.board = board; return; }
  const state = { handlers, board, dragging: false, suppressClick: false, source: null };
  bindings.set(root, state);
  let clickTimer = 0, frame = 0, pointer = null;

  function clearFeedback() {
    root.querySelectorAll(".drop-line, .cell-preview").forEach(line => line.remove());
    root.querySelectorAll(".drop-target").forEach(tile => tile.classList.remove("drop-target"));
  }
  function stopScroll() {
    cancelAnimationFrame(frame);
    frame = 0;
    pointer = null;
  }
  function scrollStep() {
    frame = 0;
    if (!pointer || !root.isConnected) { stopScroll(); return; }
    const { element, x, y } = pointer, old = element.scrollTop;
    if (!element.isConnected || !scrollAtEdge(element, y)) { stopScroll(); return; }
    if (element.scrollTop !== old) feedback(targetAt(document.elementFromPoint(x, y), x, y), x, y);
    frame = requestAnimationFrame(scrollStep);
  }
  function edgeScroll(event) {
    const target = event.target;
    const element = target instanceof Element && root.contains(target)
      ? target.closest(".rail")?.querySelector(".rows") ?? target.closest(".grid") : null;
    const bounds = element?.getBoundingClientRect();
    const { clientX: x, clientY: y } = event;
    if (!accepts(event.dataTransfer) || !bounds || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) {
      stopScroll(); return;
    }
    pointer = { element, x, y };
    if (!frame) frame = requestAnimationFrame(scrollStep);
  }
  function accepts(transfer) {
    // Payloads are protected until drop in Firefox. Never getData on dragover.
    return Array.from(transfer?.types ?? []).includes(TAB);
  }
  function targetAt(target, x, y) {
    if (!(target instanceof Element) || !root.contains(target)) return null;
    let tile = target.closest(".tile");
    if (!tile && !target.closest(".rail")) {
      const grid = target.closest(".grid");
      if (!grid) return null;
      const { col, row } = cellPlacement(grid, x, y);
      tile = [...grid.querySelectorAll(":scope > .tile")].find(tile => {
        const left = Number(tile.style.getPropertyValue("--x")), top = Number(tile.style.getPropertyValue("--y"));
        const width = Number(tile.style.getPropertyValue("--w"));
        const height = Number(tile.style.getPropertyValue("--h"));
        return col >= left && col < left + width && row >= top && row < top + height;
      });
      if (!tile) return grid;
      target = tile.querySelector(".rows") ?? tile;
    }
    if (tile && !tile.matches('[data-kind="group"], [data-kind="pinned"]')) return null;
    const column = tile ?? target.closest(".rail");
    return target.closest(".rows, .column-header, .column-title, .other-window") ?? column;
  }
  function cellPlacement(grid, x, y) {
    const style = getComputedStyle(grid), bounds = grid.getBoundingClientRect();
    const cell = parseFloat(style.getPropertyValue("--cell")), cols = Number(style.getPropertyValue("--cols"));
    const left = parseFloat(style.paddingLeft) || 0, top = parseFloat(style.paddingTop) || 0;
    const col = Math.max(0, Math.min(cols - 1, Math.floor((x - bounds.left - left + grid.scrollLeft) / (cell + GAP))));
    const row = Math.max(0, Math.floor((y - bounds.top - top + grid.scrollTop) / (cell + GAP)));
    const targetCell = parseFloat(style.getPropertyValue("--cell-target"));
    const { id, ...rect } = clampRect("group:new", { x: col, y: row, ...defaultSize("group", targetCell, cols) }, cols);
    return { rect, cell, left, top, col, row };
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
  function feedback(target, x, y) {
    clearFeedback();
    if (!target) return;
    if (target.matches(".grid")) {
      const { rect, cell, left, top } = cellPlacement(target, x, y);
      const preview = document.createElement("div");
      preview.className = "cell-preview";
      preview.setAttribute("aria-hidden", "true");
      Object.assign(preview.style, { left: `${left + rect.x * (cell + GAP)}px`,
        top: `${top + rect.y * (cell + GAP)}px`, width: `${rect.w * (cell + GAP) - GAP}px`,
        height: `${rect.h * (cell + GAP) - GAP}px` });
      target.append(preview);
      return;
    }
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
    edgeScroll(event);
    const target = accepts(event.dataTransfer) ? targetAt(event.target, event.clientX, event.clientY) : null;
    feedback(target, event.clientX, event.clientY);
    if (!target) { if (event.dataTransfer) event.dataTransfer.dropEffect = "none"; return; }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  });
  root.addEventListener("drop", event => {
    stopScroll();
    const target = accepts(event.dataTransfer) ? targetAt(event.target, event.clientX, event.clientY) : null;
    clearFeedback();
    if (!target) return;
    event.preventDefault();
    const value = event.dataTransfer.getData(TAB);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return;
    const id = Number(value);
    if (target.matches(".grid")) {
      state.handlers.onTabDrop?.(id, { zone: "cell", tabId: id,
        rect: cellPlacement(target, event.clientX, event.clientY).rect });
      return;
    }
    const { slot } = placement(target, event.clientY), zone = dropZone(target);
    const drop = { zone: zone.dataset.zone, slot, tabId: id };
    if (zone.dataset.groupId !== undefined) drop.groupId = Number(zone.dataset.groupId);
    state.handlers.onTabDrop?.(id, drop);
  });
  root.addEventListener("dragleave", event => {
    if (pointer && !pointer.element.contains(event.relatedTarget)) stopScroll();
    const target = accepts(event.dataTransfer) ? targetAt(event.target, event.clientX, event.clientY) : null;
    if (!target?.contains(event.relatedTarget)) clearFeedback();
  });
  root.addEventListener("dragend", () => {
    stopScroll();
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
