import { totalColumns, railLimits, addMissing, defaultSize, fit, clampRect } from "./layout.js";
import { cellPx } from "../settings/store.js";

/** Pure display geometry. Hidden and closed tiles keep their saved keys only. */
export function buildView(board, { layout, synced, device, contentWidth, folders = {}, pending = new Map() }) {
  const cell = cellPx(device), total = totalColumns(contentWidth, cell);
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
  for (const entry of entries) {
    const rect = pending.get(entry.group?.id);
    if (rect && !savedIds.has(entry.id)) visible.push(clampRect(entry.id, rect, cols));
  }
  const metadata = new Map(entries.map(entry => [entry.id, entry]));
  const placed = addMissing(visible, ids, cols, cell).map(tile => savedIds.has(tile.id) ? tile
    : { ...tile, ...defaultSize(metadata.get(tile.id).kind, cell, 10000) });
  const newTiles = placed.filter(tile => !savedIds.has(tile.id) && !tile.id.startsWith("local:"));
  return { cell, total, cols, railCells, saved: layout,
    tiles: fit(placed, cols).map(tile => ({ ...tile, ...metadata.get(tile.id) })), newTiles };
}
