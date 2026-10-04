import { fitCell, railLimits, addMissing, defaultSize, fit } from "./layout.js";
import { derive, sourceLayout, keepsOrSqueezes } from "./layouts.js";
import { cellPx } from "../settings/store.js";

/** Pure display geometry. Hidden and closed tiles keep their saved keys only. */
export function buildView(board, { layouts, synced, device, contentWidth, folders = {} }) {
  const targetCell = cellPx(device);
  const { cell, total } = fitCell(contentWidth, targetCell);
  const limits = railLimits(total);
  const railCells = Math.max(limits.min, Math.min(limits.max, synced.railCells));
  const cols = Math.max(1, total - railCells);
  const entries = [];
  if (synced.showClock) entries.push({ id: "clock", kind: "clock" });
  if (synced.showPinned) entries.push({ id: "pinned", kind: "pinned" });
  for (const group of board.columns) {
    if (!synced.otherWindows && !group.current) continue;
    entries.push({ id: folders[group.id] ? `group:${folders[group.id]}` : `local:${group.id}`, kind: "group", group });
  }
  if (synced.showSaved && board.saved?.length) entries.push({ id: "saved", kind: "saved" });
  if (synced.showMemory) entries.push({ id: "memory", kind: "memory" });
  if (synced.showWeather) entries.push({ id: "weather", kind: "weather" });
  const ids = entries.map(entry => entry.id);
  const visibleTiles = tiles => tiles.filter(tile => ids.includes(tile.id));
  const k = sourceLayout(layouts, cols, k => keepsOrSqueezes(visibleTiles(layouts[k].tiles), k, cols));
  const layout = layouts[k]?.tiles ?? [], savedIds = new Set(layout.map(tile => tile.id));
  const visible = visibleTiles(layout);
  const metadata = new Map(entries.map(entry => [entry.id, entry]));
  const placed = addMissing(visible, ids, k, targetCell).map(tile => savedIds.has(tile.id) ? tile
    : { ...tile, ...defaultSize(metadata.get(tile.id).kind, targetCell, 10000) });
  const newTiles = placed.filter(tile => !savedIds.has(tile.id) && !tile.id.startsWith("local:"));
  return { cell, targetCell, total, cols, k, railCells, saved: layout,
    tiles: (k > cols ? derive(placed, k, cols) : fit(placed, cols)).map(tile => ({ ...tile, ...metadata.get(tile.id) })), newTiles };
}
