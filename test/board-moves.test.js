import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { buildBoard } from "../extension/src/board/model.js";
import { resolveTabTarget, resolveGroupTarget } from "../extension/src/board/targets.js";
import {
  dropTab, dropGroup, bringGroupHere, openTab, closeTabs, closeGroup, renameGroup, recolorGroup,
} from "../extension/src/board/moves.js";

const W1 = "P1 P2 | 3 [101: 4 5] 6 [102: 7 8] 9";
const W2 = "P11 P12 | 13 [201: 14 15] 16 [202: 17 18] 19";
function fixture(selfTabId) {
  return createFirefox({
    selfTabId,
    windows: [{ id: 1, focused: true }, { id: 2 }], currentWindowId: 1,
    groups: [101, 102, 201, 202].map(id => ({ id, windowId: id < 200 ? 1 : 2 })),
    tabs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19].map(id => ({
      id, windowId: id < 10 ? 1 : 2, pinned: [1, 2, 11, 12].includes(id),
      groupId: ({ 4: 101, 5: 101, 7: 102, 8: 102, 14: 201, 15: 201, 17: 202, 18: 202 })[id] ?? -1,
    })),
  });
}
async function layouts(ff, one = W1, two = W2) {
  await ff.settle();
  assert.equal(ff.layout(1), one);
  assert.equal(ff.layout(2), two);
  assert.deepEqual(ff.errors, []);
}
async function board(ff) {
  return buildBoard({ windows: await ff.browser.windows.getAll(), tabs: await ff.browser.tabs.query({}),
    groups: await ff.browser.tabGroups.query({}), currentWindowId: 1 });
}

// Each literal catches a wrong placement branch, missing unpin/ungroup, or
// missing neighbour-membership correction. No expected layout uses a helper.
for (const [name, tabId, groupId, beforeTabId, one, two = W2] of [
  ["unpins before first member", 1, 101, 4, "P2 | 3 [101: 1 4 5] 6 [102: 7 8] 9"],
  ["unpins at end", 1, 101, null, "P2 | 3 [101: 4 5 1] 6 [102: 7 8] 9"],
  ["places a loose before-tab in the middle", 3, 101, 5, "P1 P2 | [101: 4 3 5] 6 [102: 7 8] 9"],
  ["places a loose before-tab at end", 3, 101, null, "P1 P2 | [101: 4 5 3] 6 [102: 7 8] 9"],
  ["places an after-tab before first", 9, 101, 4, "P1 P2 | 3 [101: 9 4 5] 6 [102: 7 8]"],
  ["moves a member forwards to end", 4, 101, null, "P1 P2 | 3 [101: 5 4] 6 [102: 7 8] 9"],
  ["moves a member backwards to first", 5, 101, 4, "P1 P2 | 3 [101: 5 4] 6 [102: 7 8] 9"],
  ["moves from another group before first", 7, 101, 4, "P1 P2 | 3 [101: 7 4 5] 6 [102: 8] 9"],
  ["adopts a pin before first", 1, 201, 14, "P2 | 3 [101: 4 5] 6 [102: 7 8] 9", "P11 P12 | 13 [201: 1 14 15] 16 [202: 17 18] 19"],
  ["adopts a loose tab at end", 3, 201, null, "P1 P2 | [101: 4 5] 6 [102: 7 8] 9", "P11 P12 | 13 [201: 14 15 3] 16 [202: 17 18] 19"],
  ["adopts a grouped tab in the middle", 4, 201, 15, "P1 P2 | 3 [101: 5] 6 [102: 7 8] 9", "P11 P12 | 13 [201: 14 4 15] 16 [202: 17 18] 19"],
  ["adopts a foreign member here before first", 14, 101, 4, "P1 P2 | 3 [101: 14 4 5] 6 [102: 7 8] 9", "P11 P12 | 13 [201: 15] 16 [202: 17 18] 19"],
]) {
  test(`group drop ${name}`, async () => {
    const ff = fixture();
    assert.deepEqual(await dropTab(ff.browser, tabId, {
      kind: "group", groupId, windowId: groupId < 200 ? 1 : 2, beforeTabId,
    }), { ok: true });
    await layouts(ff, one, two);
  });
}

for (const [name, tabId, windowId, beforeTabId, one, two = W2] of [
  ["unpins before first loose tab", 1, 1, 3, "P2 | 1 3 [101: 4 5] 6 [102: 7 8] 9"],
  ["unpins near the end", 2, 1, 9, "P1 | 3 [101: 4 5] 6 [102: 7 8] 2 9"],
  ["ungroups first member before first loose tab", 4, 1, 3, "P1 P2 | 4 3 [101: 5] 6 [102: 7 8] 9"],
  ["ungroups last member before middle loose tab", 5, 1, 6, "P1 P2 | 3 [101: 4] 5 6 [102: 7 8] 9"],
  ["moves loose tab forwards and corrects neighbour membership", 3, 1, 9, "P1 P2 | [101: 4 5] 6 [102: 7 8] 3 9"],
  ["moves loose tab backwards", 9, 1, 3, "P1 P2 | 9 3 [101: 4 5] 6 [102: 7 8]"],
  ["appends loose tab forwards", 3, 1, null, "P1 P2 | [101: 4 5] 6 [102: 7 8] 9 3"],
  ["ungroups and appends", 4, 1, null, "P1 P2 | 3 [101: 5] 6 [102: 7 8] 9 4"],
  ["unpins and appends", 1, 1, null, "P2 | 3 [101: 4 5] 6 [102: 7 8] 9 1"],
  ["adopts a pin before loose tab", 1, 2, 13, "P2 | 3 [101: 4 5] 6 [102: 7 8] 9", "P11 P12 | 1 13 [201: 14 15] 16 [202: 17 18] 19"],
  ["adopts a grouped tab before loose tab", 4, 2, 16, "P1 P2 | 3 [101: 5] 6 [102: 7 8] 9", "P11 P12 | 13 [201: 14 15] 4 16 [202: 17 18] 19"],
  ["adopts a loose tab at end", 3, 2, null, "P1 P2 | [101: 4 5] 6 [102: 7 8] 9", "P11 P12 | 13 [201: 14 15] 16 [202: 17 18] 19 3"],
  ["adopts a pin at end", 11, 1, null, "P1 P2 | 3 [101: 4 5] 6 [102: 7 8] 9 11", "P12 | 13 [201: 14 15] 16 [202: 17 18] 19"],
]) {
  test(`TABS drop ${name}`, async () => {
    const ff = fixture();
    assert.deepEqual(await dropTab(ff.browser, tabId, { kind: "tabs", windowId, beforeTabId }), { ok: true });
    await layouts(ff, one, two);
  });
}

for (const [name, kind, tabId, beforeTabId, prepare, one, two = W2] of [
  ["group anchor closed", "group", 3, 4, api => api.tabs.remove(4),
    "P1 P2 | [101: 5 3] 6 [102: 7 8] 9"],
  ["group anchor left the group", "group", 3, 4, api => api.tabs.group({ tabIds: [4], groupId: 102 }),
    "P1 P2 | [101: 5 3] 6 [102: 4 7 8] 9"],
  ["TABS anchor closed after render", "tabs", 4, 9, api => api.tabs.remove(9),
    "P1 P2 | 3 [101: 5] 6 4 [102: 7 8]"],
  ["TABS anchor became pinned", "tabs", 4, 9, api => api.tabs.update(9, { pinned: true }),
    "P1 P2 P9 | 3 [101: 5] 6 4 [102: 7 8]"],
  ["TABS anchor moved to another window", "tabs", 4, 9, api => api.tabs.move(9, { windowId: 2, index: -1 }),
    "P1 P2 | 3 [101: 5] 6 4 [102: 7 8]", "P11 P12 | 13 [201: 14 15] 16 [202: 17 18] 19 9"],
  ["PINNED anchor closed", "pinned", 11, 2, api => api.tabs.remove(2),
    "P1 P11 | 3 [101: 4 5] 6 [102: 7 8] 9", "P12 | 13 [201: 14 15] 16 [202: 17 18] 19"],
]) {
  test(`review minor 2: ${name} falls back to the target end`, async t => {
    const ff = fixture();
    t.mock.method(console, "warn", () => {});
    await prepare(ff.browser);
    assert.deepEqual(await dropTab(ff.browser, tabId, {
      kind, windowId: 1, groupId: 101, beforeTabId,
    }), { ok: true });
    await layouts(ff, one, two);
  });
}

for (const [name, prepare, one, two] of [
  ["became unpinned", async api => {
    await api.tabs.update(2, { pinned: false });
    await api.tabs.move(2, { index: -1 });
  }, "P3 P1 | 4 6 2", "| 5"],
  ["moved to another window", api => api.tabs.move(2, { windowId: 2, index: 0 }),
    "P3 P1 | 4 6", "P2 | 5"],
]) {
  test(`review minor 2: PINNED anchor ${name} falls back to the local pinned end`, async () => {
    const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }],
      tabs: [{ id: 1, windowId: 1, pinned: true }, { id: 2, windowId: 1, pinned: true },
        { id: 3, windowId: 1, pinned: true }, { id: 4, windowId: 1 }, { id: 6, windowId: 1 }, { id: 5, windowId: 2 }] });
    await prepare(ff.browser);
    assert.deepEqual(await dropTab(ff.browser, 1, { kind: "pinned", windowId: 1, beforeTabId: 2 }), { ok: true });
    await layouts(ff, one, two);
  });
}

for (const [tabId, pinned, groupId] of [[1, true, -1], [2, false, -1], [3, false, 102]]) {
  test(`TABS adopts ${pinned ? "pinned" : groupId !== -1 ? "grouped" : "loose"} tab into a window with no loose tabs`, async () => {
    const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }],
      groups: [{ id: 101, windowId: 1 }, ...(groupId === -1 ? [] : [{ id: 102, windowId: 2 }])],
      tabs: [{ id: 4, windowId: 1, pinned: true }, { id: 5, windowId: 1, groupId: 101 },
        { id: tabId, windowId: 2, pinned, groupId }, { id: 6, windowId: 2 }] });
    assert.deepEqual(await dropTab(ff.browser, tabId, { kind: "tabs", windowId: 1, beforeTabId: null }), { ok: true });
    await layouts(ff, `P4 | [101: 5] ${tabId}`, "| 6");
  });
}

for (const [tabId, one] of [
  [1, "| [101: 4 5] [102: 7 8] 1"],
  [4, "P1 | [101: 5] [102: 7 8] 4"],
]) {
  test(`empty local TABS moves tab ${tabId} to the end, not next to itself after leaving its old zone`, async () => {
    const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }],
      groups: [{ id: 101, windowId: 1 }, { id: 102, windowId: 1 }],
      tabs: [{ id: 1, windowId: 1, pinned: true }, { id: 4, windowId: 1, groupId: 101 },
        { id: 5, windowId: 1, groupId: 101 }, { id: 7, windowId: 1, groupId: 102 },
        { id: 8, windowId: 1, groupId: 102 }, { id: 3, windowId: 2 }] });
    const target = resolveTabTarget(await board(ff), { zone: "tabs", slot: 0, tabId }, 1);
    assert.deepEqual(target, { kind: "tabs", windowId: 1, beforeTabId: null });
    assert.deepEqual(await dropTab(ff.browser, tabId, target), { ok: true });
    await layouts(ff, one, "| 3");
  });
}

test("TABS appends after the last loose tab, not after a trailing group, and corrects membership", async () => {
  const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }], groups: [{ id: 101, windowId: 1 }],
    tabs: [{ id: 1, windowId: 1 }, { id: 2, windowId: 1, groupId: 101 },
      { id: 3, windowId: 1, groupId: 101 }, { id: 4, windowId: 2 }, { id: 5, windowId: 2 }] });
  assert.deepEqual(await dropTab(ff.browser, 4, { kind: "tabs", windowId: 1, beforeTabId: null }), { ok: true });
  await layouts(ff, "| 1 4 [101: 2 3]", "| 5");
  assert.ok(ff.calls.some(call => call.api === "tabs.ungroup"));
});

for (const [name, tabId, beforeTabId, one, two = W2] of [
  ["moves a local pin backwards", 2, 1, "P2 P1 | 3 [101: 4 5] 6 [102: 7 8] 9"],
  ["moves a local pin to the end (step 4b)", 1, null, "P2 P1 | 3 [101: 4 5] 6 [102: 7 8] 9"],
  ["pins a loose tab before first", 3, 1, "P3 P1 P2 | [101: 4 5] 6 [102: 7 8] 9"],
  ["pins a loose tab at end", 3, null, "P1 P2 P3 | [101: 4 5] 6 [102: 7 8] 9"],
  ["pins a grouped tab in the middle", 4, 2, "P1 P4 P2 | 3 [101: 5] 6 [102: 7 8] 9"],
  ["pins a grouped tab at end", 4, null, "P1 P2 P4 | 3 [101: 5] 6 [102: 7 8] 9"],
  ["adopts a foreign pin before first", 11, 1, "P11 P1 P2 | 3 [101: 4 5] 6 [102: 7 8] 9", "P12 | 13 [201: 14 15] 16 [202: 17 18] 19"],
  ["adopts a foreign pin at end", 11, null, "P1 P2 P11 | 3 [101: 4 5] 6 [102: 7 8] 9", "P12 | 13 [201: 14 15] 16 [202: 17 18] 19"],
  ["adopts and pins a foreign loose tab before first", 13, 1, "P13 P1 P2 | 3 [101: 4 5] 6 [102: 7 8] 9", "P11 P12 | [201: 14 15] 16 [202: 17 18] 19"],
  ["adopts and pins a foreign grouped tab at end", 14, null, "P1 P2 P14 | 3 [101: 4 5] 6 [102: 7 8] 9", "P11 P12 | 13 [201: 15] 16 [202: 17 18] 19"],
]) {
  test(`PINNED drop ${name}`, async () => {
    const ff = fixture();
    assert.deepEqual(await dropTab(ff.browser, tabId, { kind: "pinned", windowId: 1, beforeTabId }), { ok: true });
    await layouts(ff, one, two);
  });
}

test("PINNED can pin into a window without existing pins", async () => {
  const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }], tabs: [
    { id: 1, windowId: 1 }, { id: 2, windowId: 2, pinned: true }, { id: 3, windowId: 2 },
  ] });
  assert.deepEqual(await dropTab(ff.browser, 2, { kind: "pinned", windowId: 1, beforeTabId: null }), { ok: true });
  await layouts(ff, "P2 | 1", "| 3");
});

for (const [tabId, one, two = W2] of [
  [1, "P2 | [203: 1] 3 [101: 4 5] 6 [102: 7 8] 9"],
  [3, "P1 P2 | [203: 3] [101: 4 5] 6 [102: 7 8] 9"],
  [4, "P1 P2 | 3 [203: 4] [101: 5] 6 [102: 7 8] 9"],
  [5, "P1 P2 | 3 [101: 4] [203: 5] 6 [102: 7 8] 9"],
  [11, "P1 P2 | 3 [101: 4 5] 6 [102: 7 8] 9 [203: 11]", "P12 | 13 [201: 14 15] 16 [202: 17 18] 19"],
  [13, "P1 P2 | 3 [101: 4 5] 6 [102: 7 8] 9 [203: 13]", "P11 P12 | [201: 14 15] 16 [202: 17 18] 19"],
  [14, "P1 P2 | 3 [101: 4 5] 6 [102: 7 8] 9 [203: 14]", "P11 P12 | 13 [201: 15] 16 [202: 17 18] 19"],
]) {
  test(`NEW GROUP creates a local group from tab ${tabId}`, async () => {
    const ff = fixture();
    assert.deepEqual(await dropTab(ff.browser, tabId, { kind: "new-group", windowId: 1 }), { ok: true, groupId: 203 });
    await layouts(ff, one, two);
    assert.deepEqual(await ff.browser.tabGroups.get(203), { id: 203, windowId: 1, title: "", color: "blue", collapsed: false });
  });
}

for (const [name, groupId, windowId, beforeGroupId, one, two = W2] of [
  ["forwards before another group", 101, 1, 102, "P1 P2 | 3 6 [101: 4 5] [102: 7 8] 9"],
  ["backwards before another group", 102, 1, 101, "P1 P2 | 3 [102: 7 8] [101: 4 5] 6 9"],
  ["to local end", 101, 1, null, "P1 P2 | 3 6 [102: 7 8] 9 [101: 4 5]"],
  ["to another window before its group", 101, 2, 201, "P1 P2 | 3 6 [102: 7 8] 9", "P11 P12 | 13 [101: 4 5] [201: 14 15] 16 [202: 17 18] 19"],
  ["to another window end", 101, 2, null, "P1 P2 | 3 6 [102: 7 8] 9", "P11 P12 | 13 [201: 14 15] 16 [202: 17 18] 19 [101: 4 5]"],
]) {
  test(`group column moves ${name}`, async () => {
    const ff = fixture();
    assert.equal(await dropGroup(ff.browser, groupId, { windowId, beforeGroupId }), true);
    await layouts(ff, one, two);
  });
}

for (const [name, prepare, one, two] of [
  ["moved out of the target window", api => api.tabGroups.move(201, { windowId: 1, index: 2 }),
    "P1 P2 | [201: 14 15] 3 6 [102: 7 8] 9", "P11 P12 | 13 16 [202: 17 18] 19 [101: 4 5]"],
  ["closed after render", api => api.tabs.remove([14, 15]),
    "P1 P2 | 3 6 [102: 7 8] 9", "P11 P12 | 13 16 [202: 17 18] 19 [101: 4 5]"],
]) {
  test(`review minor 3: before group ${name} falls back to the target window end`, async () => {
    const ff = fixture();
    await prepare(ff.browser);
    assert.equal(await dropGroup(ff.browser, 101, { windowId: 2, beforeGroupId: 201 }), true);
    await layouts(ff, one, two);
    assert.deepEqual(ff.calls.filter(call => call.api === "tabGroups.move").at(-1).args,
      [101, { windowId: 2, index: -1 }]);
  });
}

test("group column forwards offset uses the dragged group's full size", async () => {
  const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }], groups: [101, 102, 103].map(id => ({ id, windowId: 1 })),
    tabs: [{ id: 1, windowId: 1, groupId: 101 }, { id: 2, windowId: 1, groupId: 101 },
      { id: 3, windowId: 1, groupId: 101 }, { id: 4, windowId: 1, groupId: 102 },
      { id: 5, windowId: 1, groupId: 103 }, { id: 6, windowId: 2 }] });
  assert.equal(await dropGroup(ff.browser, 101, { windowId: 1, beforeGroupId: 103 }), true);
  await layouts(ff, "| [102: 4] [101: 1 2 3] [103: 5]", "| 6");
});

test("bring here keeps a group's identity and metadata, appending after the current window's last tab", async () => {
  const ff = fixture();
  await ff.browser.tabGroups.update(201, { title: "Work", color: "red", collapsed: true });
  assert.equal(await bringGroupHere(ff.browser, 201, 1), true);
  await layouts(ff, "P1 P2 | 3 [101: 4 5] 6 [102: 7 8] 9 [201: 14 15]", "P11 P12 | 13 16 [202: 17 18] 19");
  assert.deepEqual(await ff.browser.tabGroups.get(201), { id: 201, windowId: 1, title: "Work", color: "red", collapsed: true });
  assert.equal(ff.calls.some(call => call.api === "runtime.sendMessage" || call.api === "tabs.remove"), false);
});

for (const drop of [
  { zone: "group", groupId: 101, tabId: 4, slot: 0 },
  { zone: "group", groupId: 101, tabId: 4, slot: 1 },
  { zone: "group", groupId: 101, tabId: 5, slot: 2 },
  { zone: "tabs", tabId: 3, slot: 0 }, { zone: "tabs", tabId: 3, slot: 1 },
  { zone: "tabs", tabId: 9, slot: 3 }, { zone: "tabs", tabId: 19, slot: 6 },
  { zone: "pinned", tabId: 1, slot: 0 }, { zone: "pinned", tabId: 1, slot: 1 },
  { zone: "pinned", tabId: 2, slot: 2 }, { zone: "pinned", tabId: 2, slot: 4 },
]) {
  test(`no-op ${JSON.stringify(drop)} makes no API calls`, async () => {
    const ff = fixture(), target = resolveTabTarget(await board(ff), drop, 1);
    ff.calls.length = 0;
    assert.equal(target, null);
    assert.deepEqual(await dropTab(ff.browser, drop.tabId, target), { ok: true });
    assert.deepEqual(ff.calls, []);
    await layouts(ff);
  });
}
for (const [groupId, slot] of [[101, 0], [101, 1], [102, 2], [201, 2], [201, 3], [202, 4]]) {
  test(`no-op group ${groupId} slot ${slot} makes no API calls`, async () => {
    const ff = fixture(), target = resolveGroupTarget(await board(ff), groupId, slot, 1);
    ff.calls.length = 0;
    assert.equal(target, null);
    assert.equal(await dropGroup(ff.browser, groupId, target), true);
    assert.deepEqual(ff.calls, []);
    await layouts(ff);
  });
}

test("a foreign PINNED slot redirects a local first pin to the local end", async () => {
  const ff = fixture(), target = resolveTabTarget(await board(ff), { zone: "pinned", tabId: 1, slot: 3 }, 1);
  assert.deepEqual(target, { kind: "pinned", windowId: 1, beforeTabId: null });
  assert.deepEqual(await dropTab(ff.browser, 1, target), { ok: true });
  await layouts(ff, "P2 P1 | 3 [101: 4 5] 6 [102: 7 8] 9");
});

function openFixture() {
  return createFirefox({ windows: [{ id: 1, focused: true }, { id: 2 }], selfTabId: 99,
    tabs: [{ id: 1, windowId: 1, pinned: true }, { id: 2, windowId: 1 },
      { id: 99, windowId: 1, active: true }, { id: 3, windowId: 2, pinned: true }, { id: 4, windowId: 2 }] });
}
for (const [tabId, one, two, focused] of [
  [2, "P1 | 2 99", "P3 | 4", 1], [4, "P1 | 2 99", "P3 | 4", 2], [3, "P1 P3 | 2 99", "| 4", 1],
]) {
  test(`open tab ${tabId} activates, focuses or adopts pins without closing when preserving history`, async () => {
    const ff = openFixture(), row = await ff.browser.tabs.get(tabId);
    assert.equal(await openTab(ff.browser, row, { id: 99, windowId: 1 }, { close: false }), true);
    await layouts(ff, one, two);
    assert.equal((await ff.browser.tabs.get(tabId)).active, true);
    assert.equal((await ff.browser.windows.getLastFocused()).id, focused);
    assert.equal(ff.calls.some(call => call.api === "runtime.sendMessage" || call.api === "tabs.remove"), false);
    if (tabId === 4) {
      const activation = ff.calls.findIndex(call => call.api === "tabs.update");
      const focus = ff.calls.findIndex(call => call.api === "windows.update");
      assert.ok(activation < focus);
    }
  });
}

test("open tab delegates the only-history-entry close after switching", async () => {
  const ff = openFixture();
  ff.browser.runtime.onMessage.addListener(async message => {
    if (message.type === "blank-and-close") await ff.browser.tabs.remove(99);
  });
  assert.equal(await openTab(ff.browser, await ff.browser.tabs.get(2), { id: 99, windowId: 1 }, { close: true }), true);
  await layouts(ff, "P1 | 2", "P3 | 4");
  assert.equal((await ff.browser.tabs.get(2)).active, true);
  assert.equal(ff.calls.filter(call => call.api === "runtime.sendMessage").length, 1);
});

test("review critical 1: foreign window is focused even when the close message never settles", async t => {
  const ff = openFixture();
  const send = t.mock.method(ff.browser.runtime, "sendMessage", () => new Promise(() => {}));
  void openTab(ff.browser, await ff.browser.tabs.get(4), { id: 99, windowId: 1 }, { close: true });
  // Drain the finite API promise chain, without awaiting the intentionally pending close.
  await new Promise(resolve => setImmediate(resolve));
  await layouts(ff, "P1 | 2 99", "P3 | 4");
  assert.equal((await ff.browser.tabs.get(4)).active, true);
  assert.equal((await ff.browser.windows.getLastFocused()).id, 2);
  assert.equal(ff.calls.filter(call => call.api === "windows.update").length, 1);
  assert.equal(send.mock.callCount(), 1);
});

test("review critical 1: activation and foreign focus finish before requesting page close", async () => {
  const ff = openFixture();
  ff.browser.runtime.onMessage.addListener(async message => {
    if (message.type !== "blank-and-close") return;
    assert.equal((await ff.browser.tabs.get(4)).active, true);
    assert.equal((await ff.browser.windows.getLastFocused()).id, 2);
    await ff.browser.tabs.remove(99);
  });
  assert.equal(await openTab(ff.browser, { id: 4 }, { id: 99, windowId: 1 }, { close: true }), true);
  await layouts(ff, "P1 | 2", "P3 | 4");
  const activation = ff.calls.findIndex(call => call.api === "tabs.update");
  const focus = ff.calls.findIndex(call => call.api === "windows.update");
  const close = ff.calls.findIndex(call => call.api === "runtime.sendMessage");
  assert.ok(activation < focus && focus < close);
});

test("review critical 1: failed foreign focus warns and leaves the page open", async t => {
  const ff = openFixture(), warn = t.mock.method(console, "warn", () => {});
  t.mock.method(ff.browser.windows, "update", async () => { throw new Error("Window closed"); });
  assert.equal(await openTab(ff.browser, { id: 4 }, { id: 99, windowId: 1 }, { close: true }), false);
  await layouts(ff, "P1 | 2 99", "P3 | 4");
  assert.equal((await ff.browser.tabs.get(4)).active, true);
  assert.equal(ff.calls.some(call => call.api === "runtime.sendMessage" || call.api === "tabs.remove"), false);
  assert.match(warn.mock.calls[0].arguments[0], /^Foxy:/);
});

test("close tabs removes precisely the selected tabs", async () => {
  const ff = fixture();
  assert.equal(await closeTabs(ff.browser, [1, 4, 19]), true);
  await layouts(ff, "P2 | 3 [101: 5] 6 [102: 7 8] 9", "P11 P12 | 13 [201: 14 15] 16 [202: 17 18]");
});
test("close group removes all of its members without closing unrelated tabs", async () => {
  const ff = fixture();
  assert.equal(await closeGroup(ff.browser, 201), true);
  await layouts(ff, W1, "P11 P12 | 13 16 [202: 17 18] 19");
  assert.equal((await ff.browser.tabGroups.query({})).some(group => group.id === 201), false);
});
for (const explicit of [true, false]) {
  test(`review important 1: closeTabs preserves the page (${explicit ? "explicit self ID" : "legacy call"})`, async () => {
    const ff = fixture(4);
    assert.equal(await closeTabs(ff.browser, [1, 4, 19], ...(explicit ? [4] : [])), true);
    await layouts(ff, "P2 | 3 [101: 4 5] 6 [102: 7 8] 9", "P11 P12 | 13 [201: 14 15] 16 [202: 17 18]");
    assert.equal(ff.calls.some(call => call.api === "runtime.sendMessage"), false);
  });
  test(`review important 1: closeGroup ungroups the page before removing other members (${explicit ? "explicit self ID" : "legacy call"})`, async () => {
    const ff = fixture(4);
    assert.equal(await closeGroup(ff.browser, 101, ...(explicit ? [4] : [])), true);
    await layouts(ff, "P1 P2 | 3 4 6 [102: 7 8] 9");
    assert.equal((await ff.browser.tabs.get(4)).groupId, -1);
    assert.equal((await ff.browser.tabGroups.query({})).some(group => group.id === 101), false);
    const ungroup = ff.calls.findIndex(call => call.api === "tabs.ungroup");
    const remove = ff.calls.findIndex(call => call.api === "tabs.remove");
    assert.ok(ungroup >= 0 && ungroup < remove);
    assert.equal(ff.calls.some(call => call.api === "runtime.sendMessage"), false);
  });
}

test("review important 1: closeTabs selecting only the page is a safe no-op", async () => {
  const ff = fixture();
  assert.equal(await closeTabs(ff.browser, [4], 4), true);
  await layouts(ff);
  assert.equal(ff.calls.some(call => call.api === "tabs.remove"), false);
});

test("review important 1: closing a page-only group leaves the page loose", async () => {
  const ff = createFirefox({ windows: [{ id: 1 }, { id: 2 }], selfTabId: 99,
    groups: [{ id: 101, windowId: 1 }],
    tabs: [{ id: 99, windowId: 1, groupId: 101 }, { id: 1, windowId: 1 }, { id: 2, windowId: 2 }] });
  assert.equal(await closeGroup(ff.browser, 101, 99), true);
  await layouts(ff, "| 99 1", "| 2");
  assert.equal((await ff.browser.tabs.get(99)).groupId, -1);
  assert.deepEqual(await ff.browser.tabGroups.query({}), []);
  assert.equal(ff.calls.some(call => call.api === "tabs.remove"), false);
});

test("review important 1: failed page ungroup aborts the whole-group close", async t => {
  const ff = fixture(4), warn = t.mock.method(console, "warn", () => {});
  t.mock.method(ff.browser.tabs, "ungroup", async () => { throw new Error("Cannot ungroup page"); });
  assert.equal(await closeGroup(ff.browser, 101, 4), false);
  await layouts(ff);
  assert.equal(ff.calls.some(call => call.api === "tabs.remove"), false);
  assert.match(warn.mock.calls[0].arguments[0], /^Foxy:/);
});

test("rename permits an empty title and recolor passes Firefox's grey color name", async () => {
  const ff = fixture();
  assert.equal(await renameGroup(ff.browser, 101, "Work"), true);
  assert.equal((await ff.browser.tabGroups.get(101)).title, "Work");
  assert.equal(await renameGroup(ff.browser, 101, ""), true);
  assert.equal(await recolorGroup(ff.browser, 101, "grey"), true);
  assert.deepEqual(await ff.browser.tabGroups.get(101), { id: 101, windowId: 1, title: "", color: "grey", collapsed: false });
  await layouts(ff);
  assert.equal(ff.calls.some(call => call.api === "runtime.sendMessage" || call.api === "tabs.remove"), false);
});

for (const kind of ["group", "tabs", "pinned", "new-group"]) {
  test(`closed tab ${kind} drop resolves false and warns instead of throwing`, async t => {
    const ff = fixture(), warn = t.mock.method(console, "warn", () => {});
    assert.deepEqual(await dropTab(ff.browser, 999, { kind, windowId: 1, groupId: 101, beforeTabId: null }), { ok: false });
    assert.ok(warn.mock.callCount() > 0);
    assert.match(warn.mock.calls[0].arguments[0], /^Foxy:/);
    await layouts(ff);
  });
}
for (const [name, run] of [
  ["dropGroup", api => dropGroup(api, 999, { windowId: 1, beforeGroupId: null })],
  ["bringGroupHere", api => bringGroupHere(api, 999, 1)],
  ["openTab", api => openTab(api, { id: 999, windowId: 2, pinned: false }, { id: 9, windowId: 1 }, { close: true })],
  ["closeTabs", api => closeTabs(api, [999])], ["closeGroup", api => closeGroup(api, 999)],
  ["renameGroup", api => renameGroup(api, 999, "Title")], ["recolorGroup", api => recolorGroup(api, 999, "red")],
]) {
  test(`${name} stale IDs resolve false and warn instead of throwing`, async t => {
    const ff = fixture(), warn = t.mock.method(console, "warn", () => {});
    assert.equal(await run(ff.browser), false);
    assert.ok(warn.mock.callCount() > 0);
    assert.match(warn.mock.calls[0].arguments[0], /^Foxy:/);
    assert.equal(ff.calls.some(call => call.api === "runtime.sendMessage" || call.api === "windows.update"), false);
    await layouts(ff);
  });
}

test("a failed second step leaves a valid partial move and reports failure for a controller re-read", async t => {
  const ff = fixture(), warn = t.mock.method(console, "warn", () => {});
  t.mock.method(ff.browser.tabs, "group", async () => { throw new Error("Group disappeared"); });
  assert.deepEqual(await dropTab(ff.browser, 1, { kind: "group", groupId: 201, windowId: 2, beforeTabId: null }), { ok: false });
  await layouts(ff, "P2 | 3 [101: 4 5] 6 [102: 7 8] 9", "P11 P12 | 13 [201: 14 15] 16 [202: 17 18] 19 1");
  assert.match(warn.mock.calls[0].arguments[0], /^Foxy:/);
});

for (const [tabId, beforeTabId] of [[12, 1], [13, null]]) {
  test(`review minor 1: ignored adoption stops before pinning or reordering foreign tab ${tabId}`, async t => {
    const ff = fixture(), warn = t.mock.method(console, "warn", () => {});
    const move = ff.browser.tabs.move;
    const moves = t.mock.method(ff.browser.tabs, "move", async (...args) => {
      if (args[1].windowId != null) return [];
      return move(...args);
    });
    assert.deepEqual(await dropTab(ff.browser, tabId, { kind: "pinned", windowId: 1, beforeTabId }), { ok: false });
    await layouts(ff);
    assert.equal(moves.mock.callCount(), 1);
    assert.equal(ff.calls.some(call => call.api === "tabs.update"), false);
    assert.match(warn.mock.calls[0].arguments[0], /^Foxy:/);
  });
}

test("PINNED warns and reports false if Firefox silently ignores adoption", async t => {
  const ff = fixture(), warn = t.mock.method(console, "warn", () => {});
  t.mock.method(ff.browser.tabs, "move", async () => []);
  assert.deepEqual(await dropTab(ff.browser, 11, { kind: "pinned", windowId: 1, beforeTabId: null }), { ok: false });
  await layouts(ff);
  assert.match(warn.mock.calls[0].arguments[0], /^Foxy:/);
});
