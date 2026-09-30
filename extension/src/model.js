// Pure functions shared by the page and the Node tests: no browser APIs, no DOM.

const COLORS = ["blue", "cyan", "gray", "green", "orange", "pink", "purple", "red", "yellow"];
const WEEKDAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
const MONTHS = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];

/** @typedef {{id: number, title: string, icon: string | null}} TabItem */
/** @typedef {{id: number, title: string, color: string, tabs: TabItem[]}} GroupItem */

/**
 * Sort one window's tabs into pinned tabs and tab groups, in sidebar order.
 * Leaves out ungrouped tabs, hidden tabs, the page's own tab, and groups with
 * nothing left to show.
 * @param {Array<object>} tabs  tabs.Tab objects from one window
 * @param {Array<object>} groups  tabGroups.TabGroup objects from the same window
 * @param {number} selfTabId  the new tab page's own tab id
 * @returns {{pinned: TabItem[], groups: GroupItem[]}}
 */
export function buildModel(tabs, groups, selfTabId) {
  const shown = tabs
    .filter((tab) => tab.id !== selfTabId && !tab.hidden)
    .sort((a, b) => a.index - b.index);

  const members = new Map();
  for (const tab of shown) {
    if (tab.pinned || tab.groupId === undefined || tab.groupId === -1) continue;
    if (!members.has(tab.groupId)) members.set(tab.groupId, []);
    members.get(tab.groupId).push(tab);
  }

  const ordered = groups
    .filter((group) => members.has(group.id))
    .map((group) => ({ group, list: members.get(group.id) }))
    .sort((a, b) => a.list[0].index - b.list[0].index);

  return {
    pinned: shown.filter((tab) => tab.pinned).map(toItem),
    groups: ordered.map(({ group, list }) => ({
      id: group.id,
      title: group.title?.trim() || "Unnamed group",
      color: colorKey(group.color),
      tabs: list.map(toItem),
    })),
  };
}

function toItem(tab) {
  return { id: tab.id, title: tab.title || tab.url || "", icon: tab.favIconUrl || null };
}

/** Map a tabGroups color to the sidebar's dot palette key. */
export function colorKey(color) {
  if (color === "grey") return "gray";
  return COLORS.includes(color) ? color : "gray";
}

/** 24-hour local time, e.g. "09:05". */
export function formatTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** English capitals without the year, e.g. "WEDNESDAY 30 SEPTEMBER". */
export function formatDate(date) {
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** Milliseconds until the next minute starts (1 to 60000). */
export function msUntilNextMinute(date) {
  return 60000 - (date.getSeconds() * 1000 + date.getMilliseconds());
}

function pad(n) {
  return String(n).padStart(2, "0");
}
