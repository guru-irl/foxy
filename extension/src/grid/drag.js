import { GAP, place, fit, clampRect, changedTiles, railLimits } from "./layout.js";
import { scrollAtEdge } from "./scroll.js";

/** Previews keep the captured DOM node alive. onRail's second argument marks
 * release; onState holds board updates from pointer down through completion. */
export function attachGridDrag(root, { view, canCommit, onPreview, onCommit, onCancel, onRail, onState }) {
  let drag = null, ending = false, frame = 0, suppressClick = false, clickTimer = 0;

  function contentPoint(grid, { clientX, clientY }) {
    const bounds = grid.getBoundingClientRect(), style = getComputedStyle(grid);
    return { x: clientX - bounds.left - (parseFloat(style.paddingLeft) || 0) + grid.scrollLeft,
      y: clientY - bounds.top - (parseFloat(style.paddingTop) || 0) + grid.scrollTop };
  }

  function preview() {
    const { before, pointer, kind } = drag;
    if (kind === "rail") {
      const limits = railLimits(before.total);
      drag.cells = Math.max(limits.min, Math.min(limits.max,
        Math.round((drag.right - pointer.clientX + GAP) / (before.cell + GAP))));
      onRail(drag.cells, false);
      return;
    }
    const step = before.cell + GAP, point = contentPoint(drag.grid, pointer), tile = drag.tile;
    const rect = kind === "move" ? { ...tile,
      x: Math.round((point.x - drag.offset.x) / step), y: Math.round((point.y - drag.offset.y) / step) }
      : { ...tile, w: Math.round((point.x + drag.offset.x + GAP) / step) - tile.x,
        h: Math.round((point.y + drag.offset.y + GAP) / step) - tile.y };
    const placed = place(before.tiles, tile.id, clampRect(tile.id, rect, before.cols), before.cols);
    drag.changed = changedTiles(before.tiles, placed);
    // Fit-only moves are for display, never part of the committed change set.
    // Keep shown rectangles as fallbacks for tiles without a saved place.
    const saved = new Map(before.tiles.map(tile => [tile.id, tile]));
    for (const tile of before.saved) if (saved.has(tile.id)) saved.set(tile.id, tile);
    for (const tile of drag.changed) saved.set(tile.id, tile);
    onPreview(fit([...saved.values()], before.cols));
  }

  function scrollStep() {
    frame = 0;
    if (!drag?.active || drag.kind === "rail" || !root.isConnected) return;
    const old = drag.grid.scrollTop;
    if (!scrollAtEdge(drag.grid, drag.pointer.clientY)) return;
    if (old !== drag.grid.scrollTop) preview();
    frame = requestAnimationFrame(scrollStep);
  }

  async function finish(commit) {
    if (!drag) return;
    const ended = drag;
    drag = null;
    ending = true;
    cancelAnimationFrame(frame); frame = 0;
    root.removeAttribute("data-grid-dragging");
    ended.node?.classList.remove("tile-lifted");
    // Implicit release can deliver lostpointercapture after pointerup. Clear
    // the gesture first so it cannot cancel an already committed placement.
    if (ended.source.hasPointerCapture(ended.pointerId)) ended.source.releasePointerCapture(ended.pointerId);
    suppressClick = ended.active || !commit;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { suppressClick = false; }, 0);
    try {
      if (ended.active) {
        if (commit && ended.tile?.group) commit = await canCommit(ended.tile);
        if (commit) {
          if (ended.kind === "rail") {
            if (ended.cells !== ended.before.railCells) onRail(ended.cells, true);
          } else onCommit(ended.changed);
        } else {
          if (ended.kind === "rail") onRail(ended.before.railCells, false);
          else onPreview(ended.before.tiles);
          onCancel();
        }
      }
    } finally { ending = false; onState?.(false, ended.tile?.id); }
  }

  function down(event) {
    if (drag || ending || event.button !== 0 || event.isPrimary === false || root.querySelector(".name-editor, .color-picker") || root.hasAttribute("data-dragging")) return;
    clearTimeout(clickTimer);
    suppressClick = false;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const rail = target.closest(".rail-resize"), handle = target.closest(".tile-resize");
    const header = target.closest(".column-header, .column-title, .tile-header");
    const node = target.closest(".tile");
    if (!rail && (!node || (!handle && (!header || target.closest("input, textarea, button:not(.group-name)"))))) return;
    const current = view();
    if (!current) return;
    const tile = current.tiles.find(tile => tile.id === node?.dataset.tileId);
    if (!rail && !tile) return;
    const grid = root.querySelector(".grid"), step = current.cell + GAP, point = contentPoint(grid, event);
    const kind = rail ? "rail" : handle ? "resize" : "move";
    drag = { kind, node, source: target, grid, tile, pointerId: event.pointerId,
      before: { ...current, tiles: current.tiles.map(tile => ({ ...tile })) }, changed: [],
      pointer: { clientX: event.clientX, clientY: event.clientY }, start: { x: event.clientX, y: event.clientY },
      offset: tile && (kind === "move" ? { x: point.x - tile.x * step, y: point.y - tile.y * step }
        : { x: (tile.x + tile.w) * step - GAP - point.x, y: (tile.y + tile.h) * step - GAP - point.y }),
      right: root.querySelector(".rail").getBoundingClientRect().right, cells: current.railCells, active: kind !== "move" };
    onState?.(true, tile?.id);
    // Synthetic PointerEvents have no active native pointer. The real gesture
    // captures here; document listeners also handle cancellation and test events.
    try { target.setPointerCapture(event.pointerId); } catch {}
    if (drag.active) {
      event.preventDefault();
      root.setAttribute("data-grid-dragging", "");
      node?.classList.add("tile-lifted");
    }
  }

  function move(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (event.type === "pointermove" && event.pointerType === "mouse" && !(event.buttons & 1)) {
      finish(false); return;
    }
    drag.pointer = { clientX: event.clientX, clientY: event.clientY };
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) <= 4) return;
      drag.active = true;
      root.setAttribute("data-grid-dragging", "");
      drag.node.classList.add("tile-lifted");
    }
    event.preventDefault();
    preview();
    if (drag.kind !== "rail" && !frame) frame = requestAnimationFrame(scrollStep);
  }
  function up(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.active) { move(event); event.preventDefault(); }
    finish(true);
  }
  function cancel(event) { if (drag && event.pointerId === drag.pointerId) finish(false); }
  function blur() { finish(false); }
  function visibility() { if (document.hidden) finish(false); }
  function key(event) {
    if (!drag || event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation(); finish(false);
  }
  function click(event) {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault(); event.stopImmediatePropagation();
  }
  root.addEventListener("pointerdown", down);
  root.addEventListener("click", click, true);
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", cancel);
  document.addEventListener("lostpointercapture", cancel);
  document.addEventListener("keydown", key, true);
  window.addEventListener("blur", blur);
  document.addEventListener("visibilitychange", visibility);
  return () => {
    finish(false);
    clearTimeout(clickTimer);
    root.removeEventListener("pointerdown", down);
    root.removeEventListener("click", click, true);
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", cancel);
    document.removeEventListener("lostpointercapture", cancel);
    document.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", blur);
    document.removeEventListener("visibilitychange", visibility);
  };
}
