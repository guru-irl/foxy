import { pageColumns, placeTiles, groupHeight, widgetHeight } from './layout.js';

export function buildView(data, { board, synced, device, contentWidth, folders = {} }) {
  const page = pageColumns(contentWidth, synced.widgetsWidth, synced.railWidth);
  const widgetWidth = page.fallback ? page.kanban : page.widgets;
  const widgets = board.widgets.filter(w => (w.kind !== 'saved' || data.saved?.length) && synced[`show${w.kind[0].toUpperCase()}${w.kind.slice(1)}`])
    .map(w => ({ id: w.kind, kind: w.kind, height: widgetHeight(w.kind, w.h, widgetWidth,
      w.kind === 'pinned' ? data.pinned.reduce((sum, section) => sum + section.rows.length, 0) : data.saved?.length ?? 0, device.density) }));
  const groups = data.columns.filter(group => synced.otherWindows || group.current).map(group => ({
    id: folders[group.id] ? `group:${folders[group.id]}` : `local:${group.id}`, kind: 'group', group,
  }));
  const rank = new Map(board.order.map((id,i)=>[id,i]));
  groups.sort((a,b) => Number(b.group.current) - Number(a.group.current) || (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  const placed = placeTiles(groups.map(g => ({ ...g, height: groupHeight(g.group.rows.length, board.heights[g.id], device.density, !g.group.current) })), page.kanban);
  return { page, widgets, ...placed };
}
