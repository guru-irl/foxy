import { demoGroups } from "../test/browser/fixtures/demo-groups.js";
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
          ...(spec.titles ? { title: spec.titles[i] } : {}),
          ...(spec.brokenIcons && i === 1 ? { favIconUrl: "data:image/png;base64,AAAA" } : {}),
          ...(spec.brokenIcons && i === 2 ? { favIconUrl: null } : {}) });
      }
    });
    for (let i = 0; i < looseCount; i++) add({ url: `https://example.com/loose/${windowId}/${i}` });
  }
  addWindow(1, pinned, specs, loose);
  if (other) {
    windows.push({ id: 2, focused: false });
    addWindow(2, 2, [{ title: "MUSIC", color: "orange", count: 6 },
      { title: "PHOTOS", color: "purple", count: 4 }], 2);
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
function widgetsBoard() {
  const data = scenario(one);
  return { ...data, saved, missing: [], folders: Object.fromEntries(data.groups.map(g => [g.id, `preview-${g.id}`])) };
}
function realBoard() {
  const titles = [
    ['Reading list', 'A short history of maps', 'The art of noticing', 'Library catalogue', 'Weekend essays'],
    ['Project notes', 'Design review', 'Team calendar', 'Documentation', 'Tasks for this week', 'Meeting notes'],
    ['City guide', 'Places to visit', 'Train schedules', 'Museum tickets', 'Weekend itinerary'],
    ['Dinner ideas', 'Pasta with tomatoes', 'Vegetable soup', 'Bread recipe', 'Seasonal favourites'],
    ['Research notes', 'Reference library', 'Data sources', 'Ideas to explore'],
    ['Side project notes', 'Sketches', 'Inspiration', 'Next steps'],
  ];
  const data = scenario(demoGroups.map((g, i) => ({ title: g.title, color: g.color, titles: titles[i], count: titles[i].length })), { pinned: 5, other: true });
  return { ...data, saved, missing: [], folders: Object.fromEntries(data.groups.map(g => [g.id, `preview-${g.id}`])),
    syncedSettings: { otherWindows: true }, deviceSettings: { density: 'normal' },
    board: { order: [], heights: {}, widgets: [], t: 1 } };
}
const real = realBoard();
const narrow = { ...real, board: { ...real.board, widgets: [
  {kind:'clock',h:112},{kind:'pinned',h:96},{kind:'weather',h:112},{kind:'memory',h:304},{kind:'saved',h:80},
] } };
export const SCENARIOS = {
  weather: widgetsBoard(),
  v40: real, "v40-narrow": narrow,
  "real-34": realBoard(), "real-33": realBoard(), "real-17": realBoard(),
  "settings-open": widgetsBoard(),
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
