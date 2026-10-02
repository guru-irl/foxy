export const GAP = 16;
export const CELL_PRESETS = { S: 48, M: 80, L: 112, XL: 144 };

export function kindOf(id) {
  return ["pinned", "saved", "clock"].includes(id) ? id : "group";
}

export function totalColumns(contentWidth, cell) {
  return Math.max(1, Math.floor((contentWidth + GAP) / (cell + GAP)));
}

export function railLimits(total) {
  return { min: 2, max: Math.max(2, Math.floor(total / 2)) };
}

export function minSize(kind) {
  return { w: kind === "clock" ? 3 : 2, h: 2 };
}

// A column count that is not a positive integer counts as one column, so
// placement loops always terminate.
function columns(cols) {
  return Number.isInteger(cols) && cols >= 1 ? cols : 1;
}

function whole(value) {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

export function defaultSize(kind, cell, cols) {
  cols = columns(cols);
  const min = minSize(kind);
  const width = kind === "clock" ? 480 : 288;
  const height = kind === "clock" ? 208 : 384;
  return {
    w: Math.min(cols, Math.max(min.w, Math.round((width + GAP) / (cell + GAP)))),
    h: Math.max(min.h, Math.round((height + GAP) / (cell + GAP))),
  };
}

export function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w
    && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function clampRect(id, rect, cols) {
  cols = columns(cols);
  const min = minSize(kindOf(id));
  const w = Math.min(cols, Math.max(min.w, whole(rect.w)));
  const h = Math.max(min.h, whole(rect.h));
  return {
    id,
    x: Math.min(cols - w, Math.max(0, whole(rect.x))),
    y: Math.max(0, whole(rect.y)),
    w, h,
  };
}

function readingOrder(a, b) {
  return a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function place(tiles, id, rect, cols) {
  const moved = clampRect(id, rect, cols);
  const result = tiles.map(tile => tile.id === id ? moved : { ...tile });
  if (!tiles.some(tile => tile.id === id)) result.push(moved);
  const queue = [moved];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    for (const tile of [...result].sort(readingOrder)) {
      if (tile !== current && overlaps(current, tile)) {
        tile.y = current.y + current.h;
        queue.push(tile);
      }
    }
  }
  return result;
}

export function firstFree(tiles, size, cols, fromY = 0) {
  cols = columns(cols);
  const w = Math.min(Math.max(1, whole(size.w)), cols), h = Math.max(1, whole(size.h));
  for (let y = Math.max(0, whole(fromY)); ; y++) {
    for (let x = 0; x <= cols - w; x++) {
      if (!tiles.some(tile => overlaps({ x, y, w, h }, tile))) {
        return { x, y };
      }
    }
  }
}

// Display only. First pass, in reading order: a tile stays where it is saved
// if it is inside the columns and clear of the tiles kept before it. Second
// pass, in reading order: every other tile is shown at the first free spot at
// or below its own row, width capped at the columns.
export function fit(tiles, cols) {
  cols = columns(cols);
  const result = tiles.map(tile => ({ ...tile }));
  const kept = [], rest = [];
  for (const tile of [...result].sort(readingOrder)) {
    const stays = tile.x + tile.w <= cols && !kept.some(other => overlaps(tile, other));
    (stays ? kept : rest).push(tile);
  }
  for (const tile of rest) {
    tile.w = Math.min(tile.w, cols);
    Object.assign(tile, firstFree(kept, tile, cols, tile.y));
    kept.push(tile);
  }
  return result;
}

export function addMissing(tiles, ids, cols, cell) {
  const result = tiles.map(tile => ({ ...tile }));
  const present = new Set(tiles.map(tile => tile.id));
  for (const id of ids) {
    if (present.has(id)) continue;
    const size = defaultSize(kindOf(id), cell, cols);
    result.push({ id, ...firstFree(result, size, cols), ...size });
    present.add(id);
  }
  return result;
}

export function changedTiles(before, after) {
  const previous = new Map(before.map(tile => [tile.id, tile]));
  return after.filter(tile => {
    const old = previous.get(tile.id);
    return !old || ["x", "y", "w", "h"].some(key => old[key] !== tile[key]);
  });
}
