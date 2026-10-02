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

export function defaultSize(kind, cell, cols) {
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
  const min = minSize(kindOf(id));
  const w = Math.min(cols, Math.max(min.w, Math.round(rect.w)));
  const h = Math.max(min.h, Math.round(rect.h));
  return {
    id,
    x: Math.min(cols - w, Math.max(0, Math.round(rect.x))),
    y: Math.max(0, Math.round(rect.y)),
    w, h,
  };
}

function readingOrder(a, b) {
  return a.y - b.y || a.x - b.x;
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
  const w = Math.min(size.w, cols);
  for (let y = fromY; ; y++) {
    for (let x = 0; x <= cols - w; x++) {
      if (!tiles.some(tile => overlaps({ x, y, w, h: size.h }, tile))) {
        return { x, y };
      }
    }
  }
}

export function fit(tiles, cols) {
  const result = tiles.map(tile => ({ ...tile }));
  const kept = result.filter(tile => tile.x + tile.w <= cols);
  const overflow = result.filter(tile => tile.x + tile.w > cols).sort(readingOrder);
  for (const tile of overflow) {
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

export function arrange(ids, cols, cell) {
  return addMissing([], ids, cols, cell);
}

export function changedTiles(before, after) {
  const previous = new Map(before.map(tile => [tile.id, tile]));
  return after.filter(tile => {
    const old = previous.get(tile.id);
    return !old || ["x", "y", "w", "h"].some(key => old[key] !== tile[key]);
  });
}
