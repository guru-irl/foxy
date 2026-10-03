import { fitCell, railLimits, addMissing, defaultSize, fit } from "./layout.js";
import { cellPx } from "../settings/store.js";

/** Pure display geometry. Hidden and closed tiles keep their saved keys only. */
export function buildView(board, { layout, synced, device, contentWidth, folders = {} }) {
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
  const ids = entries.map(entry => entry.id), savedIds = new Set(layout.map(tile => tile.id));
  const visible = layout.filter(tile => ids.includes(tile.id));
  const metadata = new Map(entries.map(entry => [entry.id, entry]));
  const placed = addMissing(visible, ids, cols, targetCell).map(tile => savedIds.has(tile.id) ? tile
    : { ...tile, ...defaultSize(metadata.get(tile.id).kind, targetCell, 10000) });
  const newTiles = placed.filter(tile => !savedIds.has(tile.id) && !tile.id.startsWith("local:"));
  return { cell, total, cols, railCells, saved: layout,
    tiles: fit(placed, cols).map(tile => ({ ...tile, ...metadata.get(tile.id) })), newTiles };
}
