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
export const SCENARIOS = {
  empty: scenario([], { pinned: 0 }),
  "one-window": scenario(one),
  "two-windows": scenario(one, { other: true }),
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
