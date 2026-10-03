import { GAP, place, clampRect, changedTiles, railLimits, minSize } from "./layout.js";
import { scrollAtEdge } from "./scroll.js";

/** onPreview receives changed rectangles; the controller builds display geometry
 * without replacing the captured node. onRail's second argument marks release;
 * onState holds board updates from pointer down through the final slide. */
export function attachGridDrag(root, { view, canCommit, onPreview, onCommit, onCancel, onRail, onState }) {
  let drag = null, ending = false, frame = 0, suppressClick = false, clickTimer = 0;
  let detached = false;
  const geometry = ["left", "top", "width", "height", "transform"];

  function contentPoint(grid, { clientX, clientY }) {
    const bounds = grid.getBoundingClientRect(), style = getComputedStyle(grid);
    return { x: clientX - bounds.left - (parseFloat(style.paddingLeft) || 0) + grid.scrollLeft,
      y: clientY - bounds.top - (parseFloat(style.paddingTop) || 0) + grid.scrollTop };
  }

  function activate() {
    root.setAttribute("data-grid-dragging", "");
    if (drag.kind === "rail") return;
    drag.grid.classList.add("gesturing");
    drag.grid.addEventListener("scroll", preview, { passive: true });
    drag.node.classList.add("dragging");
    const step = drag.before.cell + GAP, tile = drag.tile;
    for (const [key, value] of Object.entries({ left: tile.x * step, top: tile.y * step,
      width: tile.w * step - GAP, height: tile.h * step - GAP })) drag.node.style[key] = `${value}px`;
    const outline = document.createElement("div");
    outline.className = "drop-outline";
    outline.setAttribute("aria-hidden", "true");
    drag.grid.append(outline);
    drag.outline = outline;
    // Establish the starting positions before preview targets can transition.
    drag.node.getBoundingClientRect();
    preview();
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
    const left = point.x - drag.offset.x, top = point.y - drag.offset.y;
    const width = point.x + drag.offset.x - tile.x * step;
    const height = point.y + drag.offset.y - tile.y * step;
    if (kind === "move") {
      drag.node.style.transform = `translate(${left - tile.x * step}px, ${top - tile.y * step}px)`;
    } else {
      const min = minSize(tile.kind);
      drag.node.style.width = `${Math.min((before.cols - tile.x) * step - GAP,
        Math.max(Math.min(min.w, before.cols) * step - GAP, width))}px`;
      drag.node.style.height = `${Math.max(min.h * step - GAP, height)}px`;
    }
    const target = clampRect(tile.id, kind === "move" ? { ...tile,
      x: Math.round(left / step), y: Math.round(top / step) }
      : { ...tile, w: Math.round((width + GAP) / step), h: Math.round((height + GAP) / step) }, before.cols);
    if (drag.target && ["x", "y", "w", "h"].every(key => target[key] === drag.target[key])) return;
    drag.target = target;
    for (const key of ["x", "y", "w", "h"]) drag.outline.style.setProperty(`--${key}`, target[key]);
    const placed = place(before.tiles, tile.id, target, before.cols);
    drag.changed = changedTiles(before.tiles, placed);
    // The controller builds previews through the same placement path as release.
    onPreview(drag.changed);
  }

  function scrollStep() {
    frame = 0;
    if (!drag?.active || drag.kind === "rail" || !root.isConnected) return;
    const old = drag.grid.scrollTop;
    if (!scrollAtEdge(drag.grid, drag.pointer.clientY)) return;
    if (old !== drag.grid.scrollTop) preview();
    frame = requestAnimationFrame(scrollStep);
  }

  function waitForSlides(grid) {
    const pending = new Map();
    for (const node of grid.querySelectorAll(":scope > .tile")) {
      const properties = new Set(node.getAnimations().map(animation => animation.transitionProperty)
        .filter(property => geometry.includes(property)));
      if (properties.size) pending.set(node, properties);
    }
    if (!pending.size) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); grid.removeEventListener("transitionend", end); resolve(); };
      const end = event => {
        const properties = pending.get(event.target);
        if (!properties?.delete(event.propertyName)) return;
        if (!properties.size) pending.delete(event.target);
        if (!pending.size) done();
      };
      const timer = setTimeout(done, 300);
      grid.addEventListener("transitionend", end);
    });
  }

  async function settle(ended, commit) {
    const { grid, node } = ended;
    if (!commit) onPreview([]);
    node.classList.add("sliding");
    node.classList.remove("dragging");
    for (const key of geometry) node.style.removeProperty(key);
    if (!detached && root.isConnected) {
      await waitForSlides(grid);
    }
    grid.classList.remove("settling");
    node.classList.remove("sliding");
    ended.outline?.remove();
  }

  async function finish(commit) {
    if (!drag) return;
    const ended = drag;
    ended.grid.removeEventListener("scroll", preview);
    drag = null;
    ending = true;
    cancelAnimationFrame(frame); frame = 0;
    root.removeAttribute("data-grid-dragging");
    if (ended.active && ended.kind !== "rail") ended.grid.classList.add("settling");
    ended.grid.classList.remove("gesturing");
    // Implicit release can deliver lostpointercapture after pointerup. Clear
    // the gesture first so it cannot cancel an already committed placement.
    if (ended.source.hasPointerCapture(ended.pointerId)) ended.source.releasePointerCapture(ended.pointerId);
    suppressClick = ended.active || !commit;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { suppressClick = false; }, 0);
    try {
      if (ended.active) {
        if (commit && ended.tile?.group) commit = await canCommit(ended.tile);
        commit &&= !detached;
        if (commit) {
          if (ended.kind === "rail") {
            if (ended.cells !== ended.before.railCells) onRail(ended.cells, true);
          } else onCommit(ended.changed);
        } else {
          if (ended.kind === "rail") onRail(ended.before.railCells, false);
          onCancel();
        }
        // Save at release; only held board renders wait for the visual slide.
        if (ended.kind !== "rail") await settle(ended, commit);
      }
    } finally { ending = false; onState?.(false, ended.tile?.id); }
  }

  function down(event) {
    if (!root.isConnected || drag || ending || event.button !== 0 || event.isPrimary === false || root.querySelector(".name-editor, .color-picker") || root.hasAttribute("data-dragging")) return;
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
    if (drag.active) { event.preventDefault(); activate(); }
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
      activate();
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
  window.addEventListener("resize", blur);
  document.addEventListener("visibilitychange", visibility);
  return () => {
    detached = true;
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
    window.removeEventListener("resize", blur);
    document.removeEventListener("visibilitychange", visibility);
  };
}
