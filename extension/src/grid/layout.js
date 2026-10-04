export const GAP = 16;
export const CELL_PRESETS = { S: 48, M: 80, L: 112, XL: 144 };

export function kindOf(id) {
  return ["pinned", "saved", "clock", "memory"].includes(id) ? id : "group";
}

export function totalColumns(contentWidth, cell) {
  return Math.max(1, Math.floor((contentWidth + GAP) / (cell + GAP)));
}

export function fitCell(pageWidth, preset) {
  const total = totalColumns(pageWidth, preset);
  return { total, cell: (pageWidth + GAP) / total - GAP };
}

export function railLimits(total) {
  return { min: 2, max: Math.max(2, Math.floor(total / 2)) };
}

export function minSize(kind) {
  if (kind === "memory") return { w: 3, h: 3 };
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
  if (kind === "memory") return { w: Math.min(cols, 5), h: 6 };
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

function sharesRow(a, b) {
  return a.y < b.y + b.h && b.y < a.y + a.h;
}

// Display only: separate saved overlaps, cap widths, close empty columns,
// then push left just enough. Wrap only tiles whose rows cannot fit.
export function arrangement(tiles, cols) {
  cols = columns(cols);
  const result = tiles.map(tile => ({ ...tile }));
  const ordered = [...result].sort(readingOrder), rest = new Set();
  let kept = [];
  for (const tile of ordered) {
    if (kept.some(other => overlaps(tile, other))) rest.add(tile);
    else kept.push(tile);
  }
  for (const tile of result) tile.w = Math.min(tile.w, cols);

  const leftToRight = [...kept].sort((a, b) => a.x - b.x || readingOrder(a, b));
  const gaps = [];
  let edge = 0;
  for (const tile of leftToRight) {
    if (tile.x > edge) gaps.push({ start: edge, end: tile.x });
    edge = Math.max(edge, tile.x + tile.w);
  }
  // Removing an empty run at once is equivalent to closing its columns
  // rightmost first, without scanning potentially large saved coordinates.
  for (const gap of gaps.reverse()) {
    if (edge <= cols) break;
    const shift = Math.min(gap.end - gap.start, edge - cols);
    for (const tile of kept) if (tile.x >= gap.end) tile.x -= shift;
    edge -= shift;
  }

  if (edge > cols) {
    const ends = new Map();
    kept = [];
    for (const tile of leftToRight) {
      let left = 0;
      for (const other of kept) if (sharesRow(tile, other)) left = Math.max(left, ends.get(other));
      if (left + tile.w > cols) rest.add(tile);
      else { kept.push(tile); ends.set(tile, left + tile.w); }
    }
    for (let i = kept.length - 1; i >= 0; i--) {
      const tile = kept[i];
      let limit = cols;
      for (let j = i + 1; j < kept.length; j++) {
        if (sharesRow(tile, kept[j])) limit = Math.min(limit, kept[j].x);
      }
      tile.x = Math.min(tile.x, limit - tile.w);
    }
  }
  return { tiles: result, kept, aside: ordered.filter(tile => rest.has(tile)) };
}

export function fit(tiles, cols) {
  const { tiles: result, kept, aside } = arrangement(tiles, cols);
  // Use saved reading order for both kinds of set-aside tile.
  for (const tile of aside) {
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

// Writes for a committed move or resize (§12). A release that changes nothing
// on screen writes nothing. Otherwise every shown tile whose place differs
// from its saved place is written as shown, so the saved layout matches what
// the user saw; shown tiles with no saved place count as saved where shown.
export function gestureWrites(shown, saved, placed) {
  if (!changedTiles(shown, placed).length) return [];
  const byId = new Map(saved.map(tile => [tile.id, tile]));
  return changedTiles(shown.map(tile => byId.get(tile.id) ?? tile), placed);
}
