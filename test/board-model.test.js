import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBoard } from "../extension/src/board/model.js";
import { createFirefox } from "./fakes/firefox.js";

async function snapshot(setup = {}) {
  const { browser } = createFirefox(setup);
  return {
    windows: await browser.windows.getAll(),
    tabs: await browser.tabs.query({}),
    groups: await browser.tabGroups.query({}),
    currentWindowId: setup.currentWindowId ?? 1,
    selfTabId: setup.selfTabId ?? 99,
  };
}

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("window order puts the current window first, then highest tab access time, then lower id", async () => {
  const input = await snapshot({
    windows: [{ id: 4 }, { id: 3 }, { id: 2 }, { id: 1 }, { id: 5 }],
    tabs: [
      { id: 41, windowId: 4, lastAccessed: 400 },
      { id: 31, windowId: 3, lastAccessed: 200 },
      { id: 21, windowId: 2, lastAccessed: 200 },
      { id: 22, windowId: 2, lastAccessed: 10 },
      { id: 11, windowId: 1, lastAccessed: 1 },
    ],
  });
  assert.deepEqual(buildBoard(input).windowOrder, [1, 4, 2, 3, 5]);
});

test("recency includes hidden tabs and the self tab, even though they are not rows", async () => {
  const input = await snapshot({
    windows: [{ id: 1 }, { id: 2 }, { id: 3 }],
    tabs: [
      { id: 11, windowId: 1, lastAccessed: 1 },
      { id: 21, windowId: 2, lastAccessed: 10 },
      { id: 22, windowId: 2, lastAccessed: 500 },
      { id: 99, windowId: 3, lastAccessed: 600 },
      { id: 31, windowId: 3, lastAccessed: 20 },
    ],
  });
  input.tabs.find(tab => tab.id === 22).hidden = true;
  const board = buildBoard(input);
  assert.deepEqual(board.windowOrder, [1, 3, 2]);
  assert.deepEqual(board.tabs.flatMap(section => section.rows.map(row => row.id)), [11, 31, 21]);
});

test("only non-private normal windows contribute sections or group columns", async () => {
  // The fake always returns normal, non-private windows. Annotate its detached
  // snapshots to cover API states outside that fake's supported subset.
  const input = await snapshot({
    windows: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    groups: [
      { id: 102, windowId: 2 }, { id: 103, windowId: 3 }, { id: 104, windowId: 4 },
    ],
    tabs: [
      { id: 11, windowId: 1 },
      { id: 21, windowId: 2, pinned: true }, { id: 22, windowId: 2, groupId: 102 },
      { id: 31, windowId: 3 }, { id: 32, windowId: 3, groupId: 103 },
      { id: 41, windowId: 4 }, { id: 42, windowId: 4, groupId: 104 },
    ],
  });
  input.windows.find(win => win.id === 2).incognito = true;
  input.windows.find(win => win.id === 3).type = "popup";
  input.windows.find(win => win.id === 4).type = "panel";
  assert.deepEqual(buildBoard(input), {
    windowOrder: [1], pinned: [], columns: [], saved: [], missing: [],
    tabs: [{ windowId: 1, current: true, rows: [{
      id: 11, windowId: 1, index: 0, title: "about:blank", url: "about:blank",
      icon: null, pinned: false, groupId: -1, active: true,
    }] }],
  });
});

test("group columns follow window order and first-tab index, with rows in strip order", async () => {
  const input = await snapshot({
    windows: [{ id: 2 }, { id: 1 }],
    groups: [
      { id: 10, windowId: 1, title: "Later", color: "blue" },
      { id: 30, windowId: 2, title: "Remote", color: "red" },
      { id: 20, windowId: 1, title: "First", color: "grey", collapsed: true },
    ],
    tabs: [
      { id: 1, windowId: 1, groupId: 20 }, { id: 2, windowId: 1, groupId: 20 },
      { id: 3, windowId: 1, groupId: 10 }, { id: 4, windowId: 2, groupId: 30 },
    ],
  });
  input.tabs.reverse();
  const board = buildBoard(input);
  assert.deepEqual(board.columns.map(column => [column.id, column.windowId, column.current]), [
    [20, 1, true], [10, 1, true], [30, 2, false],
  ]);
  assert.deepEqual(board.columns[0], {
    id: 20, windowId: 1, current: true, title: "First", color: "gray", apiColor: "grey", collapsed: true,
    rows: [
      { id: 1, windowId: 1, index: 0, title: "about:blank", url: "about:blank", icon: null,
        pinned: false, groupId: 20, active: true },
      { id: 2, windowId: 1, index: 1, title: "about:blank", url: "about:blank", icon: null,
        pinned: false, groupId: 20, active: false },
    ],
  });
  assert.equal(board.columns[1].collapsed, false);
});

test("empty group titles stay empty for the renderer's unnamed placeholder", async () => {
  const input = await snapshot({
    groups: [
      { id: 10, windowId: 1, title: "" },
      { id: 20, windowId: 1, title: "  Work  " },
    ],
    tabs: [{ id: 1, windowId: 1, groupId: 10 }, { id: 2, windowId: 1, groupId: 20 }],
  });
  assert.deepEqual(buildBoard(input).columns.map(column => column.title), ["", "  Work  "]);
});

test("self and hidden tabs are excluded from all zones, and empty groups and sections disappear", async () => {
  const input = await snapshot({
    windows: [{ id: 1 }, { id: 2 }, { id: 3 }],
    groups: [{ id: 10, windowId: 1 }, { id: 20, windowId: 1 }, { id: 30, windowId: 1 }],
    tabs: [
      { id: 1, windowId: 1, pinned: true },
      { id: 2, windowId: 1, groupId: 10 }, { id: 3, windowId: 1, groupId: 10 },
      { id: 99, windowId: 1, groupId: 20 }, { id: 4, windowId: 1, groupId: 30 },
      { id: 5, windowId: 2 },
    ],
  });
  for (const tab of input.tabs) if ([1, 2, 4, 5].includes(tab.id)) tab.hidden = true;
  const board = buildBoard(input);
  assert.deepEqual(board.pinned, []);
  assert.deepEqual(board.tabs, []);
  assert.deepEqual(board.columns.map(column => [column.id, column.rows.map(row => row.id)]), [[10, [3]]]);
  assert.equal(board.windowOrder.length, 3);
  input.selfTabId = 3;
  input.tabs.find(tab => tab.id === 99).hidden = true;
  assert.deepEqual(buildBoard(input).columns, []);
  input.selfTabId = 1;
  input.tabs.find(tab => tab.id === 1).hidden = false;
  assert.deepEqual(buildBoard(input).pinned, []);
  input.selfTabId = 5;
  input.tabs.find(tab => tab.id === 5).hidden = false;
  assert.deepEqual(buildBoard(input).tabs, []);
});

test("pinned and loose tabs get one non-empty section per window, in board and strip order", async () => {
  const input = await snapshot({
    windows: [{ id: 3 }, { id: 2 }, { id: 1 }, { id: 4 }],
    groups: [{ id: 10, windowId: 1 }, { id: 40, windowId: 4 }],
    tabs: [
      { id: 11, windowId: 1, pinned: true, lastAccessed: 1 },
      { id: 12, windowId: 1, pinned: true, lastAccessed: 1 },
      { id: 13, windowId: 1, groupId: 10, lastAccessed: 1 },
      { id: 14, windowId: 1, lastAccessed: 1 }, { id: 15, windowId: 1, lastAccessed: 1 },
      { id: 21, windowId: 2, pinned: true, lastAccessed: 100 }, { id: 22, windowId: 2, lastAccessed: 100 },
      { id: 31, windowId: 3, lastAccessed: 200 },
      { id: 41, windowId: 4, groupId: 40, lastAccessed: 10 },
    ],
  });
  input.tabs.reverse();
  const board = buildBoard(input);
  const sections = list => list.map(section => [section.windowId, section.current, section.rows.map(row => row.id)]);
  assert.deepEqual(board.windowOrder, [1, 3, 2, 4]);
  assert.deepEqual(sections(board.pinned), [[1, true, [11, 12]], [2, false, [21]]]);
  assert.deepEqual(sections(board.tabs), [[1, true, [14, 15]], [3, false, [31]], [2, false, [22]]]);
});

test("rows retain move and activation metadata, with URL and icon fallbacks", async () => {
  const input = await snapshot({
    tabs: [
      { id: 1, windowId: 1, pinned: true, title: "", url: "https://example.com/1", active: true },
      { id: 2, windowId: 1, title: "Named", url: "https://example.com/2", favIconUrl: "https://example.com/2.ico" },
      { id: 3, windowId: 1, title: "", favIconUrl: "" },
    ],
  });
  delete input.tabs[2].url;
  delete input.tabs[2].groupId;
  const board = buildBoard(input);
  assert.deepEqual(board.pinned[0].rows, [{
    id: 1, windowId: 1, index: 0, title: "https://example.com/1", url: "https://example.com/1",
    icon: null, pinned: true, groupId: -1, active: true,
  }]);
  assert.deepEqual(board.tabs[0].rows, [
    { id: 2, windowId: 1, index: 1, title: "Named", url: "https://example.com/2",
      icon: "https://example.com/2.ico", pinned: false, groupId: -1, active: false },
    { id: 3, windowId: 1, index: 2, title: "", url: "", icon: null, pinned: false, groupId: -1, active: false },
  ]);
});

test("pinned tabs never become group members, even if an input has a stale groupId", async () => {
  const input = await snapshot({
    groups: [{ id: 10, windowId: 1 }],
    tabs: [{ id: 1, windowId: 1, pinned: true }, { id: 2, windowId: 1, groupId: 10 }],
  });
  input.tabs[0].groupId = 10;
  const board = buildBoard(input);
  assert.deepEqual(board.pinned[0].rows.map(row => row.id), [1]);
  assert.deepEqual(board.columns[0].rows.map(row => row.id), [2]);
});

test("building a board does not mutate input snapshots", async () => {
  const input = await snapshot({
    groups: [{ id: 10, windowId: 1 }],
    tabs: [{ id: 1, windowId: 1, groupId: 10 }, { id: 2, windowId: 1 }],
  });
  input.tabs.reverse();
  const before = structuredClone(input);
  buildBoard(freeze(input));
  assert.deepEqual(input, before);
});

for (const suffix of ["", "?q=self", "#page", "?q=self#page"]) {
  test(`${suffix ? `review minor 4: selfUrl ${suffix}` : "selfUrl"} excludes every Foxy page, ignoring query and hash, while retaining selfTabId filtering`, async () => {
    const selfUrl = "moz-extension://foxy-test/newtab.html";
    const input = await snapshot({
      windows: [{ id: 1 }, { id: 2 }],
      groups: [{ id: 101, windowId: 1 }, { id: 201, windowId: 2 }],
      tabs: [
        { id: 1, windowId: 1, pinned: true, url: `${selfUrl}?q=one#pin` },
        { id: 2, windowId: 1, groupId: 101, url: `${selfUrl}#group` },
        { id: 3, windowId: 1, url: selfUrl },
        { id: 99, windowId: 1, url: "https://example.com/self" },
        { id: 4, windowId: 1, url: "moz-extension://foxy-test/other.html" },
        { id: 5, windowId: 2, pinned: true, url: selfUrl },
        { id: 6, windowId: 2, groupId: 201, url: `${selfUrl}?q=two` },
        { id: 7, windowId: 2, url: `${selfUrl}#remote` },
        { id: 8, windowId: 2, url: "moz-extension://other/newtab.html" },
      ],
    });
    input.selfUrl = `${selfUrl}${suffix}`;
    const before = structuredClone(input);
    const board = buildBoard(freeze(input));
    assert.deepEqual(board.pinned, []);
    assert.deepEqual(board.columns, []);
    assert.deepEqual(board.tabs.map(section => [section.windowId, section.rows.map(row => row.id)]), [
      [1, [4]], [2, [8]],
    ]);
    assert.deepEqual(input, before);
  });
}

test("saved and missing default to empty arrays before the background answers", async () => {
  const input = await snapshot();
  const board = buildBoard({ ...input, saved: undefined, missing: undefined });
  assert.deepEqual(board.saved, []);
  assert.deepEqual(board.missing, []);
});

test("saved and missing preserve folder order, literal titles and API colours without changing tab zones", async () => {
  const input = await snapshot({
    groups: [{ id: 10, windowId: 1 }],
    tabs: [{ id: 1, windowId: 1, pinned: true }, { id: 2, windowId: 1, groupId: 10 }, { id: 3, windowId: 1 }],
  });
  const saved = [
    { folderId: "z", title: "  Work  ", color: "grey", count: 4, cantReopen: ["about:config"] },
    { folderId: "a", title: "", color: "red", count: 0, cantReopen: [] },
  ];
  const missing = [{ folderId: "a", title: "", color: "red" }, { folderId: "z", title: "  Work  ", color: "grey" }];
  const before = structuredClone({ ...input, saved, missing });
  const { saved: actualSaved, missing: actualMissing, ...zones } = buildBoard(freeze({ ...input, saved, missing }));
  assert.deepEqual(actualSaved, saved);
  assert.deepEqual(actualMissing, missing.map(group => ({ ...group, count: 0, cantReopen: [] })));
  const { saved: ignoredSaved, missing: ignoredMissing, ...originalZones } = buildBoard(input);
  assert.deepEqual(zones, originalZones);
  assert.deepEqual({ ...input, saved, missing }, before);
});

// Passing raw partial entries through leaves trim/length unsafe in the renderer.
test("saved and missing normalise malformed entries and drop absent folder identities without mutation", () => {
  const entries = [null, {}, { folderId: "" }, { folderId: 12 },
    { folderId: "partial", title: 42, color: "grey", count: "4", cantReopen: null },
    { folderId: "valid", title: "  Work  ", color: "red", count: 4, cantReopen: ["about:config", null] },
    { folderId: "nonfinite", count: Infinity, cantReopen: "about:config" }];
  const input = freeze({ windows: [], tabs: [], groups: [], saved: entries, missing: entries });
  const before = structuredClone(input);
  const board = buildBoard(input);
  const expected = [
    { folderId: "partial", title: "", color: "grey", count: 0, cantReopen: [] },
    { folderId: "valid", title: "  Work  ", color: "red", count: 4, cantReopen: ["about:config"] },
    { folderId: "nonfinite", title: "", count: 0, cantReopen: [] },
  ];
  assert.deepEqual(board.saved, expected); assert.deepEqual(board.missing, expected);
  assert.deepEqual(input, before);
  for (const malformed of [null, {}, "wrong"]) {
    const empty = buildBoard({ windows: [], tabs: [], groups: [], saved: malformed, missing: malformed });
    assert.deepEqual(empty.saved, []); assert.deepEqual(empty.missing, []);
  }
});

test("no eligible windows gives an empty board, without inventing a current window", () => {
  assert.deepEqual(buildBoard({ windows: [], tabs: [], groups: [], currentWindowId: 1, selfTabId: 99 }), {
    windowOrder: [], pinned: [], columns: [], tabs: [], saved: [], missing: [],
  });
});
