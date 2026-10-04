import { fit, arrangement, firstFree, changedTiles, gestureWrites, kindOf, minSize } from "./layout.js";

export function validTileId(id) {
  return ["clock", "pinned", "saved", "memory"].includes(id) || (id.startsWith("group:") && id.length > 6);
}
export function validTileRect(rect) {
  return rect !== null && typeof rect === "object" && !Array.isArray(rect)
    && ["x", "y", "w", "h"].every(key => Number.isInteger(rect[key])
      && rect[key] >= (key === "x" || key === "y" ? 0 : 1) && rect[key] <= 10000);
}
export const mergeTiles = (saved, writes) => [...new Map([...saved, ...writes].map(tile => [tile.id, tile])).values()];
export function withWrites(layouts, k, writes) {
  if (!writes.length) return layouts;
  const layout = layouts[k] ?? { lastWriteMs: 0, tiles: [] };
  return { ...layouts, [k]: { ...layout, tiles: mergeTiles(layout.tiles, writes) } };
}
const rectangle = ({ x, y, w, h }) => ({ x, y, w, h });
const bounds = tiles => {
  const x = Math.min(...tiles.map(t => t.x)), y = Math.min(...tiles.map(t => t.y));
  return { x, y, w: Math.max(...tiles.map(t => t.x + t.w)) - x,
    h: Math.max(...tiles.map(t => t.y + t.h)) - y };
};

function keepOrSqueeze(normal, c) {
  const kept = arrangement(normal, c);
  if (!kept.aside.length) return kept.tiles;
  const edge = Math.max(...normal.map(t => t.x + t.w));
  const boundary = b => Math.round(b * c / edge);
  const squeezed = normal.map(t => ({ ...t, x: boundary(t.x), w: boundary(t.x + t.w) - boundary(t.x) }));
  if (squeezed.every((t, i) => t.w >= minSize(kindOf(t.id)).w && t.w >= Math.round(0.7 * normal[i].w))) {
    return squeezed;
  }
  return null;
}

export const keepsOrSqueezes = (tiles, k, c) => keepOrSqueeze(fit(tiles, k), c) !== null;

/** Derive a display only. Keep, then squeeze, otherwise pack whole stacks. */
export function derive(tiles, k, c) {
  const normal = fit(tiles, k), fitted = keepOrSqueeze(normal, c);
  if (fitted) return fitted;
  const stacks = [];
  for (const tile of [...normal].sort((a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id))) {
    const stack = stacks.at(-1);
    if (stack && tile.x < stack.edge) {
      stack.tiles.push(tile); stack.edge = Math.max(stack.edge, tile.x + tile.w);
    } else stacks.push({ tiles: [tile], edge: tile.x + tile.w });
  }
  const boxes = [], result = new Map();
  for (const stack of stacks) {
    let members = stack.tiles, box = bounds(members);
    if (box.w > c) {
      members = fit(members.map(t => ({ ...t, x: t.x - box.x, y: t.y - box.y })), c);
      box = bounds(members);
    }
    const spot = firstFree(boxes, box, c);
    boxes.push({ ...spot, w: box.w, h: box.h });
    for (const tile of members) result.set(tile.id, { ...tile, x: tile.x - box.x + spot.x, y: tile.y - box.y + spot.y });
  }
  return normal.map(tile => result.get(tile.id));
}

export function sourceLayout(layouts, c, qualifies = k => keepsOrSqueezes(layouts[k].tiles, k, c)) {
  const widths = Object.keys(layouts).map(Number).filter(k => Number.isInteger(k) && k > 0);
  if (widths.includes(c)) return c;
  const wider = widths.filter(k => k > c).sort((a, b) => a - b);
  const fitting = wider.find(qualifies);
  if (fitting !== undefined) return fitting;
  const smaller = widths.filter(k => k < c);
  return smaller.length ? Math.max(...smaller) : wider[0] ?? c;
}

/** Every visible rectangle goes into a new target; existing targets keep per-tile writes. */
export function targetLayout(shown, saved, placed, k, c) {
  if (!changedTiles(shown, placed).length) return { k, writes: [] };
  const target = k > c || (k < c && placed.some(t => t.x + t.w > k)) ? c : k;
  return { k: target, writes: target === k ? gestureWrites(shown, saved, placed) : placed };
}

export function migrateLegacy(entries) {
  const legacy = Object.entries(entries).filter(([key, rect]) =>
    key.startsWith("tile:") && validTileId(key.slice(5)) && validTileRect(rect));
  if (!legacy.length) return null;
  const tiles = legacy.map(([key, rect]) => ({ id: key.slice(5), ...rectangle(rect) }));
  return { k: Math.max(...tiles.map(t => t.x + t.w)), tiles, keys: legacy.map(([key]) => key) };
}
