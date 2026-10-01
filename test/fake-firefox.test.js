import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";

function strip() {
  return createFirefox({
    groups: [{ id: 101, windowId: 1, title: "Group", color: "red" }],
    tabs: [{ id: 1, windowId: 1, pinned: true }, { id: 2, windowId: 1 },
      { id: 3, windowId: 1, groupId: 101 }, { id: 4, windowId: 1, groupId: 101 },
      { id: 5, windowId: 1 }],
  });
}
function logEvents(ff, names) {
  const log = [];
  for (const name of names) {
    const [namespace, event] = name.split(".");
    ff.browser[namespace][event].addListener((...args) => log.push([name, ...args]));
  }
  return log;
}
async function invariants(ff) {
  for (const win of await ff.browser.windows.getAll({ populate: true })) {
    assert.deepEqual(win.tabs.map(t => t.index), win.tabs.map((_, i) => i));
    let unpinned = false;
    const finished = new Set();
    let previous = -1;
    for (const tab of win.tabs) {
      if (!tab.pinned) unpinned = true;
      if (tab.pinned) { assert.equal(unpinned, false); assert.equal(tab.groupId, -1); }
      if (tab.groupId !== previous) {
        if (previous !== -1) finished.add(previous);
        assert.equal(finished.has(tab.groupId), false);
      }
      previous = tab.groupId;
    }
  }
}

test("tab snapshots have complete defaults, setup activation and increasing access times", async () => {
  const ff = createFirefox({ tabs: [{ id: 1, windowId: 1 }, { id: 2, windowId: 1, active: true }] });
  const tab = await ff.browser.tabs.get(1);
  assert.deepEqual(tab, { id: 1, windowId: 1, index: 0, pinned: false, groupId: -1,
    url: "about:blank", title: "about:blank", favIconUrl: undefined, active: false,
    discarded: false, hidden: false, status: "complete", lastAccessed: 1, incognito: false });
  assert.equal((await ff.browser.tabs.get(2)).lastAccessed, 2);
  assert.equal((await ff.browser.tabs.get(2)).active, true);
  tab.title = "changed";
  assert.equal((await ff.browser.tabs.get(1)).title, "about:blank");
  assert.equal(ff.layout(1), "| 1 2");
  assert.deepEqual(await createFirefox().browser.windows.getAll(),
    [{ id: 1, focused: true, type: "normal", incognito: false }]);
});

test("queries filter all supported fields and preserve window setup order", async () => {
  const ff = createFirefox({ windows: [{ id: 8 }, { id: 2, focused: true }], currentWindowId: 8,
    tabs: [{ id: 1, windowId: 2 }, { id: 2, windowId: 8, pinned: true }, { id: 3, windowId: 8 }] });
  const ids = async q => (await ff.browser.tabs.query(q)).map(t => t.id);
  assert.deepEqual(await ids({}), [2, 3, 1]);
  assert.deepEqual(await ids({ currentWindow: true }), [2, 3]);
  assert.deepEqual(await ids({ windowId: 2 }), [1]);
  assert.deepEqual(await ids({ pinned: false, groupId: -1, active: true, windowType: "normal" }), [1]);
  assert.deepEqual(await ids({ windowType: "popup" }), []);
  assert.deepEqual(await ids({ currentWindow: true, windowId: 2 }), []);
});

test("get rejects unknown tabs and getCurrent uses the calling page rather than focus", async () => {
  const ff = createFirefox({ selfTabId: 3, tabs: [{ id: 3, windowId: 1 }] });
  assert.equal((await ff.browser.tabs.getCurrent()).id, 3);
  assert.equal(await createFirefox().browser.tabs.getCurrent(), undefined);
  await assert.rejects(ff.browser.tabs.get(99), { message: "Invalid tab ID: 99" });
});

test("create handles current window, pinned range, discarded titles and activation", async () => {
  const ff = strip();
  const log = logEvents(ff, ["tabs.onCreated"]);
  const a = await ff.browser.tabs.create({ url: "https://example.com/a" });
  assert.equal(a.title, "https://example.com/a");
  assert.equal(a.active, true);
  assert.equal((await ff.browser.tabs.get(1)).active, false);
  const b = await ff.browser.tabs.create({ pinned: true, active: false });
  assert.equal(b.index, 1);
  const c = await ff.browser.tabs.create({ url: "https://example.com/saved", discarded: true, title: "Saved" });
  assert.equal(c.active, false);
  assert.equal(c.title, "Saved");
  await assert.rejects(ff.browser.tabs.create({ discarded: true, active: true }));
  assert.equal(log.length, 0);
  await ff.settle();
  assert.equal(log.length, 3);
  await invariants(ff);
});

const invalidCreates = [
  ["illegal URL before active discard check", { url: "about:config", discarded: true, active: true },
    "Illegal URL: about:config"],
  ["illegal URL before pinned discard check", { url: "file:///example", discarded: true, pinned: true, active: false },
    "Illegal URL: file:///example"],
  ["illegal URL before title check", { url: "chrome://example", title: "Saved" },
    "Illegal URL: chrome://example"],
  ["active discarded tab", { url: "https://example.com/", discarded: true, active: true },
    "Active tabs cannot be created and discarded."],
  ["pinned discarded tab", { url: "https://example.com/", discarded: true, pinned: true, active: false },
    "Pinned tabs cannot be created and discarded."],
  ["discarded tab with no URL", { discarded: true, active: false },
    'Cannot create a discarded new tab or "about" urls.'],
  ["discarded tab with undefined URL", { discarded: true, active: false, url: undefined },
    'Cannot create a discarded new tab or "about" urls.'],
  ["discarded tab with null URL", { discarded: true, active: false, url: null },
    'Cannot create a discarded new tab or "about" urls.'],
  // The fake rejects relative URLs; Firefox resolves "" to an extension URL.
  ["discarded tab with empty URL", { discarded: true, active: false, url: "" },
    "Illegal URL: "],
  ["discarded about:blank", { discarded: true, active: false, url: "about:blank" },
    'Cannot create a discarded new tab or "about" urls.'],
  ["discarded about:newtab", { discarded: true, active: false, url: "about:newtab" },
    "Illegal URL: about:newtab"],
  ["discarded about URL with fragment", { discarded: true, active: false, url: "about:blank#top" },
    "Illegal URL: about:blank#top"],
  ["title on a loaded tab", { url: "https://example.com/", title: "Saved" },
    "Title may only be set for discarded tabs."],
  ["title with explicit discarded false", { url: "https://example.com/", title: "Saved", discarded: false },
    "Title may only be set for discarded tabs."],
];
for (const [name, props, message] of invalidCreates) {
  test(`create rejects ${name} like Firefox 157 without changing state or emitting events`, async () => {
    const ff = createFirefox({ tabs: [{ id: 1, windowId: 1 }] });
    const before = await ff.browser.windows.getAll({ populate: true });
    const log = logEvents(ff, ["tabs.onCreated", "tabs.onUpdated", "tabs.onActivated"]);
    await assert.rejects(ff.browser.tabs.create(props), { message });
    assert.deepEqual(await ff.browser.windows.getAll({ populate: true }), before);
    await ff.settle();
    assert.deepEqual(log, []);
  });
}

test("a pinned inactive tab can be discarded after creation", async () => {
  const ff = createFirefox({ tabs: [{ id: 1, windowId: 1 }] });
  const log = logEvents(ff, ["tabs.onUpdated"]);
  const tab = await ff.browser.tabs.create({ url: "https://example.com/pin", active: false, pinned: true });
  const [discarded] = await ff.browser.tabs.discard(tab.id);
  assert.equal(discarded.discarded, true);
  assert.equal(discarded.pinned, true);
  assert.equal(discarded.active, false);
  assert.equal((await ff.browser.tabs.get(tab.id)).discarded, true);
  assert.equal((await ff.browser.tabs.get(1)).active, true);
  await ff.settle();
  assert.deepEqual(log, [["tabs.onUpdated", tab.id, { discarded: true }, discarded]]);
  await invariants(ff);
});

test("create defaults to the calling page window in a two-window fixture, not setup order or focus", async () => {
  const ff = createFirefox({ windows: [{ id: 1, focused: true }, { id: 2 }], currentWindowId: 2,
    tabs: [{ id: 1, windowId: 1 }, { id: 2, windowId: 2 }] });
  const log = logEvents(ff, ["tabs.onCreated"]);
  const tab = await ff.browser.tabs.create({ url: "https://example.com/a" });
  assert.equal(tab.windowId, 2);
  assert.equal(tab.index, 1);
  assert.equal(ff.layout(1), "| 1");
  assert.equal(ff.layout(2), "| 2 3");
  assert.deepEqual((await ff.browser.tabs.query({ active: true })).map(t => t.id), [1, 3]);
  assert.deepEqual(log, []);
  await ff.settle();
  assert.deepEqual(log, [["tabs.onCreated", tab]]);
  await invariants(ff);
});

test("create joins a group only between two of its tabs", async () => {
  const ff = strip();
  const inside = await ff.browser.tabs.create({ index: 3, active: false });
  assert.equal(inside.groupId, 101);
  const before = await ff.browser.tabs.create({ index: 2, active: false });
  assert.equal(before.groupId, -1);
  await invariants(ff);
});

test("create and update share strict allowed URL checks", async () => {
  const ff = createFirefox({ tabs: [{ id: 1, windowId: 1 }] });
  for (const url of ["https://example.com/a", "http://example.com/b", "about:blank", "moz-extension://foxy-test/page.html"]) {
    await ff.browser.tabs.create({ url });
    assert.equal((await ff.browser.tabs.update(1, { url })).url, url);
  }
  for (const url of ["about:config", "file:///example", "chrome://example", "data:text/plain,x", "javascript:void(0)"]) {
    await assert.rejects(ff.browser.tabs.create({ url }), { message: `Illegal URL: ${url}` });
    await assert.rejects(ff.browser.tabs.update(1, { url }), { message: `Illegal URL: ${url}` });
  }
});

test("update activates, pins out of groups, unpins at the boundary and loads discarded tabs", async () => {
  const ff = strip();
  const before = (await ff.browser.tabs.get(3)).lastAccessed;
  await ff.browser.tabs.update(3, { active: true, pinned: true, muted: true });
  assert.equal(ff.layout(1), "P1 P3 | 2 [101: 4] 5");
  assert.ok((await ff.browser.tabs.get(3)).lastAccessed > before);
  assert.equal((await ff.browser.tabs.get(1)).active, false);
  await ff.browser.tabs.update(3, { pinned: false });
  assert.equal(ff.layout(1), "P1 | 3 2 [101: 4] 5");
  const tab = await ff.browser.tabs.create({ url: "https://example.com/saved", discarded: true });
  assert.equal((await ff.browser.tabs.update(tab.id, { url: "https://example.com/a" })).discarded, false);
  await invariants(ff);
});

test("updating the already-active tab does not emit onActivated, but selecting another tab does", async () => {
  const ff = createFirefox({ tabs: [{ id: 1, windowId: 1 }, { id: 2, windowId: 1 }] });
  const log = logEvents(ff, ["tabs.onActivated"]);
  await ff.browser.tabs.update(1, { active: true });
  await ff.settle();
  assert.deepEqual(log, []);
  await ff.browser.tabs.update(2, { active: true });
  await ff.browser.tabs.update(2, { active: true });
  assert.deepEqual(log, []);
  await ff.settle();
  assert.deepEqual(log, [["tabs.onActivated", { tabId: 2, windowId: 1 }]]);
  assert.deepEqual((await ff.browser.tabs.query({ active: true })).map(t => t.id), [2]);
});

test("same-window moves take the forward or backward neighbor group and no-op at own index", async () => {
  const ff = strip();
  const log = logEvents(ff, ["tabs.onMoved", "tabs.onUpdated"]);
  await ff.browser.tabs.move(2, { index: 2 });
  assert.equal(ff.layout(1), "P1 | [101: 3 2 4] 5");
  await ff.browser.tabs.move(3, { index: -1 });
  assert.equal(ff.layout(1), "P1 | [101: 2 4] 5 3");
  await ff.browser.tabs.move(3, { index: 1 });
  assert.equal(ff.layout(1), "P1 | [101: 3 2 4] 5");
  await ff.browser.tabs.move(3, { index: 1 });
  assert.equal(log.length, 0);
  await ff.settle();
  assert.equal(log.filter(e => e[0] === "tabs.onMoved").length, 3);
  assert.deepEqual(log[0], ["tabs.onMoved", 2, { windowId: 1, fromIndex: 1, toIndex: 2 }]);
  assert.deepEqual(log.filter(e => e[0] === "tabs.onUpdated").map(e => e[2]),
    [{ groupId: 101 }, { groupId: -1 }, { groupId: 101 }]);
  await invariants(ff);
});

test("illegal pinned and unpinned move positions are ignored and omitted from results", async () => {
  const ff = strip();
  assert.deepEqual(await ff.browser.tabs.move(1, { index: 3 }), []);
  assert.deepEqual(await ff.browser.tabs.move(2, { index: 0 }), []);
  assert.equal(ff.layout(1), "P1 | 2 [101: 3 4] 5");
  assert.equal((await ff.browser.tabs.move(1, { index: 1 }))[0].index, 0);
  await invariants(ff);
});

test("array moves preserve requested consecutive order and clamp indexes", async () => {
  const ff = createFirefox({ tabs: [1, 2, 3, 4, 5].map(id => ({ id, windowId: 1 })) });
  await ff.browser.tabs.move([4, 2], { index: 0 });
  assert.equal(ff.layout(1), "| 4 2 1 3 5");
  await ff.browser.tabs.move([4, 2], { index: 999 });
  assert.equal(ff.layout(1), "| 1 3 5 4 2");
  await invariants(ff);
});

test("adoption inserts before target, takes its group, keeps pinned and closes empty sources", async () => {
  const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }],
    groups: [{ id: 101, windowId: 2 }], tabs: [{ id: 1, windowId: 1 },
      { id: 2, windowId: 2, pinned: true }, { id: 3, windowId: 2, groupId: 101 }, { id: 4, windowId: 2, groupId: 101 }] });
  const log = logEvents(ff, ["tabs.onDetached", "tabs.onAttached", "tabs.onUpdated", "windows.onRemoved"]);
  await ff.browser.tabs.move(1, { windowId: 2, index: 2 });
  assert.equal(ff.layout(1), "| ");
  assert.equal(ff.layout(2), "P2 | [101: 3 1 4]");
  await ff.settle();
  assert.deepEqual(log[0], ["tabs.onDetached", 1, { oldWindowId: 1, oldPosition: 0 }]);
  assert.deepEqual(log[1], ["tabs.onAttached", 1, { newWindowId: 2, newPosition: 2 }]);
  assert.deepEqual(log[2], ["tabs.onUpdated", 1, { groupId: 101 }, await ff.browser.tabs.get(1)]);
  assert.equal(log[2][3].groupId, 101);
  assert.equal(log[2][3].windowId, 2);
  assert.deepEqual(log.at(-1), ["windows.onRemoved", 1]);
  await invariants(ff);
});

test("adoption at end is ungrouped and cross-window illegal positions do nothing", async () => {
  const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }], groups: [{ id: 101, windowId: 2 }],
    tabs: [{ id: 1, windowId: 1, pinned: true }, { id: 2, windowId: 1 },
      { id: 3, windowId: 2, pinned: true }, { id: 4, windowId: 2, groupId: 101 }] });
  assert.deepEqual(await ff.browser.tabs.move(1, { windowId: 2, index: -1 }), []);
  assert.deepEqual(await ff.browser.tabs.move(2, { windowId: 2, index: 0 }), []);
  await ff.browser.tabs.move(2, { windowId: 2, index: 999 });
  await ff.browser.tabs.move(1, { windowId: 2, index: 1 });
  assert.equal(ff.layout(1), "| ");
  assert.equal(ff.layout(2), "P3 P1 | [101: 4] 2");
  await invariants(ff);
});

test("leaving the last member removes a group with non-closing metadata", async () => {
  const ff = createFirefox({ groups: [{ id: 101, windowId: 1 }],
    tabs: [{ id: 1, windowId: 1, groupId: 101 }, { id: 2, windowId: 1 }] });
  const log = logEvents(ff, ["tabGroups.onRemoved"]);
  await ff.browser.tabs.move(1, { index: -1 });
  assert.deepEqual(await ff.browser.tabGroups.query({}), []);
  await ff.settle();
  assert.equal(log[0][1].id, 101);
  assert.deepEqual(log[0][2], { isWindowClosing: false });
});

test("group adopts into an existing group, unpins and appends in tabIds order", async () => {
  const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }], groups: [{ id: 101, windowId: 2 }],
    tabs: [{ id: 1, windowId: 1, pinned: true }, { id: 2, windowId: 1 },
      { id: 3, windowId: 2, groupId: 101 }, { id: 4, windowId: 2 }] });
  const log = logEvents(ff, ["tabs.onUpdated", "windows.onRemoved"]);
  assert.equal(await ff.browser.tabs.group({ tabIds: [2, 1], groupId: 101 }), 101);
  assert.equal(ff.layout(1), "| ");
  assert.equal(ff.layout(2), "| [101: 3 2 1] 4");
  await ff.settle();
  assert.deepEqual(log.filter(e => e[0] === "tabs.onUpdated" && "groupId" in e[2]).map(e => [e[1], e[2]]),
    [[2, { groupId: 101 }], [1, { groupId: 101 }]]);
  assert.ok(log.some(e => e[0] === "windows.onRemoved" && e[1] === 1));
  await invariants(ff);
});

test("new groups form at first tab or target end with cycling colors and created events", async () => {
  const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }],
    tabs: [1, 2, 3, 4].map(id => ({ id, windowId: 1 })) });
  const log = logEvents(ff, ["tabGroups.onCreated"]);
  const id = await ff.browser.tabs.group({ tabIds: [2, 4] });
  assert.equal(ff.layout(1), `| 1 [${id}: 2 4] 3`);
  assert.deepEqual(await ff.browser.tabGroups.get(id), { id, windowId: 1, title: "", color: "blue", collapsed: false });
  const other = await ff.browser.tabs.group({ tabIds: [1], createProperties: { windowId: 2 } });
  assert.equal(ff.layout(2), `| [${other}: 1]`);
  assert.equal((await ff.browser.tabGroups.get(other)).color, "purple");
  const colors = [];
  for (let i = 0; i < 8; i++) {
    const tab = await ff.browser.tabs.create({ active: false });
    const group = await ff.browser.tabs.group({ tabIds: [tab.id] });
    colors.push((await ff.browser.tabGroups.get(group)).color);
  }
  assert.deepEqual(colors, ["cyan", "orange", "yellow", "pink", "green", "grey", "red", "blue"]);
  assert.equal(log.length, 0);
  await ff.settle();
  assert.equal(log.length, 10);
  await invariants(ff);
});

test("group placement defaults to the calling window rather than the first tab's window", async () => {
  const ff = createFirefox({ windows: [{ id: 1 }, { id: 2, focused: true }], currentWindowId: 1,
    tabs: [{ id: 1, windowId: 1 }, { id: 2, windowId: 1 }, { id: 3, windowId: 2 }, { id: 4, windowId: 2 }] });
  const id = await ff.browser.tabs.group({ tabIds: [3] });
  assert.equal((await ff.browser.tabGroups.get(id)).windowId, 1);
  assert.equal(ff.layout(1), `| 1 2 [${id}: 3]`);
  assert.equal(ff.layout(2), "| 4");
  await invariants(ff);
});

test("group placement anchors on the first listed tab already in the target window", async () => {
  const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }],
    tabs: [{ id: 1, windowId: 1 }, { id: 2, windowId: 1 }, { id: 3, windowId: 2 }, { id: 4, windowId: 2 }] });
  const id = await ff.browser.tabs.group({ tabIds: [3, 1], createProperties: { windowId: 1 } });
  assert.equal(ff.layout(1), `| [${id}: 3 1] 2`);
  assert.equal(ff.layout(2), "| 4");
  await invariants(ff);
});

for (const [anchor, want] of [[1, "| [102: 4 1] [101: 2] 3"], [2, "| [101: 1] [102: 4 2] 3"]]) {
  test(`group placement respects the old group boundary for local anchor ${anchor}`, async () => {
    const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }], groups: [{ id: 101, windowId: 1 }],
      tabs: [{ id: 1, windowId: 1, groupId: 101 }, { id: 2, windowId: 1, groupId: 101 },
        { id: 3, windowId: 1 }, { id: 4, windowId: 2 }, { id: 5, windowId: 2 }] });
    await ff.browser.tabs.group({ tabIds: [4, anchor], createProperties: { windowId: 1 } });
    assert.equal(ff.layout(1), want);
    assert.equal(ff.layout(2), "| 5");
    await invariants(ff);
  });
}

test("group placement leaves existing members where they are without membership or move events", async () => {
  const ff = strip();
  const log = logEvents(ff, ["tabs.onMoved", "tabs.onUpdated"]);
  await ff.browser.tabs.group({ tabIds: [3], groupId: 101 });
  assert.equal(ff.layout(1), "P1 | 2 [101: 3 4] 5");
  await ff.browser.tabs.group({ tabIds: [4, 3], groupId: 101 });
  assert.equal(ff.layout(1), "P1 | 2 [101: 3 4] 5");
  await ff.settle();
  assert.deepEqual(log, []);
  await ff.browser.tabs.group({ tabIds: [2], groupId: 101 });
  assert.equal(ff.layout(1), "P1 | [101: 2 3 4] 5");
  await ff.settle();
  assert.deepEqual(log.filter(e => e[0] === "tabs.onUpdated").map(e => [e[1], e[2]]), [[2, { groupId: 101 }]]);
  await invariants(ff);
});

test("group placement prepends before-tabs and appends after-tabs in tabIds order", async () => {
  const ff = createFirefox({ groups: [{ id: 101, windowId: 1 }],
    tabs: [1, 2, 3, 4, 5, 6, 7].map(id => ({ id, windowId: 1, groupId: id === 4 || id === 5 ? 101 : -1 })) });
  const log = logEvents(ff, ["tabs.onUpdated"]);
  await ff.browser.tabs.group({ tabIds: [3, 7, 1, 5, 2, 6, 4], groupId: 101 });
  assert.equal(ff.layout(1), "| [101: 3 1 2 4 5 7 6]");
  assert.deepEqual(log, []);
  await ff.settle();
  assert.deepEqual(log.map(e => [e[1], e[2]]),
    [[3, { groupId: 101 }], [1, { groupId: 101 }], [2, { groupId: 101 }],
      [7, { groupId: 101 }], [6, { groupId: 101 }]]);
  await invariants(ff);
});

test("group placement partitions local before-tabs from foreign and local after-tabs", async () => {
  const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }], groups: [{ id: 101, windowId: 1 }],
    tabs: [{ id: 1, windowId: 1 }, { id: 2, windowId: 1, groupId: 101 },
      { id: 3, windowId: 1 }, { id: 4, windowId: 2 }, { id: 5, windowId: 2 }] });
  await ff.browser.tabs.group({ tabIds: [4, 1, 2, 3], groupId: 101 });
  assert.equal(ff.layout(1), "| [101: 1 2 4 3]");
  assert.equal(ff.layout(2), "| 5");
  await invariants(ff);
});

for (const [createProperties, want] of [
  [undefined, "| 3 [101: 4 5 2]"],
  [{ windowId: 2 }, "| 3 [101: 2 4 5]"],
]) {
  test(`group placement partitions against the calling or explicit window, not the group's window (${JSON.stringify(createProperties)})`, async () => {
    const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }], currentWindowId: 1,
      groups: [{ id: 101, windowId: 2 }], tabs: [{ id: 1, windowId: 1 },
        { id: 2, windowId: 2 }, { id: 3, windowId: 2 },
        { id: 4, windowId: 2, groupId: 101 }, { id: 5, windowId: 2, groupId: 101 }] });
    await ff.browser.tabs.group({ tabIds: [2, 5], groupId: 101, createProperties });
    assert.equal(ff.layout(1), "| 1");
    assert.equal(ff.layout(2), want);
    await invariants(ff);
  });
}

for (const [currentWindowId, createProperties] of [[1, undefined], [2, { windowId: 1 }]]) {
  test(`group placement rejects undefined cross-window before-group moves (caller ${currentWindowId})`, async () => {
    const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }], currentWindowId,
      groups: [{ id: 101, windowId: 2 }], tabs: [{ id: 1, windowId: 1 }, { id: 2, windowId: 1 },
        { id: 3, windowId: 2 }, { id: 4, windowId: 2, groupId: 101 }, { id: 5, windowId: 2, groupId: 101 }] });
    const before = await ff.browser.windows.getAll({ populate: true });
    const log = logEvents(ff, ["tabs.onDetached", "tabs.onAttached", "tabs.onMoved", "tabs.onUpdated", "tabGroups.onRemoved"]);
    await assert.rejects(ff.browser.tabs.group({ tabIds: [1, 2], groupId: 101, createProperties }), {
      message: "tabs.group: moving tabs before a group in another window is undefined in Firefox 157",
    });
    assert.deepEqual(await ff.browser.windows.getAll({ populate: true }), before);
    await ff.settle();
    assert.deepEqual(log, []);
    // Equal indexes are tabsAfter, so this defined adoption remains supported.
    await ff.browser.tabs.group({ tabIds: [2], groupId: 101, createProperties });
    assert.equal(ff.layout(1), "| 1");
    assert.equal(ff.layout(2), "| 3 [101: 4 5 2]");
    await invariants(ff);
  });
}

test("group placement validates an explicit window even for an existing group", async () => {
  const ff = strip();
  await assert.rejects(ff.browser.tabs.group({ tabIds: [2], groupId: 101, createProperties: { windowId: 99 } }),
    { message: "Invalid window ID: 99" });
  assert.equal(ff.layout(1), "P1 | 2 [101: 3 4] 5");
});

test("ungroup preserves strip order and removes empty groups", async () => {
  const ff = strip();
  const log = logEvents(ff, ["tabs.onUpdated", "tabGroups.onRemoved"]);
  await ff.browser.tabs.ungroup([3, 4]);
  assert.equal(ff.layout(1), "P1 | 2 3 4 5");
  await ff.browser.tabs.ungroup(2);
  await ff.settle();
  assert.deepEqual(log.filter(e => e[0] === "tabs.onUpdated").map(e => e[2]), [{ groupId: -1 }, { groupId: -1 }]);
  assert.equal(log.filter(e => e[0] === "tabGroups.onRemoved").length, 1);
  await invariants(ff);
});

for (const [ids, want] of [
  [[3], "P1 | 2 3 [101: 4] 5"],
  [[4], "P1 | 2 [101: 3] 4 5"],
  [[3, 4], "P1 | 2 3 4 5"],
  [[4, 3], "P1 | 2 3 4 5"],
]) {
  test(`ungroup ${ids} uses the group boundary in index order`, async () => {
    const ff = strip();
    const log = logEvents(ff, ["tabs.onUpdated", "tabGroups.onRemoved"]);
    await ff.browser.tabs.ungroup(ids);
    assert.equal(ff.layout(1), want);
    assert.deepEqual(log, []);
    await ff.settle();
    assert.deepEqual(log.filter(e => e[0] === "tabs.onUpdated").map(e => [e[1], e[2], e[3].groupId]),
      [...ids].sort((a, b) => a - b).map(id => [id, { groupId: -1 }, -1]));
    assert.equal(log.filter(e => e[0] === "tabGroups.onRemoved").length, ids.length === 2 ? 1 : 0);
    await invariants(ff);
  });
}

test("ungroup processes groups independently and preserves nonselected members", async () => {
  const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }],
    groups: [{ id: 101, windowId: 1 }, { id: 102, windowId: 2 }],
    tabs: [{ id: 1, windowId: 1, groupId: 101 }, { id: 2, windowId: 1, groupId: 101 },
      { id: 3, windowId: 1, groupId: 101 }, { id: 4, windowId: 1 },
      { id: 5, windowId: 2, groupId: 102 }, { id: 6, windowId: 2, groupId: 102 },
      { id: 7, windowId: 2, groupId: 102 }, { id: 8, windowId: 2 }] });
  await ff.browser.tabs.ungroup([7, 3, 6, 1, 8]);
  assert.equal(ff.layout(1), "| 1 3 [101: 2] 4");
  assert.equal(ff.layout(2), "| [102: 5] 6 7 8");
  await invariants(ff);
});

test("remove emits tab removals then empty group and window removals", async () => {
  const ff = createFirefox({ groups: [{ id: 101, windowId: 1 }], tabs: [{ id: 1, windowId: 1, groupId: 101 }] });
  const log = logEvents(ff, ["tabs.onRemoved", "tabGroups.onRemoved", "windows.onRemoved"]);
  await ff.browser.tabs.remove(1);
  await ff.settle();
  assert.deepEqual(log.map(e => e[0]), ["tabs.onRemoved", "tabGroups.onRemoved", "windows.onRemoved"]);
  assert.deepEqual(log[0], ["tabs.onRemoved", 1, { windowId: 1, isWindowClosing: false }]);
  assert.deepEqual(await ff.browser.windows.getAll(), []);
});

test("discard ignores active tabs and onUpdated contains only actually changed keys", async () => {
  const ff = createFirefox({ tabs: [{ id: 1, windowId: 1 }, { id: 2, windowId: 1 }] });
  const log = logEvents(ff, ["tabs.onUpdated"]);
  await ff.browser.tabs.discard([1, 2]);
  assert.equal((await ff.browser.tabs.get(1)).discarded, false);
  assert.equal((await ff.browser.tabs.get(2)).discarded, true);
  await ff.browser.tabs.update(2, { url: "https://example.com/a", pinned: true });
  await ff.browser.tabs.update(2, { pinned: true });
  await ff.settle();
  assert.deepEqual(log.map(e => e[2]), [{ discarded: true },
    { url: "https://example.com/a", title: "https://example.com/a", pinned: true, discarded: false }]);
  assert.equal(log[0][3].discarded, true);
});

test("tabGroups query follows strip order, update emits snapshots and get returns copies", async () => {
  const ff = createFirefox({ groups: [{ id: 102, windowId: 1 }, { id: 101, windowId: 1 }],
    tabs: [{ id: 1, windowId: 1, groupId: 101 }, { id: 2, windowId: 1, groupId: 102 }] });
  assert.deepEqual((await ff.browser.tabGroups.query({ windowId: 1 })).map(g => g.id), [101, 102]);
  const log = logEvents(ff, ["tabGroups.onUpdated"]);
  const group = await ff.browser.tabGroups.update(101, { title: "Example", color: "green", collapsed: true });
  group.title = "mutated";
  assert.equal((await ff.browser.tabGroups.get(101)).title, "Example");
  await ff.settle();
  assert.deepEqual(log[0][1], { id: 101, windowId: 1, title: "Example", color: "green", collapsed: true });
  await assert.rejects(ff.browser.tabGroups.get(999));
});

test("whole-group same-window moves position first tab, clamp end and validate forward offset", async () => {
  const ff = createFirefox({ groups: [{ id: 101, windowId: 1 }, { id: 102, windowId: 1 }],
    tabs: [{ id: 1, windowId: 1, pinned: true }, { id: 2, windowId: 1, groupId: 101 },
      { id: 3, windowId: 1, groupId: 101 }, { id: 4, windowId: 1 },
      { id: 5, windowId: 1, groupId: 102 }, { id: 6, windowId: 1, groupId: 102 }, { id: 7, windowId: 1 }] });
  await assert.rejects(ff.browser.tabGroups.move(101, { index: 0 }),
    { message: "Cannot move the group to an index that is in the middle of pinned tabs." });
  await assert.rejects(ff.browser.tabGroups.move(101, { index: 3 }),
    { message: "Cannot move the group to an index that is in the middle of another group." });
  await ff.browser.tabGroups.move(101, { index: 2 });
  assert.equal(ff.layout(1), "P1 | 4 [101: 2 3] [102: 5 6] 7");
  await ff.browser.tabGroups.move(101, { index: 999 });
  assert.equal(ff.layout(1), "P1 | 4 [102: 5 6] 7 [101: 2 3]");
  await ff.browser.tabGroups.move(101, { index: 1 });
  assert.equal(ff.layout(1), "P1 | [101: 2 3] 4 [102: 5 6] 7");
  await ff.browser.tabGroups.move(101, { index: -1 });
  assert.equal(ff.layout(1), "P1 | 4 [102: 5 6] 7 [101: 2 3]");
  await invariants(ff);
});

test("whole-group adoption keeps identity and metadata, rejects splitting groups and closes source", async () => {
  const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }],
    groups: [{ id: 101, windowId: 1, title: "Example", color: "red" }, { id: 102, windowId: 2 }],
    tabs: [{ id: 1, windowId: 1, groupId: 101 }, { id: 2, windowId: 1, groupId: 101 },
      { id: 3, windowId: 2, groupId: 102 }, { id: 4, windowId: 2, groupId: 102 }] });
  const log = logEvents(ff, ["tabGroups.onMoved", "windows.onRemoved"]);
  await assert.rejects(ff.browser.tabGroups.move(101, { windowId: 2, index: 1 }),
    { message: "Cannot move the group to an index that is in the middle of another group." });
  const group = await ff.browser.tabGroups.move(101, { windowId: 2, index: -1 });
  assert.deepEqual(group, { id: 101, windowId: 2, title: "Example", color: "red", collapsed: false });
  assert.equal(ff.layout(1), "| ");
  assert.equal(ff.layout(2), "| [102: 3 4] [101: 1 2]");
  await ff.settle();
  assert.ok(log.some(e => e[0] === "tabGroups.onMoved" && e[1].windowId === 2));
  assert.ok(log.some(e => e[0] === "windows.onRemoved"));
  await invariants(ff);
});

test("windows expose current, last-focused, population and normal-type filtering", async () => {
  const ff = createFirefox({ windows: [{ id: 1 }, { id: 2, focused: true }], currentWindowId: 1,
    tabs: [{ id: 1, windowId: 1 }] });
  assert.equal((await ff.browser.windows.getCurrent()).id, 1);
  assert.equal((await ff.browser.windows.getLastFocused()).id, 2);
  assert.equal(ff.browser.windows.WINDOW_ID_NONE, -1);
  assert.deepEqual(await ff.browser.windows.getAll({ windowTypes: ["popup"] }), []);
  assert.equal((await ff.browser.windows.getAll({ populate: true }))[0].tabs[0].id, 1);
  const log = logEvents(ff, ["windows.onFocusChanged"]);
  await ff.browser.windows.update(1, { focused: true });
  assert.equal((await ff.browser.windows.getLastFocused()).id, 1);
  assert.equal((await ff.browser.windows.getAll())[1].focused, false);
  await ff.settle();
  assert.deepEqual(log, [["windows.onFocusChanged", 1]]);
});

test("closeWindow delivers all tabs then groups then window with closing flags", async () => {
  const ff = strip();
  const log = logEvents(ff, ["tabs.onRemoved", "tabGroups.onRemoved", "windows.onRemoved"]);
  await ff.closeWindow(1);
  assert.equal(log.length, 0);
  await ff.settle();
  assert.deepEqual(log.map(e => e[0]), [...Array(5).fill("tabs.onRemoved"), "tabGroups.onRemoved", "windows.onRemoved"]);
  assert.ok(log.slice(0, 5).every(e => e[2].isWindowClosing));
  assert.deepEqual(log[5][2], { isWindowClosing: true });
});

test("bookmark tree roots, seeded nodes, subtree, children and get return independent copies", async () => {
  const ff = createFirefox({ bookmarks: [{ title: "Folder", children: [{ title: "Page", url: "https://example.com/a" }] }] });
  const b = ff.browser.bookmarks;
  const tree = await b.getTree();
  assert.equal(tree[0].id, "root________");
  assert.deepEqual(tree[0].children.map(n => n.id), ["menu________", "toolbar_____", "unfiled_____", "mobile______"]);
  const [folder] = await b.getChildren("unfiled_____");
  assert.equal(folder.type, "folder");
  assert.equal(folder.id.length, 12);
  assert.equal(folder.parentId, "unfiled_____");
  assert.equal(folder.index, 0);
  assert.equal(typeof folder.dateAdded, "number");
  assert.equal(folder.children, undefined);
  const [subtree] = await b.getSubTree(folder.id);
  const child = subtree.children[0];
  assert.equal(child.type, "bookmark");
  assert.equal(child.url, "https://example.com/a");
  assert.equal((await b.get(child.id))[0].id, child.id);
  assert.deepEqual((await b.get([child.id, folder.id])).map(n => n.id), [child.id, folder.id]);
  subtree.children[0].title = "mutated";
  assert.equal((await b.get(child.id))[0].title, "Page");
});

test("bookmark create and search work, and update emits separate changed-field events", async () => {
  const ff = createFirefox();
  const b = ff.browser.bookmarks;
  const log = logEvents(ff, ["bookmarks.onCreated", "bookmarks.onChanged"]);
  const first = await b.create({ title: "Page", url: "https://example.com/a" });
  const second = await b.create({ index: 0, title: "Page", url: "https://example.com/b" });
  assert.equal(first.parentId, "unfiled_____");
  assert.deepEqual((await b.getChildren("unfiled_____")).map(n => n.id), [second.id, first.id]);
  assert.deepEqual((await b.search({ title: "Page", url: "https://example.com/a" })).map(n => n.id), [first.id]);
  assert.deepEqual(await b.search({ title: "Pag" }), []);
  await b.update(first.id, { title: "New", url: "https://example.com/c" });
  assert.equal(log.length, 0);
  await ff.settle();
  assert.deepEqual(log, [
    ["bookmarks.onCreated", first.id, first],
    ["bookmarks.onCreated", second.id, second],
    ["bookmarks.onChanged", first.id, { title: "New" }],
    ["bookmarks.onChanged", first.id, { url: "https://example.com/c" }],
  ]);
  log.length = 0;
  await b.update(first.id, { title: "New", url: "https://example.com/c" });
  await b.update(first.id, { title: "Title only" });
  await b.update(first.id, { url: "https://example.com/d" });
  await ff.settle();
  assert.deepEqual(log, [
    ["bookmarks.onChanged", first.id, { title: "Title only" }],
    ["bookmarks.onChanged", first.id, { url: "https://example.com/d" }],
  ]);
});

test("bookmark create rejects the root parent without mutating the tree or queuing events", async () => {
  const ff = createFirefox();
  const b = ff.browser.bookmarks;
  const tree = await b.getTree();
  const log = logEvents(ff, ["bookmarks.onCreated"]);
  for (const props of [{ title: "Folder" }, { title: "Page", url: "https://example.com/a" }]) {
    await assert.rejects(b.create({ parentId: "root________", ...props }));
  }
  assert.deepEqual(await b.getTree(), tree);
  await ff.settle();
  assert.deepEqual(log, []);
  for (const parentId of ["menu________", "toolbar_____", "unfiled_____", "mobile______"]) {
    const node = await b.create({ parentId, title: "Page", url: "https://example.com/a" });
    assert.equal(node.parentId, parentId);
  }
});

test("bookmark move reindexes siblings and emits old and new locations", async () => {
  const ff = createFirefox();
  const b = ff.browser.bookmarks;
  const folder = await b.create({ title: "Folder" });
  const a = await b.create({ title: "A", url: "https://example.com/a" });
  const c = await b.create({ title: "C", url: "https://example.com/c" });
  const log = logEvents(ff, ["bookmarks.onMoved"]);
  await b.move(c.id, { index: 0 });
  await b.move(a.id, { parentId: folder.id });
  await ff.settle();
  assert.deepEqual(log[0], ["bookmarks.onMoved", c.id,
    { parentId: "unfiled_____", index: 0, oldParentId: "unfiled_____", oldIndex: 2 }]);
  assert.deepEqual((await b.getChildren("unfiled_____")).map(n => [n.id, n.index]), [[c.id, 0], [folder.id, 1]]);
  assert.equal((await b.getChildren(folder.id))[0].id, a.id);
});

test("bookmark remove rejects nonempty folders and roots, removeTree recursively removes", async () => {
  const ff = createFirefox({ bookmarks: [{ title: "Folder", children: [{ title: "Page", url: "https://example.com/a" }] }] });
  const b = ff.browser.bookmarks;
  const [folder] = await b.getChildren("unfiled_____");
  const [child] = await b.getChildren(folder.id);
  const log = logEvents(ff, ["bookmarks.onRemoved"]);
  await assert.rejects(b.remove(folder.id));
  for (const root of ["root________", "menu________", "toolbar_____", "unfiled_____", "mobile______"]) {
    await assert.rejects(b.removeTree(root));
    await assert.rejects(b.remove(root));
  }
  await b.removeTree(folder.id);
  await ff.settle();
  assert.deepEqual(await b.getChildren("unfiled_____"), []);
  await assert.rejects(b.get(child.id));
  assert.ok(log.some(e => e[1] === folder.id && e[2].parentId === "unfiled_____" && e[2].node.title === "Folder"));
  const single = await b.create({ url: "https://example.com/b" });
  await b.remove(single.id);
  await assert.rejects(b.get(single.id));
});

test("bookmark URL checks reject script and data URLs on create and update", async () => {
  const b = createFirefox().browser.bookmarks;
  const node = await b.create({ url: "https://example.com/a" });
  for (const url of ["javascript:void(0)", "data:text/plain,x"]) {
    await assert.rejects(b.create({ url }));
    await assert.rejects(b.update(node.id, { url }));
  }
  assert.equal((await b.get(node.id))[0].url, "https://example.com/a");
});

test("storage get accepts all, string, array and default maps with JSON copies", async () => {
  const ff = createFirefox();
  const s = ff.browser.storage.local;
  const value = { nested: [1] };
  await s.set({ a: value, b: false });
  value.nested.push(2);
  assert.deepEqual(await s.get(), { a: { nested: [1] }, b: false });
  assert.deepEqual(await s.get(null), await s.get());
  assert.deepEqual(await s.get("missing"), {});
  assert.deepEqual(await s.get(["a", "missing"]), { a: { nested: [1] } });
  assert.deepEqual(await s.get({ a: 4, missing: [3] }), { a: { nested: [1] }, missing: [3] });
  const read = await s.get("a");
  read.a.nested.push(8);
  assert.deepEqual(await s.get("a"), { a: { nested: [1] } });
});

test("storage get omits missing undefined defaults and returns stored values over undefined defaults", async () => {
  const s = createFirefox().browser.storage.local;
  assert.deepEqual(await s.get({ k: undefined }), {});
  await s.set({ stored: 0 });
  assert.deepEqual(await s.get({ stored: undefined, missing: undefined, fallback: null, other: { nested: [1] } }),
    { stored: 0, fallback: null, other: { nested: [1] } });
});

test("storage set remove and clear emit local changes with old and new JSON values", async () => {
  const ff = createFirefox();
  const log = logEvents(ff, ["storage.onChanged"]);
  const s = ff.browser.storage.local;
  await s.set({ a: 1, b: 2 });
  await s.set({ a: 3 });
  await s.remove(["a", "absent"]);
  await s.clear();
  assert.equal(log.length, 0);
  await ff.settle();
  assert.deepEqual(log, [
    ["storage.onChanged", { a: { newValue: 1 }, b: { newValue: 2 } }, "local"],
    ["storage.onChanged", { a: { oldValue: 1, newValue: 3 } }, "local"],
    ["storage.onChanged", { a: { oldValue: 3 } }, "local"],
    ["storage.onChanged", { b: { oldValue: 2 } }, "local"],
  ]);
});

test("storage set emits every written key even when unchanged but missing remove and empty clear do not", async () => {
  const ff = createFirefox();
  const log = logEvents(ff, ["storage.onChanged"]);
  const s = ff.browser.storage.local;
  await s.set({ a: 1, b: { nested: [2] }, c: false });
  await ff.settle();
  log.length = 0;
  await s.set({ a: 1, b: { nested: [2] }, c: true });
  await s.set({ a: 1 });
  await s.set({});
  await s.remove("missing");
  assert.deepEqual(log, []);
  await ff.settle();
  assert.deepEqual(log, [
    ["storage.onChanged", { a: { oldValue: 1, newValue: 1 },
      b: { oldValue: { nested: [2] }, newValue: { nested: [2] } }, c: { oldValue: false, newValue: true } }, "local"],
    ["storage.onChanged", { a: { oldValue: 1, newValue: 1 } }, "local"],
  ]);
  await s.clear();
  await ff.settle();
  log.length = 0;
  await s.clear();
  await s.remove(["a", "b"]);
  await ff.settle();
  assert.deepEqual(log, []);
});

test("runtime supplies identity and URL and asynchronously returns first defined listener result", async () => {
  const ff = createFirefox({ extensionId: "example-extension" });
  const r = ff.browser.runtime;
  assert.equal(r.id, "example-extension");
  assert.equal(r.getURL("page.html"), "moz-extension://example-extension/page.html");
  const seen = [];
  r.onMessage.addListener(msg => { seen.push(msg); });
  r.onMessage.addListener(async () => "answer");
  r.onMessage.addListener(() => "later");
  const promise = r.sendMessage({ value: 1 });
  assert.deepEqual(seen, []);
  assert.equal(await promise, "answer");
  assert.deepEqual(seen, [{ value: 1 }]);
  assert.equal(await createFirefox().browser.runtime.sendMessage("none"), undefined);
});

test("events are queued, listeners can enqueue more and thrown errors remain visible", async () => {
  const ff = createFirefox();
  const log = [];
  const error = new Error("listener failure");
  const removed = () => log.push("removed");
  const e = ff.browser.runtime.onStartup;
  e.addListener(removed);
  assert.equal(e.hasListener(removed), true);
  e.removeListener(removed);
  assert.equal(e.hasListener(removed), false);
  e.addListener(() => { log.push("startup"); ff.fire("runtime.onInstalled", { reason: "install" }); });
  e.addListener(() => { throw error; });
  e.addListener(() => log.push("continued"));
  ff.browser.runtime.onInstalled.addListener(info => log.push(info.reason));
  ff.fire("runtime.onStartup");
  assert.deepEqual(log, []);
  await ff.settle();
  assert.deepEqual(log, ["startup", "continued", "install"]);
  assert.deepEqual(ff.errors, [error]);
});

test("settle guards runaway listeners after 10000 event deliveries", async () => {
  const ff = createFirefox();
  ff.browser.runtime.onStartup.addListener(() => ff.fire("runtime.onStartup"));
  ff.fire("runtime.onStartup");
  await assert.rejects(ff.settle(), /10000/);
});

test("calls capture API names and independent argument copies including sync runtime methods", async () => {
  const ff = createFirefox({ tabs: [{ id: 1, windowId: 1 }] });
  const props = { index: 0 };
  await ff.browser.tabs.move(1, props);
  props.index = 9;
  ff.browser.runtime.getURL("x");
  assert.deepEqual(ff.calls, [{ api: "tabs.move", args: [1, { index: 0 }] }, { api: "runtime.getURL", args: ["x"] }]);
});


test("new group from the last tab of an old block changes membership without splitting it", async () => {
  const ff = createFirefox({ groups: [{ id: 101, windowId: 1 }],
    tabs: [{ id: 1, windowId: 1, groupId: 101 }, { id: 2, windowId: 1, groupId: 101 },
      { id: 3, windowId: 1, groupId: 101 }, { id: 4, windowId: 1 }] });
  const id = await ff.browser.tabs.group({ tabIds: [3] });
  assert.equal(ff.layout(1), `| [101: 1 2] [${id}: 3] 4`);
  assert.equal((await ff.browser.tabs.get(3)).groupId, id);
  await invariants(ff);
});

test("new group from the middle of another block goes after its remaining members", async () => {
  const ff = createFirefox({ groups: [{ id: 101, windowId: 1 }],
    tabs: [{ id: 1, windowId: 1, groupId: 101 }, { id: 2, windowId: 1, groupId: 101 },
      { id: 3, windowId: 1, groupId: 101 }, { id: 4, windowId: 1 }] });
  const id = await ff.browser.tabs.group({ tabIds: [2] });
  assert.equal(ff.layout(1), `| [101: 1 3] [${id}: 2] 4`);
  await invariants(ff);
});

test("new groups unpin all-pinned selections before calculating the anchor", async () => {
  const ff = createFirefox({ tabs: [{ id: 1, windowId: 1, pinned: true },
    { id: 2, windowId: 1, pinned: true }, { id: 3, windowId: 1 }] });
  const id = await ff.browser.tabs.group({ tabIds: [2, 1] });
  assert.equal(ff.layout(1), `| [${id}: 2 1] 3`);
  await invariants(ff);
});

test("setup establishes pinned-first, contiguous groups, and first-tab activation per window", async () => {
  const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }], groups: [{ id: 101, windowId: 1 }],
    tabs: [{ id: 1, windowId: 1, groupId: 101 }, { id: 2, windowId: 1 },
      { id: 3, windowId: 1, groupId: 101 }, { id: 4, windowId: 1, pinned: true }, { id: 5, windowId: 2 }] });
  assert.equal(ff.layout(1), "P4 | [101: 1 3] 2");
  assert.deepEqual((await ff.browser.tabs.query({ groupId: 101 })).map(t => t.id), [1, 3]);
  assert.deepEqual((await ff.browser.tabs.query({ active: true })).map(t => t.id), [1, 5]);
  await invariants(ff);
});

test("removeTree exposes only the explicitly removed folder event, as Firefox does", async () => {
  const ff = createFirefox({ bookmarks: [{ title: "Folder", children: [{ title: "Nested", children: [
    { title: "Page", url: "https://example.com/a" }] }] }] });
  const [folder] = await ff.browser.bookmarks.getChildren("unfiled_____");
  const log = logEvents(ff, ["bookmarks.onRemoved"]);
  await ff.browser.bookmarks.removeTree(folder.id);
  await ff.settle();
  assert.deepEqual(log.map(e => e[1]), [folder.id]);
  assert.deepEqual(await ff.browser.bookmarks.search({ title: "Page" }), []);
});

test("invalid tab, group and window operations reject without corrupting strip state", async () => {
  const ff = strip();
  const expected = "P1 | 2 [101: 3 4] 5";
  for (const operation of [
    () => ff.browser.tabs.update(999, { pinned: true }),
    () => ff.browser.tabs.move([2, 999], { index: 0 }),
    () => ff.browser.tabs.move(2, { windowId: 999, index: 0 }),
    () => ff.browser.tabs.group({ tabIds: [2], groupId: 999 }),
    () => ff.browser.tabs.create({ windowId: 999 }),
    () => ff.browser.tabs.ungroup(999), () => ff.browser.tabs.remove(999), () => ff.browser.tabs.discard(999),
    () => ff.browser.tabGroups.update(999, { title: "Example" }),
    () => ff.browser.tabGroups.move(101, { windowId: 999, index: 0 }),
    () => ff.browser.windows.update(999, { focused: true }), () => ff.closeWindow(999),
  ]) {
    await assert.rejects(operation());
    assert.equal(ff.layout(1), expected);
  }
});

test("bookmark moves reject cycles and invalid parents without changing the tree", async () => {
  const ff = createFirefox();
  const b = ff.browser.bookmarks;
  const folder = await b.create({ title: "Folder" });
  const nested = await b.create({ parentId: folder.id, title: "Nested" });
  const leaf = await b.create({ parentId: nested.id, url: "https://example.com/a" });
  const tree = await b.getTree();
  await assert.rejects(b.move(folder.id, { parentId: nested.id }));
  await assert.rejects(b.move(folder.id, { parentId: folder.id }));
  await assert.rejects(b.move(folder.id, { parentId: leaf.id }));
  await assert.rejects(b.create({ parentId: leaf.id }));
  assert.deepEqual(await b.getTree(), tree);
});

test("async event listeners finish and their API-produced events drain in the same settle", async () => {
  const ff = createFirefox();
  const log = [];
  ff.browser.runtime.onStartup.addListener(async () => {
    await ff.browser.storage.local.set({ ready: true });
    log.push("startup");
  });
  ff.browser.storage.onChanged.addListener(changes => { changes.ready.newValue = false; log.push("first"); });
  ff.browser.storage.onChanged.addListener(changes => log.push(changes.ready.newValue));
  ff.fire("runtime.onStartup");
  await ff.settle();
  assert.deepEqual(log, ["startup", "first", true]);
  assert.deepEqual(await ff.browser.storage.local.get(), { ready: true });
});

test("runtime records listener failures, preserves false responses and still calls later listeners", async () => {
  const ff = createFirefox();
  const error = new Error("message failure"), seen = [];
  ff.browser.runtime.onMessage.addListener(() => { throw error; });
  ff.browser.runtime.onMessage.addListener(async () => false);
  ff.browser.runtime.onMessage.addListener(() => { seen.push("last"); return "not first"; });
  assert.equal(await ff.browser.runtime.sendMessage({ a: 1 }), false);
  assert.deepEqual(ff.errors, [error]);
  assert.deepEqual(seen, ["last"]);
});

test("storage defaults are detached and remove accepts a string", async () => {
  const ff = createFirefox();
  const s = ff.browser.storage.local, defaults = { a: { value: 1 } };
  const read = await s.get(defaults);
  read.a.value = 2;
  assert.equal(defaults.a.value, 1);
  await s.set({ a: 4 });
  await s.remove("a");
  assert.deepEqual(await s.get(), {});
});


test("same-window singleton moves are skipped, as Firefox's ext-tabs move does", async () => {
  const ff = createFirefox({ tabs: [{ id: 1, windowId: 1 }] });
  const log = logEvents(ff, ["tabs.onMoved"]);
  assert.deepEqual(await ff.browser.tabs.move(1, { index: -1 }), []);
  assert.equal(ff.layout(1), "| 1");
  await ff.settle();
  assert.deepEqual(log, []);
});

test("array moves track consecutive insertions separately for each default destination window", async () => {
  const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }], tabs: [
    { id: 1, windowId: 1 }, { id: 2, windowId: 1 }, { id: 3, windowId: 1 },
    { id: 4, windowId: 2 }, { id: 5, windowId: 2 }, { id: 6, windowId: 2 }] });
  await ff.browser.tabs.move([3, 6, 2, 5], { index: 0 });
  assert.equal(ff.layout(1), "| 3 2 1");
  assert.equal(ff.layout(2), "| 6 5 4");
  await invariants(ff);
});

test("messages from a configured page include the self tab in their sender snapshot", async () => {
  const ff = createFirefox({ selfTabId: 1, tabs: [{ id: 1, windowId: 1 }] });
  ff.browser.runtime.onMessage.addListener((msg, sender) => ({ id: sender.id, tabId: sender.tab?.id }));
  assert.deepEqual(await ff.browser.runtime.sendMessage({ type: "example" }), { id: "foxy-test", tabId: 1 });
});

test("new-group creation precedes membership events and closed-group snapshots keep metadata", async () => {
  const ff = createFirefox({ tabs: [{ id: 1, windowId: 1 }, { id: 2, windowId: 1 }] });
  const log = logEvents(ff, ["tabGroups.onCreated", "tabs.onUpdated", "tabGroups.onRemoved"]);
  const id = await ff.browser.tabs.group({ tabIds: [1, 2] });
  await ff.browser.tabGroups.update(id, { title: "Example", color: "red" });
  await ff.browser.tabs.ungroup([1, 2]);
  await ff.settle();
  assert.equal(log[0][0], "tabGroups.onCreated");
  assert.deepEqual(log.filter(e => e[0] === "tabs.onUpdated").map(e => e[2]),
    [{ groupId: id }, { groupId: id }, { groupId: -1 }, { groupId: -1 }]);
  assert.deepEqual(log.at(-1), ["tabGroups.onRemoved", { id, windowId: 1, title: "Example", color: "red", collapsed: false },
    { isWindowClosing: false }]);
});


test("adopting via group selects an active source tab while move and block preserve destination selection", async () => {
  for (const operation of ["move", "group", "block"]) {
    const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }],
      groups: [{ id: 101, windowId: 1 }, { id: 102, windowId: 2 }],
      tabs: [{ id: 1, windowId: 1, groupId: 101 }, { id: 2, windowId: 1 },
        { id: 3, windowId: 2, groupId: 102 }] });
    if (operation === "move") await ff.browser.tabs.move(1, { windowId: 2, index: -1 });
    if (operation === "group") await ff.browser.tabs.group({ tabIds: [1], groupId: 102 });
    if (operation === "block") await ff.browser.tabGroups.move(101, { windowId: 2, index: -1 });
    assert.equal((await ff.browser.tabs.get(1)).active, operation === "group", operation);
    assert.equal((await ff.browser.tabs.get(3)).active, operation !== "group", operation);
    assert.equal((await ff.browser.tabs.get(2)).active, true, operation);
    await invariants(ff);
  }
});

for (const kind of ["new", "existing"]) {
  for (const tabId of [1, 2]) {
    test(`group adoption selects only the active source tab ${tabId} into a ${kind} group`, async () => {
      const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }], groups: [{ id: 101, windowId: 2 }],
        tabs: [{ id: 1, windowId: 1 }, { id: 2, windowId: 1 }, { id: 3, windowId: 2, groupId: 101 }] });
      const log = logEvents(ff, ["tabs.onActivated", "tabs.onUpdated"]);
      const options = kind === "new" ? { createProperties: { windowId: 2 } } : { groupId: 101 };
      const id = await ff.browser.tabs.group({ tabIds: [tabId], ...options });
      assert.equal((await ff.browser.tabs.get(tabId)).active, tabId === 1);
      assert.equal((await ff.browser.tabs.get(3)).active, tabId !== 1);
      assert.equal((await ff.browser.tabs.get(tabId === 1 ? 2 : 1)).active, true);
      assert.equal(ff.layout(1), tabId === 1 ? "| 2" : "| 1");
      assert.equal(ff.layout(2), kind === "new" ? `| [101: 3] [${id}: ${tabId}]` : `| [101: 3 ${tabId}]`);
      assert.deepEqual(log, []);
      await ff.settle();
      assert.deepEqual(log.filter(e => e[0] === "tabs.onActivated" && e[1].windowId === 2),
        tabId === 1 ? [["tabs.onActivated", { tabId: 1, windowId: 2 }]] : []);
      assert.deepEqual(log.filter(e => e[0] === "tabs.onUpdated").map(e => [e[1], e[2], e[3].active]),
        [[tabId, { groupId: id }, tabId === 1]]);
      await invariants(ff);
    });
  }
}

test("group adoption uses source selection for each tab as the source becomes empty", async () => {
  const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }], groups: [{ id: 101, windowId: 2 }],
    tabs: [{ id: 1, windowId: 1 }, { id: 2, windowId: 1 }, { id: 3, windowId: 2, groupId: 101 }] });
  await ff.browser.tabs.group({ tabIds: [1, 2], groupId: 101 });
  assert.deepEqual((await ff.browser.tabs.query({ windowId: 2, active: true })).map(t => t.id), [2]);
  assert.equal(ff.layout(1), "| ");
  assert.equal(ff.layout(2), "| [101: 3 1 2]");
  assert.deepEqual((await ff.browser.windows.getAll()).map(w => w.id), [2]);
  await invariants(ff);
});

test("automatic activation after removal loads a discarded tab and emits its discarded change", async () => {
  const ff = createFirefox({ tabs: [{ id: 1, windowId: 1 }, { id: 2, windowId: 1, discarded: true }] });
  const log = logEvents(ff, ["tabs.onUpdated"]);
  await ff.browser.tabs.remove(1);
  assert.equal((await ff.browser.tabs.get(2)).active, true);
  assert.equal((await ff.browser.tabs.get(2)).discarded, false);
  await ff.settle();
  assert.deepEqual(log.map(e => [e[1], e[2]]), [[2, { discarded: false }]]);
});


test("creating the first tab in an empty fixture window leaves it ungrouped", async () => {
  const ff = createFirefox();
  const tab = await ff.browser.tabs.create({ url: "https://example.com/a" });
  assert.equal(tab.groupId, -1);
  assert.equal(tab.index, 0);
  assert.equal(tab.active, true);
  assert.equal(ff.layout(1), `| ${tab.id}`);
  await invariants(ff);
});


test("overlapping API calls snapshot return values at each operation, not after later mutations", async () => {
  const ff = strip();
  const firstGroup = ff.browser.tabGroups.update(101, { title: "First" });
  const secondGroup = ff.browser.tabGroups.update(101, { title: "Second" });
  assert.equal((await firstGroup).title, "First");
  assert.equal((await secondGroup).title, "Second");
  const firstBookmark = ff.browser.bookmarks.create({ title: "First" });
  const secondBookmark = ff.browser.bookmarks.create({ title: "Second", index: 0 });
  assert.equal((await firstBookmark).index, 0);
  assert.equal((await secondBookmark).index, 0);
});


test("settle waits for in-flight message listeners and drains events they queue", async () => {
  const ff = createFirefox(), log = [];
  ff.browser.runtime.onMessage.addListener(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await ff.browser.storage.local.set({ ready: true });
    return "ready";
  });
  ff.browser.storage.onChanged.addListener(() => log.push("storage"));
  const response = ff.browser.runtime.sendMessage({ type: "example" });
  await ff.settle();
  assert.deepEqual(log, ["storage"]);
  assert.equal(await response, "ready");
});

// Catch lost durable data, surviving listeners, or unchanged ids at restart.
test("session storage supports defaults, snapshots, changes, removal and clear", async () => {
  const ff = createFirefox(), api = ff.browser;
  const changes = logEvents(ff, ["storage.onChanged"]);
  await api.storage.session.set({ marker: { ready: true }, other: 2 });
  const result = await api.storage.session.get({ marker: null, absent: 3 });
  assert.deepEqual(result, { marker: { ready: true }, absent: 3 });
  result.marker.ready = false;
  assert.deepEqual(await api.storage.session.get("marker"), { marker: { ready: true } });
  await api.storage.session.remove("marker");
  await api.storage.session.clear();
  await ff.settle();
  assert.deepEqual(await api.storage.session.get(), {});
  assert.deepEqual(changes.map(([, , area]) => area), ["session", "session", "session"]);
  assert.deepEqual(changes[1][1], { marker: { oldValue: { ready: true } } });
});

test("restart with restore retains windows, pins and bookmark/local data but changes ids and clears listeners/session", async () => {
  const ff = strip(), api = ff.browser;
  await api.storage.local.set({ durable: 1 });
  await api.storage.session.set({ marker: true });
  const folder = await api.bookmarks.create({ title: "Keep" });
  let oldListener = 0, startup = 0;
  api.runtime.onStartup.addListener(() => oldListener++);
  api.tabs.onCreated.addListener(() => oldListener++);
  const before = await api.tabs.query({});
  await ff.restart({ restore: true });
  api.runtime.onStartup.addListener(() => startup++);
  await ff.settle();
  const after = await api.tabs.query({});
  assert.equal(oldListener, 0);
  assert.equal(startup, 1);
  assert.deepEqual(await api.storage.session.get(), {});
  assert.deepEqual(await api.storage.local.get(), { durable: 1 });
  assert.equal((await api.bookmarks.get(folder.id))[0].title, "Keep");
  assert.equal(after.length, before.length);
  assert.ok(after.every(t => !before.some(old => old.id === t.id)));
  assert.equal(after.filter(t => t.pinned).length, 1);
  assert.notEqual((await api.tabGroups.query({}))[0].id, 101);
  await invariants(ff);
});

test("restart without restore leaves one home tab and durable bookmarks/local storage", async () => {
  const ff = strip(), api = ff.browser;
  await api.storage.local.set({ durable: true });
  const folder = await api.bookmarks.create({ title: "Keep" });
  await ff.restart({ restore: false });
  await ff.settle();
  assert.equal((await api.windows.getAll()).length, 1);
  const tabs = await api.tabs.query({});
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].url, "about:home");
  assert.ok(tabs[0].id > 5);
  assert.deepEqual(await api.tabGroups.query({}), []);
  assert.deepEqual(await api.storage.local.get(), { durable: true });
  assert.equal((await api.bookmarks.get(folder.id))[0].title, "Keep");
});
