import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBoard } from "../extension/src/board/model.js";
import { resolveTabTarget, slotFromPointer } from "../extension/src/board/targets.js";
import { createFirefox } from "./fakes/firefox.js";

async function fixture() {
  const { browser } = createFirefox({
    windows: [{ id: 2 }, { id: 3 }, { id: 1 }],
    groups: [
      { id: 202, windowId: 2 }, { id: 102, windowId: 1 },
      { id: 301, windowId: 3 }, { id: 201, windowId: 2 }, { id: 101, windowId: 1 },
    ],
    tabs: [
      { id: 11, windowId: 1, pinned: true }, { id: 12, windowId: 1, pinned: true },
      { id: 13, windowId: 1, groupId: 101 }, { id: 14, windowId: 1, groupId: 101 },
      { id: 15, windowId: 1, groupId: 102 }, { id: 16, windowId: 1 }, { id: 17, windowId: 1 },
      { id: 99, windowId: 1 },
      { id: 21, windowId: 2, pinned: true }, { id: 22, windowId: 2, pinned: true },
      { id: 23, windowId: 2, groupId: 201 }, { id: 24, windowId: 2, groupId: 201 },
      { id: 25, windowId: 2, groupId: 202 }, { id: 26, windowId: 2 }, { id: 27, windowId: 2 },
      { id: 31, windowId: 3, pinned: true }, { id: 33, windowId: 3, groupId: 301 },
      { id: 36, windowId: 3 },
    ].map(tab => ({ ...tab, lastAccessed: { 1: 1, 2: 300, 3: 200 }[tab.windowId] })),
  });
  return buildBoard({
    windows: await browser.windows.getAll(),
    tabs: await browser.tabs.query({}),
    groups: await browser.tabGroups.query({}),
    currentWindowId: 1, selfTabId: 99,
  });
}

for (const [slot, windowId, beforeTabId] of [
  [0, 1, 16], [1, 1, 17], [2, 1, null], [3, 2, 27], [4, 2, null], [5, 3, null],
]) {
  test(`TABS slot ${slot} resolves top, interior, boundary or end to the adjacent window`, async () => {
    assert.deepEqual(resolveTabTarget(await fixture(), { zone: "tabs", slot, tabId: 13 }, 1), {
      kind: "tabs", windowId, beforeTabId,
    });
  });
}

for (const [slot, beforeTabId] of [[0, 11], [1, 12], [2, null], [3, null], [4, null], [5, null]]) {
  test(`PINNED slot ${slot} stays here or redirects foreign-window pins to the current window's end`, async () => {
    assert.deepEqual(resolveTabTarget(await fixture(), { zone: "pinned", slot, tabId: 13 }, 1), {
      kind: "pinned", windowId: 1, beforeTabId,
    });
  });
}

test("a column's top stays local when the current window has no rows", async () => {
  const board = await fixture();
  board.tabs.shift();
  board.pinned.shift();
  assert.deepEqual(resolveTabTarget(board, { zone: "tabs", slot: 0, tabId: 13 }, 1), {
    kind: "tabs", windowId: 1, beforeTabId: null,
  });
  assert.deepEqual(resolveTabTarget(board, { zone: "pinned", slot: 0, tabId: 13 }, 1), {
    kind: "pinned", windowId: 1, beforeTabId: null,
  });
});

test("empty PINNED and TABS columns resolve to the supplied current window with no before tab", async () => {
  const board = await fixture();
  board.pinned = [];
  board.tabs = [];
  for (const zone of ["pinned", "tabs"]) {
    assert.deepEqual(resolveTabTarget(board, { zone, slot: 0, tabId: 13 }, 7), {
      kind: zone, windowId: 7, beforeTabId: null,
    });
  }
});

for (const [groupId, slot, windowId, beforeTabId] of [
  [101, 0, 1, 13], [101, 1, 1, 14], [101, 2, 1, null],
  [201, 0, 2, 23], [201, 1, 2, 24], [201, 2, 2, null],
]) {
  test(`group ${groupId} slot ${slot} targets that group's own window and row`, async () => {
    assert.deepEqual(resolveTabTarget(await fixture(), { zone: "group", groupId, slot, tabId: 16 }, 1), {
      kind: "group", groupId, windowId, beforeTabId,
    });
  });
}

test("NEW GROUP always targets the supplied current window", async () => {
  assert.deepEqual(resolveTabTarget(await fixture(), { zone: "new-group", tabId: 13 }, 7), {
    kind: "new-group", windowId: 7,
  });
});

test("a group missing from the board cannot be a tab drop target", async () => {
  assert.equal(resolveTabTarget(await fixture(), { zone: "group", groupId: 999, slot: 0, tabId: 13 }, 1), null);
});

for (const [zone, groupId, tabId, ownSlot, followingSlot] of [
  ["group", 101, 13, 0, 1], ["group", 101, 14, 1, 2],
  ["group", 201, 24, 1, 2],
  ["tabs", undefined, 16, 0, 1], ["tabs", undefined, 17, 1, 2],
  ["tabs", undefined, 27, 3, 4],
  ["pinned", undefined, 11, 0, 1], ["pinned", undefined, 12, 1, 2],
]) {
  test(`${zone} tab ${tabId} dropped just before or just after itself is a no-op`, async () => {
    const board = await fixture();
    assert.equal(resolveTabTarget(board, { zone, groupId, tabId, slot: ownSlot }, 1), null);
    assert.equal(resolveTabTarget(board, { zone, groupId, tabId, slot: followingSlot }, 1), null);
  });
}

test("the final loose tab is a no-op at the end, but moves windows at the boundary above it", async () => {
  const board = await fixture();
  assert.equal(resolveTabTarget(board, { zone: "tabs", slot: 5, tabId: 36 }, 1), null);
  assert.deepEqual(resolveTabTarget(board, { zone: "tabs", slot: 4, tabId: 36 }, 1), {
    kind: "tabs", windowId: 2, beforeTabId: null,
  });
});

test("the last local pin is a no-op when foreign pin slots redirect to the local end", async () => {
  const board = await fixture();
  for (const slot of [2, 3, 4, 5]) {
    assert.equal(resolveTabTarget(board, { zone: "pinned", slot, tabId: 12 }, 1), null);
  }
  assert.deepEqual(resolveTabTarget(board, { zone: "pinned", slot: 4, tabId: 11 }, 1), {
    kind: "pinned", windowId: 1, beforeTabId: null,
  });
});

test("a foreign pinned tab at the row above a slot still moves to the current window", async () => {
  assert.deepEqual(resolveTabTarget(await fixture(), { zone: "pinned", slot: 3, tabId: 21 }, 1), {
    kind: "pinned", windowId: 1, beforeTabId: null,
  });
});

test("dropping before a foreign pinned tab itself still moves it here after redirection", async () => {
  assert.deepEqual(resolveTabTarget(await fixture(), { zone: "pinned", slot: 2, tabId: 21 }, 1), {
    kind: "pinned", windowId: 1, beforeTabId: null,
  });
});

test("a move into a different zone or a non-adjacent slot is not suppressed", async () => {
  const board = await fixture();
  assert.deepEqual(resolveTabTarget(board, { zone: "group", groupId: 101, slot: 2, tabId: 17 }, 1), {
    kind: "group", groupId: 101, windowId: 1, beforeTabId: null,
  });
  assert.deepEqual(resolveTabTarget(board, { zone: "tabs", slot: 0, tabId: 17 }, 1), {
    kind: "tabs", windowId: 1, beforeTabId: 16,
  });
});

test("target resolution leaves the board and drops unchanged", async () => {
  const board = await fixture();
  const drop = { zone: "tabs", slot: 2, tabId: 13 };
  const before = structuredClone({ board, drop });
  resolveTabTarget(board, drop, 1);
  assert.deepEqual({ board, drop }, before);
});

test("pointer slots count only midpoints strictly above the pointer, including exact boundaries", () => {
  const midpoints = [10, 30, 50];
  for (const [y, expected] of [[-1, 0], [10, 0], [11, 1], [30, 1], [31, 2], [50, 2], [51, 3]]) {
    assert.equal(slotFromPointer(midpoints, y), expected, `y=${y}`);
  }
  assert.equal(slotFromPointer([], 31), 0);
  assert.deepEqual(midpoints, [10, 30, 50]);
});
