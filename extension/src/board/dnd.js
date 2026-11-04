import { pinnedPlacement } from "../tiles/pinned.js";
import { slotFromPointer, resolveTabTarget } from "./targets.js";
import { scrollAtEdge } from "../kanban/scroll.js";

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
    root.querySelectorAll(".drop-line, .kanban-drop").forEach(line => line.remove());
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
    const { element, fallback, band = 48, x, y, scrollY = y } = pointer;
    if (!element.isConnected || !(scrollAtEdge(element, scrollY, band) ||
        (fallback?.isConnected && scrollAtEdge(fallback, y)))) { stopScroll(); return; }
    feedback(targetAt(document.elementFromPoint(x, y), x, y), x, y);
    frame = requestAnimationFrame(scrollStep);
  }
  function edgeScroll(event) {
    const target = event.target;
    const element = target instanceof Element && root.contains(target)
      ? target.closest(".pinned-grid") ?? target.closest(".rail")?.querySelector(".rows") ?? target.closest(".kanban") : null;
    const bounds = element?.getBoundingClientRect();
    const rail = element?.closest(".rail"), area = rail?.getBoundingClientRect() ?? bounds;
    const { clientX: x, clientY: y } = event;
    if (!accepts(event.dataTransfer) || !bounds || x < area.left || x > area.right || y < bounds.top || y > area.bottom) {
      stopScroll(); return;
    }
    // Keep the actual pointer for hit testing, but scroll the footer like the list's bottom edge.
    const pinned = element.matches('.pinned-grid');
    pointer = { element, x, y, scrollY: rail ? Math.min(y, bounds.bottom - 1) : y,
      band: pinned ? Math.min(12, bounds.height / 4) : 48, fallback: pinned ? target.closest('.kanban') ?? target.closest('.widgets') : null };
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
      const grid = target.closest(".kanban");
      if (!grid) return null;
      if (target.closest('.widgets')) return null;
      tile = [...grid.querySelectorAll('.kanban-tile')].find(tile => {
        const box = tile.getBoundingClientRect();
        return x >= box.left && x < box.right && y >= box.top && y < box.bottom;
      });
      if (!tile) return grid;
      target = tile.querySelector(".rows") ?? tile;
    }
    if (tile && !tile.matches('[data-kind="group"], [data-kind="pinned"]')) return null;
    const column = tile ?? target.closest(".rail");
    return target.closest(".rows, .column-header, .column-title, .other-window") ?? column;
  }
  function dropZone(target) {
    return target.matches(".rows") ? target : target.closest(".column").querySelector(".rows");
  }
  function placement(target, x, y) {
    const zone = dropZone(target);
    if (zone !== target) {
      // The rail footer beside the gear means the visible end of the list.
      const bottom = zone.getBoundingClientRect().bottom;
      if (target.closest(".rail") && y >= bottom) return placement(zone, x, bottom - 1);
      // Headings and card padding mean the start, even when the list is scrolled.
      return { slot: 0, offset: zone.scrollTop };
    }
    if (zone.matches(".pinned-grid")) return pinnedPlacement(zone, x, y);
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
    if (target.matches(".kanban")) {
      const line = document.createElement('div'); line.className = 'drop-line kanban-drop';
      line.setAttribute('aria-hidden', 'true');
      const box = target.getBoundingClientRect();
      Object.assign(line.style, { left: '8px', right: '8px', top: `${y - box.top + target.scrollTop}px` });
      target.append(line);
      return;
    }
    const { slot, offset, left } = placement(target, x, y);
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
    line.style.top = `${Math.max(0, offset - (left === undefined ? 1 : 0))}px`;
    if (left !== undefined) line.style.left = `${left}px`;
    zone.append(line);
  }

  root.addEventListener("dragstart", event => {
    const source = event.target.closest?.(".row");
    if (!source || !root.contains(source) || !event.dataTransfer || event.target.closest("input, textarea") ||
        source.closest(".column")?.querySelector(".name-editor, .color-picker") ||
        (source.closest(".pinned") && root.querySelector(".pin-name-editor"))) return;
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
    if (target.matches(".kanban")) {
      state.handlers.onTabDrop?.(id, { zone: "kanban", tabId: id });
      return;
    }
    const { slot } = placement(target, event.clientX, event.clientY), zone = dropZone(target);
    const drop = { zone: zone.dataset.zone, slot, tabId: id };
    if (zone.dataset.groupId !== undefined) drop.groupId = Number(zone.dataset.groupId);
    state.handlers.onTabDrop?.(id, drop);
  });
  root.addEventListener("dragleave", event => {
    if (pointer && !(pointer.element.closest(".rail") ?? pointer.element).contains(event.relatedTarget)) stopScroll();
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
