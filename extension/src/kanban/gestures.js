import { clamp, widgetMinimum, headerHeight } from './layout.js';
import { scrollAtEdge } from './scroll.js';

const reorder = (ids, id, index) => {
  const next = ids.filter(value => value !== id);
  next.splice(clamp(index, 0, next.length), 0, id);
  return next;
};

// Move only the dragged item. Hidden widgets and not-yet-pruned groups retain
// their position relative to every item that did not move.
function moveAmong(base, peers, id, index) {
  const order = reorder(peers, id, index), result = [...new Set([...base, ...peers])].filter(value => value !== id);
  const slot = order.indexOf(id), before = order[slot + 1], after = order[slot - 1];
  const target = before !== undefined ? result.indexOf(before) : after !== undefined ? result.indexOf(after) + 1 : 0;
  result.splice(target, 0, id);
  return result;
}

/** Pointer state belongs to this page, not to the children replaced by a render. */
export function attachGestures(root, handlers) {
  let active, frame = 0, suppressClick = false;
  const listen = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    return () => target.removeEventListener(type, fn, options);
  };
  const nodeFor = id => [...root.querySelectorAll('.tile')].find(node => node.dataset.tileId === id);
  function scrollContainer() {
    const widgets = root.querySelector('.widgets');
    return active.widget ? widgets.closest('.kanban') ?? widgets : root.querySelector('.kanban');
  }
  function clear() {
    cancelAnimationFrame(frame); frame = 0;
    root.removeAttribute('data-layout-dragging');
    root.querySelectorAll('.layout-insertion').forEach(line => line.remove());
    root.querySelectorAll('.tile.dragging').forEach(tile => tile.classList.remove('dragging'));
  }
  function finish() { clear(); active = null; handlers.onState(false); }
  function cancel() {
    if (!active || active.committing) return;
    const moved = active.moved;
    handlers.onCancel(); finish();
    suppressClick ||= moved;
  }
  function indicate() {
    const gesture = active;
    const tiles = gesture.ids.map(id => nodeFor(id)).filter(Boolean);
    let nearest, distance = Infinity;
    for (const tile of tiles) {
      const box = tile.getBoundingClientRect();
      const dx = gesture.x - clamp(gesture.x, box.left, box.right), dy = gesture.y - clamp(gesture.y, box.top, box.bottom);
      const d = dx * dx + dy * dy;
      if (d < distance) { distance = d; nearest = { tile, box }; }
    }
    if (!nearest) return;
    const { tile, box } = nearest, index = gesture.ids.indexOf(tile.dataset.tileId);
    const after = gesture.y >= (box.top + box.bottom) / 2;
    const slot = index + Number(after), source = gesture.ids.indexOf(gesture.id);
    const targetIndex = slot - Number(source < slot);
    const draft = structuredClone(gesture.layout);
    if (gesture.widget) {
      const items = new Map(draft.widgets.map(w => [w.kind, w]));
      draft.widgets = moveAmong([...items.keys()], gesture.ids, gesture.id, targetIndex).map(id => items.get(id));
    } else {
      const all = [...new Set([...draft.order, ...gesture.view.tiles.map(t => t.id)])];
      draft.order = moveAmong(all, gesture.ids, gesture.id, targetIndex);
    }
    gesture.draft = draft;
    const container = scrollContainer(), origin = container.getBoundingClientRect();
    root.querySelectorAll('.layout-insertion').forEach(node => node.remove());
    const line = document.createElement('div'); line.className = 'layout-insertion'; line.setAttribute('aria-hidden', 'true');
    Object.assign(line.style, { left: `${box.left - origin.left}px`, width: `${box.width}px`,
      top: `${(after ? box.bottom + 7 : box.top - 9) - origin.top + container.scrollTop}px` });
    // Widgets normally stack in a scroller; position the line in that scroller.
    container.append(line);
  }
  function preview() {
    const g = active;
    if (g.mode === 'bar') {
      const delta = (g.x - g.startX) * (g.bar === 'railWidth' ? -1 : 1);
      const value = Math.round(clamp(g.initial + delta, 240, Math.floor(root.getBoundingClientRect().width / 3)));
      g.widths = { [g.bar]: value };
      handlers.onPreview(g.layout, g.widths);
    } else if (g.mode === 'height') {
      const delta = g.y - g.startY + scrollContainer().scrollTop - g.scrollTop;
      const draft = structuredClone(g.layout);
      if (g.widget) {
        const h = Math.max(widgetMinimum(g.id, g.density), Math.round(g.height + delta));
        if (h !== g.height) draft.widgets.find(w => w.kind === g.id).h = h;
      } else {
        const rows = clamp(Math.round((g.height + delta - g.header) / g.row), 2, 40);
        if (g.header + rows * g.row !== g.height) draft.heights[g.id] = rows;
      }
      g.draft = draft;
      handlers.onPreview(draft);
    } else indicate();
  }
  function edgeStep() {
    frame = 0;
    if (!active || !active.moved || active.committing || active.mode === 'bar' || !root.isConnected) return;
    if (scrollAtEdge(scrollContainer(), active.y)) { preview(); frame = requestAnimationFrame(edgeStep); }
  }
  function move(event) {
    const g = active;
    if (!g || g.committing || event.pointerId !== g.pointerId) return;
    g.x = event.clientX; g.y = event.clientY;
    if (!g.moved && Math.hypot(g.x - g.startX, g.y - g.startY) < 4) return;
    g.moved = true; suppressClick = true;
    root.setAttribute('data-layout-dragging', '');
    if (g.mode === 'order') nodeFor(g.id)?.classList.add('dragging');
    event.preventDefault(); preview();
    if (!frame && g.mode !== 'bar') frame = requestAnimationFrame(edgeStep);
  }
  async function release(event) {
    const g = active;
    if (!g || g.committing || event.pointerId !== g.pointerId) return;
    if (!g.moved) { finish(); return; }
    g.committing = true; cancelAnimationFrame(frame); frame = 0;
    const changed = g.mode === 'bar' ? g.widths[g.bar] !== g.initial : JSON.stringify(g.draft) !== JSON.stringify(g.layout);
    try {
      if (changed && (!g.group || await handlers.canCommit(g.group.id))) {
        await handlers.onCommit(g.draft ?? g.layout, g.widths);
      } else handlers.onCancel();
    } catch (error) {
      console.warn('Foxy: could not save layout gesture', error); handlers.onCancel();
    } finally { finish(); }
  }
  function press(event) {
    if (active || event.button !== 0 || !event.isPrimary || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !handlers.canStart()) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest('input, textarea, .color-picker, .name-editor')) return;
    const state = handlers.state(), bar = target.closest('.bar-resize');
    const tile = target.closest('.tile'), entry = tile && [...state.view.widgets, ...state.view.tiles].find(t => t.id === tile.dataset.tileId);
    if (!bar && !entry) return;
    const heightHandle = target.closest('.tile-resize');
    if (!bar && !heightHandle) {
      if (entry.kind === 'group' ? !target.closest('.column-header') || target.closest('.dot, .column-close, .bring-here')
        : target.closest('button, a, .row:not(.pin-icon), .memory-sites, .weather-hours')) return;
    }
    const widget = !!entry && entry.kind !== 'group';
    const peers = widget ? state.view.widgets : state.view.tiles.filter(t => t.group.current === entry?.group.current);
    const initial = bar ? (bar.dataset.bar === 'widgetsWidth' ? state.view.page.widgets : state.view.page.rail) : null;
    active = { ...state, layout: structuredClone(state.layout), id: entry?.id, group: entry?.group, widget,
      ids: peers.map(t => t.id), pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, moved: false, committing: false,
      mode: bar ? 'bar' : heightHandle ? 'height' : 'order', bar: bar?.dataset.bar, initial,
      height: entry?.height, header: headerHeight(state.density, entry?.group && !entry.group.current), row: state.density === 'compact' ? 24 : 32 };
    active.scrollTop = bar ? 0 : scrollContainer().scrollTop;
    handlers.onState(true);
    if (bar || heightHandle) event.preventDefault();
  }
  async function keyboard(event) {
    if (event.key === 'Escape' && active && !active.committing) { event.preventDefault(); cancel(); return; }
    if (active || !root.contains(event.target) || !handlers.canStart()) return;
    const header = event.target.matches('.column-header') && event.target;
    const step = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[event.key];
    if (!header || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || step === undefined || event.isComposing) return;
    event.preventDefault();
    const state = handlers.state(), id = header.closest('.tile').dataset.tileId, source = state.view.tiles.find(t => t.id === id);
    const ids = state.view.tiles.filter(t => t.group.current === source.group.current).map(t => t.id), index = ids.indexOf(id);
    if (index + step < 0 || index + step >= ids.length) return;
    const base = [...new Set([...state.layout.order, ...state.view.tiles.map(t => t.id)])];
    const draft = { ...state.layout, order: moveAmong(base, ids, id, index + step) };
    handlers.onState(true);
    try { if (await handlers.canCommit(source.group.id)) await handlers.onCommit(draft); }
    catch (error) { console.warn('Foxy: could not move group', error); handlers.onCancel(); }
    finally { handlers.onState(false); }
  }
  async function resetHeight(event) {
    const tile = event.target.closest('.kanban-tile');
    if (!event.target.closest('.tile-resize') || !tile || active || !handlers.canStart()) return;
    const state = handlers.state(), id = tile.dataset.tileId;
    if (!Object.hasOwn(state.layout.heights, id)) return;
    event.preventDefault(); const draft = structuredClone(state.layout); delete draft.heights[id];
    handlers.onState(true);
    try {
      const source = state.view.tiles.find(t => t.id === id);
      if (await handlers.canCommit(source.group.id)) await handlers.onCommit(draft);
    } catch (error) { console.warn('Foxy: could not reset group height', error); handlers.onCancel(); }
    finally { handlers.onState(false); }
  }
  const detach = [listen(root, 'pointerdown', press), listen(document, 'pointermove', move, { passive: false }),
    listen(document, 'pointerup', release), listen(document, 'pointercancel', cancel), listen(document, 'keydown', keyboard),
    listen(root, 'dblclick', resetHeight), listen(window, 'blur', cancel),
    listen(root, 'click', event => {
      if (!suppressClick) return;
      suppressClick = false; event.preventDefault(); event.stopImmediatePropagation();
    }, true), listen(root, 'pointerdown', () => { if (!active) suppressClick = false; }, true)];
  return () => { cancel(); for (const stop of detach) stop(); clear(); };
}
