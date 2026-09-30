// Preview only: fake tabs and groups. Icons are inline SVG squares, so the
// preview never loads anything from the network.

const SWATCHES = ["#e2475b", "#f0883e", "#3fb950", "#58a6ff", "#bc8cff", "#39c5cf", "#e3b341", "#f778ba"];
const TITLES = [
  "YouTube",
  "Inbox (3)",
  "Pull request #1234: Fix the flaky sidebar test in the vertical tab strip",
  "Docs",
  "Calendar",
  "Figma",
  "Hacker News",
  "Weather",
  "Maps",
  "Music",
  "Notes",
  "Photos",
];

const icon = (i) =>
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="${SWATCHES[i % SWATCHES.length]}"/></svg>`,
  );

// Tabs in window order: pinned tabs, one ungrouped tab (must not show), then
// each group's tabs. Groups are returned in reverse so the page has to order
// them by their tabs. With brokenIcons, a group's 2nd tab has a chrome:// icon
// (an add-on can't load it) and its 3rd has none; both must show the globe.
function scenario(pinnedCount, specs) {
  const tabs = [];
  const groups = [];
  let id = 1;
  const add = (extra) => tabs.push({ id: id++, index: tabs.length, windowId: 1, hidden: false, ...extra });

  for (let i = 0; i < pinnedCount; i++) {
    add({ pinned: true, groupId: -1, title: TITLES[i % TITLES.length], url: `https://example.com/pinned/${i}`, favIconUrl: icon(i) });
  }
  add({ pinned: false, groupId: -1, title: "Ungrouped (must not show)", url: "https://example.com/loose", favIconUrl: icon(0) });

  specs.forEach((spec, g) => {
    const groupId = 100 + g;
    groups.push({ id: groupId, windowId: 1, title: spec.title, color: spec.color, collapsed: false });
    for (let i = 0; i < spec.count; i++) {
      let favIconUrl = icon(g + i);
      if (spec.brokenIcons && i === 1) favIconUrl = "chrome://global/skin/icons/settings.svg";
      if (spec.brokenIcons && i === 2) favIconUrl = undefined;
      add({ pinned: false, groupId, title: TITLES[(g * 3 + i) % TITLES.length], url: `https://example.com/${groupId}/${i}`, favIconUrl });
    }
  });

  return { tabs, groups: groups.reverse() };
}

export const SCENARIOS = {
  none: scenario(0, []),
  one: scenario(3, [{ title: "Work", color: "blue", count: 4 }]),
  two: scenario(5, [
    { title: "Work", color: "blue", count: 4 },
    { title: "Reading", color: "orange", count: 6 },
  ]),
  three: scenario(6, [
    { title: "Work", color: "blue", count: 5, brokenIcons: true },
    { title: "Research with a very long group name that has to be cut off", color: "green", count: 12 },
    { title: "Fun", color: "pink", count: 3 },
  ]),
  five: scenario(8, [
    { title: "Work", color: "blue", count: 4 },
    { title: "", color: "grey", count: 2 },
    { title: "Travel", color: "purple", count: 3 },
    { title: "Shopping", color: "yellow", count: 5 },
    { title: "Admin", color: "red", count: 2 },
  ]),
};
