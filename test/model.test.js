import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel, colorKey, formatDate, formatTime, msUntilNextMinute } from "../extension/src/model.js";

const tab = (id, index, extra = {}) => ({
  id,
  index,
  pinned: false,
  hidden: false,
  groupId: -1,
  title: `Tab ${id}`,
  url: `https://example.com/${id}`,
  favIconUrl: `https://example.com/${id}.ico`,
  ...extra,
});

test("pinned tabs come out in tab order as {id, title, icon}", () => {
  const tabs = [tab(2, 1, { pinned: true }), tab(1, 0, { pinned: true }), tab(3, 2)];
  const { pinned } = buildModel(tabs, [], 99);
  assert.deepEqual(pinned, [
    { id: 1, title: "Tab 1", icon: "https://example.com/1.ico" },
    { id: 2, title: "Tab 2", icon: "https://example.com/2.ico" },
  ]);
});

test("groups are ordered by their first tab and keep tab order inside", () => {
  const tabs = [
    tab(1, 0, { groupId: 20 }),
    tab(2, 1, { groupId: 10 }),
    tab(3, 2, { groupId: 20 }),
    tab(4, 3, { groupId: 10 }),
  ];
  const groups = [
    { id: 10, title: "Ten", color: "blue" },
    { id: 20, title: "Twenty", color: "red" },
  ];
  const model = buildModel(tabs, groups, 99);
  assert.deepEqual(model.groups.map((g) => g.id), [20, 10]);
  assert.deepEqual(model.groups[0].tabs.map((t) => t.id), [1, 3]);
  assert.deepEqual(model.groups[1].tabs.map((t) => t.id), [2, 4]);
  assert.deepEqual(Object.keys(model.groups[0]).sort(), ["color", "id", "tabs", "title"]);
  assert.equal(model.groups[0].title, "Twenty");
  assert.equal(model.groups[0].color, "red");
});

test("ungrouped, hidden and the page's own tab are left out", () => {
  const tabs = [
    tab(1, 0),
    tab(2, 1, { groupId: 10, hidden: true }),
    tab(3, 2, { groupId: 10 }),
    tab(99, 3, { groupId: 10 }),
  ];
  const model = buildModel(tabs, [{ id: 10, title: "G", color: "green" }], 99);
  assert.deepEqual(model.pinned, []);
  assert.deepEqual(model.groups[0].tabs.map((t) => t.id), [3]);
});

test("a group with no tabs left to show is dropped", () => {
  const tabs = [tab(99, 0, { groupId: 10 })];
  const model = buildModel(tabs, [{ id: 10, title: "G", color: "green" }], 99);
  assert.deepEqual(model.groups, []);
});

test("pinned tabs never count as group members", () => {
  const tabs = [tab(1, 0, { pinned: true, groupId: 10 }), tab(2, 1, { groupId: 10 })];
  const model = buildModel(tabs, [{ id: 10, title: "G", color: "green" }], 99);
  assert.deepEqual(model.pinned.map((t) => t.id), [1]);
  assert.deepEqual(model.groups[0].tabs.map((t) => t.id), [2]);
});

test("tabs without a groupId are treated as ungrouped", () => {
  const tabs = [{ id: 1, index: 0, pinned: false, title: "x" }];
  assert.deepEqual(buildModel(tabs, [], 99), { pinned: [], groups: [] });
});

test("title falls back to the URL, then to an empty string; a missing icon is null", () => {
  const tabs = [
    tab(1, 0, { pinned: true, title: "", favIconUrl: undefined }),
    tab(2, 1, { pinned: true, title: undefined, url: undefined, favIconUrl: "" }),
  ];
  assert.deepEqual(buildModel(tabs, [], 99).pinned, [
    { id: 1, title: "https://example.com/1", icon: null },
    { id: 2, title: "", icon: null },
  ]);
});

test("blank group names become 'Unnamed group'; names are trimmed", () => {
  const tabs = [tab(1, 0, { groupId: 10 }), tab(2, 1, { groupId: 11 }), tab(3, 2, { groupId: 12 })];
  const groups = [
    { id: 10, title: "", color: "red" },
    { id: 11, title: "  Work  ", color: "red" },
    { id: 12, color: "red" },
  ];
  assert.deepEqual(
    buildModel(tabs, groups, 99).groups.map((g) => g.title),
    ["Unnamed group", "Work", "Unnamed group"],
  );
});

test("colorKey maps grey to gray and unknown colors to gray", () => {
  for (const color of ["blue", "cyan", "green", "orange", "pink", "purple", "red", "yellow"]) {
    assert.equal(colorKey(color), color);
  }
  assert.equal(colorKey("grey"), "gray");
  assert.equal(colorKey("gray"), "gray");
  assert.equal(colorKey("magenta"), "gray");
  assert.equal(colorKey(undefined), "gray");
});

test("formatTime is 24-hour HH:MM with leading zeros", () => {
  assert.equal(formatTime(new Date(2026, 8, 30, 0, 0, 0)), "00:00");
  assert.equal(formatTime(new Date(2026, 8, 30, 9, 5, 59)), "09:05");
  assert.equal(formatTime(new Date(2026, 8, 30, 17, 24)), "17:24");
  assert.equal(formatTime(new Date(2026, 8, 30, 23, 59)), "23:59");
});

test("formatDate is WEEKDAY D MONTH in English capitals", () => {
  assert.equal(formatDate(new Date(2026, 8, 30)), "WEDNESDAY 30 SEPTEMBER");
  assert.equal(formatDate(new Date(2027, 0, 3)), "SUNDAY 3 JANUARY");
});

test("msUntilNextMinute counts to the next :00", () => {
  assert.equal(msUntilNextMinute(new Date(2026, 8, 30, 12, 0, 0, 0)), 60000);
  assert.equal(msUntilNextMinute(new Date(2026, 8, 30, 12, 0, 59, 999)), 1);
  assert.equal(msUntilNextMinute(new Date(2026, 8, 30, 12, 0, 30, 250)), 29750);
});
