import { colorKey } from "../model.js";

/** Build the board from detached WebExtension snapshots, without changing them. */
export function buildBoard({ windows, tabs, groups, currentWindowId, selfTabId, selfUrl, saved = [], missing = [], pins = {} }) {
  const selfBaseUrl = selfUrl?.split(/[?#]/, 1)[0];
  const recency = new Map();
  for (const tab of tabs) {
    recency.set(tab.windowId, Math.max(recency.get(tab.windowId) ?? 0, tab.lastAccessed ?? 0));
  }
  const windowOrder = windows
    .filter(win => win.type === "normal" && !win.incognito)
    .map(win => win.id)
    .sort((a, b) => {
      if (a === currentWindowId) return -1;
      if (b === currentWindowId) return 1;
      return (recency.get(b) ?? 0) - (recency.get(a) ?? 0) || a - b;
    });

  const board = { windowOrder, pinned: [], columns: [], tabs: [],
    saved: normaliseSaved(saved), missing: normaliseSaved(missing) };
  for (const windowId of windowOrder) {
    const current = windowId === currentWindowId;
    const rows = tabs
      .filter(tab => tab.windowId === windowId && tab.id !== selfTabId && !tab.hidden &&
        (!selfBaseUrl || tab.url?.split(/[?#]/, 1)[0] !== selfBaseUrl))
      .sort((a, b) => a.index - b.index)
      .map(tab => {
        const row = toRow(tab), pin = tab.pinned ? pins[tab.id] : null;
        return pin?.name ? { ...row, ...pin, title: pin.name } : row;
      });
    const pinned = rows.filter(row => row.pinned);
    const loose = rows.filter(row => !row.pinned && row.groupId === -1);
    if (pinned.length) board.pinned.push({ windowId, current, rows: pinned });
    if (loose.length) board.tabs.push({ windowId, current, rows: loose });

    const members = new Map();
    for (const row of rows) {
      if (row.pinned || row.groupId === -1) continue;
      if (!members.has(row.groupId)) members.set(row.groupId, []);
      members.get(row.groupId).push(row);
    }
    const columns = groups
      .filter(group => group.windowId === windowId && members.has(group.id))
      .map(group => ({
        id: group.id, windowId, current, title: group.title ?? "",
        color: colorKey(group.color), apiColor: group.color,
        collapsed: Boolean(group.collapsed), rows: members.get(group.id),
      }))
      .sort((a, b) => a.rows[0].index - b.rows[0].index);
    board.columns.push(...columns);
  }
  return board;
}

function normaliseSaved(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(entry => typeof entry?.folderId === "string" && entry.folderId !== "")
    .map(entry => ({
      ...entry,
      title: typeof entry.title === "string" ? entry.title : "",
      color: entry.color ?? "grey",
      count: Number.isFinite(entry.count) ? entry.count : 0,
      cantReopen: Array.isArray(entry.cantReopen) ? entry.cantReopen.filter(url => typeof url === "string") : [],
    }));
}

function toRow(tab) {
  return {
    id: tab.id, windowId: tab.windowId, index: tab.index,
    title: tab.title || tab.url || "", url: tab.url || "", icon: tab.favIconUrl || null,
    pinned: Boolean(tab.pinned), groupId: tab.groupId ?? -1, active: Boolean(tab.active),
  };
}
