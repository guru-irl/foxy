export const GAP = 16;
export const headerHeight = (density = 'normal', remote = false) => (density === 'compact' ? 24 : 32) + 16 + (remote ? 24 : 0);
export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export function columns(width) {
  const count = clamp(Math.floor((width + GAP) / 316), 1, 4);
  return { count, width: (width - (count - 1) * GAP) / count };
}

export function pageColumns(width, widgetsWidth = 304, railWidth = 304) {
  const widgets = clamp(widgetsWidth, 240, width / 3), rail = clamp(railWidth, 240, width / 3);
  const available = width - widgets - rail - 2 * GAP, fallback = available < 200;
  return { widgets, rail, kanban: fallback ? Math.max(0, width - rail - GAP) : available, fallback };
}

export function placeTiles(entries, width) {
  const geometry = columns(width), bottoms = Array(geometry.count).fill(0);
  const tiles = entries.map(tile => {
    const column = bottoms.indexOf(Math.min(...bottoms)), y = bottoms[column];
    bottoms[column] += tile.height + GAP;
    return { ...tile, x: column * (geometry.width + GAP), y, w: geometry.width };
  });
  return { tiles, height: Math.max(0, ...bottoms) - (tiles.length ? GAP : 0) };
}

export function groupHeight(tabs, rows = null, density = 'normal', remote = false) {
  return headerHeight(density, remote) + (density === 'compact' ? 24 : 32) * (rows ?? clamp(tabs, 3, 12));
}

export function widgetMinimum(kind, density = 'normal') {
  return kind === 'pinned' ? 96 : kind === 'saved' ? headerHeight(density) + (density === 'compact' ? 24 : 32)
    : kind === 'memory' ? 304 : 112;
}

export function widgetHeight(kind, h, width, count = 0, density = 'normal') {
  const row = density === 'compact' ? 24 : 32;
  const perRow = Math.max(1, Math.floor((width - 16 + 16) / 64));
  const defaults = { clock: 160, weather: 304, memory: 360,
    pinned: 32 + clamp(Math.ceil(count / perRow), 1, 3) * 64,
    saved: headerHeight(density) + clamp(count, 1, 8) * row };
  return Math.max(widgetMinimum(kind, density), h ?? defaults[kind]);
}
