import { realLayout, realGroups } from "../test/browser/fixtures/real-layout.js";
// Preview fixtures use only inline, neutral icons. No network requests.
const TITLES = ["YouTube", "Inbox (3)", "Pull request #1234: Fix the flaky sidebar test in the vertical tab strip",
  "Docs", "Calendar", "Figma", "Hacker News", "Weather", "Maps", "Music", "Notes", "Photos"];
const icon = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="3" fill="#aaa"/></svg>');

function scenario(specs, { pinned = 6, loose = 3, other = false } = {}) {
  const tabs = [], groups = [], windows = [{ id: 1, focused: true }];
  let id = 1;
  function addWindow(windowId, pinnedCount, groupSpecs, looseCount) {
    let index = 0;
    const add = extra => tabs.push({ id: id++, windowId, index: index++, lastAccessed: 1000 - windowId,
      title: TITLES[(id - 2) % TITLES.length], favIconUrl: icon, ...extra });
    for (let i = 0; i < pinnedCount; i++) add({ pinned: true, url: `https://example.com/pin/${windowId}/${i}` });
    groupSpecs.forEach((spec, g) => {
      const groupId = windowId * 100 + g + 1;
      groups.push({ id: groupId, windowId, title: spec.title, color: spec.color, collapsed: false });
      for (let i = 0; i < spec.count; i++) {
        add({ groupId, url: `https://example.com/${groupId}/${i}`,
          ...(spec.brokenIcons && i === 1 ? { favIconUrl: "data:image/png;base64,AAAA" } : {}),
          ...(spec.brokenIcons && i === 2 ? { favIconUrl: null } : {}) });
      }
    });
    for (let i = 0; i < looseCount; i++) add({ url: `https://example.com/loose/${windowId}/${i}` });
  }
  addWindow(1, pinned, specs, loose);
  if (other) {
    windows.push({ id: 2, focused: false });
    addWindow(2, 2, [{ title: "READING", color: "orange", count: 6 },
      { title: "TRAVEL", color: "purple", count: 4 }], 2);
  }
  // Reverse the API's groups to demonstrate ordering by tab-strip position.
  return { windows, tabs, groups: groups.reverse() };
}

const one = [
  { title: "DEV SERVER", color: "red", count: 5, brokenIcons: true },
  { title: "Research with a very long group name that has to be cut off", color: "green", count: 12 },
  { title: "   ", color: "grey", count: 3 },
];
const saved = [
  { folderId: "saved-reading", title: "READING", color: "blue", count: 4, cantReopen: [] },
  { folderId: "saved-local", title: "LOCAL PAGES", color: "grey", count: 2, cantReopen: ["about:config"] },
  { folderId: "saved-unnamed", title: "", color: "orange", count: 3, cantReopen: [] },
];
// The same wide saved layout is fitted, without writes, by the narrow preview.
function grid(customCell = 80) {
  return { ...scenario(one), saved, missing: [],
    folders: { 101: "preview-101", 102: "preview-102", 103: "preview-103" },
    deviceSettings: { cellSize: "custom", customCell },
    layout: {
      clock: { x: 0, y: 0, w: 5, h: 2 },
      pinned: { x: 0, y: 2, w: 3, h: 4 },
      "group:preview-101": { x: 5, y: 0, w: 3, h: 4 },
      "group:preview-102": { x: 3, y: 4, w: 3, h: 4 },
      "group:preview-103": { x: 6, y: 4, w: 3, h: 4 },
      saved: { x: 0, y: 6, w: 3, h: 4 },
      weather: { x: 3, y: 8, w: 3, h: 3 },
    },
  };
}
function realGrid() {
  const data = scenario(realGroups.map(g => ({ title: g.title, color: g.color, count: 12 })), { pinned: 5 });
  return { ...data, folders: Object.fromEntries(data.groups.map(g => [g.id, g.title.toLowerCase()])),
    layout: realLayout, layoutWidth: 34, syncedSettings: { railCells: 5 }, deviceSettings: { cellSize: "S" } };
}
// S cells with a tall weather tile beside the M preview layout.
function weatherGrid() {
  const data = grid("S");
  return { ...data, layout: { ...data.layout, weather: { x: 9, y: 0, w: 5, h: 8 } } };
}
export const SCENARIOS = {
  weather: weatherGrid(),
  "real-34": realGrid(), "real-33": realGrid(), "real-17": realGrid(),
  "grid-custom-80": grid(),
  "grid-custom-144": grid(144),
  "grid-narrow": grid(),
  "settings-open": grid(),
  empty: scenario([], { pinned: 0 }),
  "one-window": scenario(one),
  saved: { ...scenario(one), saved, missing: [] },
  banner: { ...scenario(one), saved,
    missing: saved.slice(0, 2).map(({ folderId, title, color }) => ({ folderId, title, color })) },
  "two-windows": scenario(one, { other: true }),
  "remote-header": scenario([{ title: "LOCAL", color: "grey", count: 3 }], { other: true }),
  "many-groups": scenario([
    { title: "DEV SERVER", color: "red", count: 20 },
    { title: "READING", color: "blue", count: 20 },
    { title: "TRAVEL", color: "purple", count: 3 },
    { title: "SHOPPING", color: "yellow", count: 5 },
    { title: "ADMIN", color: "orange", count: 20 },
    { title: "NOTES", color: "cyan", count: 4 },
    { title: "MUSIC", color: "pink", count: 3 },
    { title: "", color: "grey", count: 2 },
  ]),
  light: scenario(one),
};
