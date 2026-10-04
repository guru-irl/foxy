import { mergeTiles } from "./layouts.js";
import { buildView } from "./view.js";
import { place } from "./layout.js";

const localGroup = tile => tile.id.startsWith("local:") ? Number(tile.id.slice(6)) : null;

/** Release snapshots survive width changes, but never target eviction or Reset. */
export class PendingLayoutWrites {
  targets = new Map();
  capture({ k, writes }) {
    if (!writes.some(tile => localGroup(tile) !== null) && !this.targets.has(k)) return;
    this.targets.set(k, mergeTiles(this.targets.get(k) ?? [], writes)
      .map(({ id, x, y, w, h }) => ({ id, x, y, w, h })));
  }
  resolve(folders, checking = new Set()) {
    const batches = new Map(), groups = new Set();
    for (const [k, tiles] of this.targets) {
      if (checking.has(k)) continue;
      let mapped = false;
      const next = tiles.map(tile => {
        const group = localGroup(tile), folder = folders[group];
        if (group === null || !folder) return tile;
        mapped = true; groups.add(group); return { ...tile, id: `group:${folder}` };
      });
      if (!mapped) continue;
      batches.set(k, next.filter(tile => localGroup(tile) === null));
      if (next.some(tile => localGroup(tile) !== null)) this.targets.set(k, next);
      else this.targets.delete(k);
    }
    return { batches, groups };
  }
  removeGroup(group) {
    for (const [k, tiles] of this.targets) {
      const next = tiles.filter(tile => localGroup(tile) !== group);
      if (next.some(tile => localGroup(tile) !== null)) this.targets.set(k, next);
      else this.targets.delete(k);
    }
  }
  discard(k) { this.targets.delete(k); }
  clear() { this.targets.clear(); }
}

export const pendingPlacement = (tile, before, k) => ({ ...tile, k, sourceK: before.k, cols: before.cols });
const active = (rect, view) => rect.k === view.k || (rect.sourceK === view.k && rect.cols === view.cols);

export function buildPendingView(board, options, pending) {
  const view = buildView(board, options);
  const ids = new Set([...pending].filter(([, rect]) => active(rect, view)).map(([id]) => id));
  if (!ids.size) return view;
  // Pick the source before excluding pending groups; their rectangles enter via
  // place after fit, never through first-free placement or overlap repair.
  const layouts = options.layouts[view.k] ? { [view.k]: options.layouts[view.k] } : {};
  return buildView({ ...board, columns: board.columns.filter(group => !ids.has(group.id)) }, { ...options, layouts });
}

export function showPending(board, folders, next, pending) {
  const metadata = new Map(next.tiles.map(tile => [tile.id, tile]));
  for (const [groupId, rect] of pending) {
    const group = board.columns.find(group => group.id === groupId);
    if (!group || !active(rect, next)) continue;
    const id = folders[groupId] ? `group:${folders[groupId]}` : `local:${groupId}`;
    metadata.set(id, { id, kind: "group", group });
    next.tiles = place(next.tiles, id, rect, next.cols);
  }
  const order = ["clock", "pinned", ...board.columns.map(group => folders[group.id] ? `group:${folders[group.id]}` : `local:${group.id}`), "saved", "memory", "weather"];
  next.tiles = next.tiles.map(tile => ({ ...metadata.get(tile.id), ...tile }))
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}
