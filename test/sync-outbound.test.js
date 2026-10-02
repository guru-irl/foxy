import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { emptyState, saveState, loadState } from "../extension/src/sync/state.js";
import { createOutbound } from "../extension/src/sync/outbound.js";

const url = name => `https://example.com/${name}`;
const writes = ff => ff.calls.filter(call => /^bookmarks\.(create|move|update|remove|removeTree)$/.test(call.api));
const group = { id: 7, windowId: 1, title: "  Work  ", color: "red" };
const tabs = [
  { id: 30, windowId: 1, groupId: 7, url: url("a"), title: "A" },
  { id: 10, windowId: 1, groupId: 7, url: url("b"), title: "B" },
  { id: 20, windowId: 1, groupId: 7, url: url("c"), title: "C" },
  { id: 99, windowId: 1, url: url("loose"), title: "Loose" },
];

async function fixture(setup = {}, options = {}) {
  const ff = createFirefox({ groups: [group], tabs, ...setup, bookmarks: [{ title: "Foxy", children: [
    { title: "📌 Pinned" },
    { title: "🩶 Saved", children: [{ title: "Saved", url: url("saved") }] },
  ] }] });
  const api = ff.browser, state = emptyState();
  [state.rootId] = (await api.bookmarks.getChildren("unfiled_____")).map(node => node.id);
  [state.pinnedId] = (await api.bookmarks.getChildren(state.rootId)).map(node => node.id);
  let clock = 100;
  const outbound = createOutbound({ api, getState: () => state, save: () => saveState(api, state),
    now: () => clock, removeDelayMs: 0, quietMs: 10, extensionBaseUrl: api.runtime.getURL(""), ...options });
  const folder = () => {
    assert.ok(state.groups[7], "syncGroup must map its bookmark folder");
    return state.groups[7].folderId;
  };
  async function children(id = folder()) {
    await ff.settle();
    assert.deepEqual(ff.errors, []);
    return api.bookmarks.getChildren(id);
  }
  async function pages(id) { return (await children(id)).map(({ title, url }) => ({ title, url })); }
  return { ff, api, state, outbound, folder, children, pages, tick: ms => { clock += ms; } };
}
const abc = [{ title: "A", url: url("a") }, { title: "B", url: url("b") }, { title: "C", url: url("c") }];
async function synced(options) {
  const f = await fixture({}, options);
  await f.outbound.syncGroup(7);
  assert.ok(f.state.groups[7], "syncGroup must map its bookmark folder");
  assert.equal(Object.keys(f.state.tabs).length, 3, "syncGroup must map its members");
  await f.ff.settle();
  f.ff.calls.length = 0;
  return f;
}

// Wrong branches, whole-folder rewrites and missing lastSynced updates must
// change these literal tree, identity and single-delta assertions.
test("new group appends one folder and maps members in tab position, not tab-id order", async () => {
  const { ff, api, state, outbound, folder, children, pages } = await fixture();
  await outbound.syncGroup(7);
  assert.deepEqual(await pages(), abc);
  const folders = await children(state.rootId);
  assert.deepEqual(folders.map(node => node.title), ["📌 Pinned", "🩶 Saved", "🔴 Work"]);
  assert.deepEqual(state.groups[7], { folderId: folder(), title: "🔴 Work" });
  assert.deepEqual(state.openFolders, [folder()]);
  const nodes = await children();
  for (const [i, id] of [30, 10, 20].entries()) {
    assert.deepEqual(state.tabs[id], { bookmarkId: nodes[i].id, folderId: folder(), ...abc[i] });
  }
  assert.deepEqual(await loadState(api), state);
  assert.equal(writes(ff).length, 4);
});

test("tab joining a mapped group creates just its bookmark after the nearest mapped earlier tab", async () => {
  const f = await synced();
  const tab = await f.api.tabs.create({ url: url("d"), active: false });
  await f.api.tabs.group({ groupId: 7, tabIds: [tab.id] });
  await f.outbound.syncTab(tab.id);
  await f.outbound.syncTab(tab.id);
  assert.deepEqual(await f.pages(), [...abc, { title: url("d"), url: url("d") }]);
  assert.deepEqual(writes(f.ff).map(call => call.api), ["bookmarks.create"]);
});

test("syncTab lazily maps an unknown group without creating duplicate bookmarks", async () => {
  const f = await fixture();
  await f.outbound.syncTab(10);
  assert.deepEqual(await f.pages(), abc);
  assert.equal(writes(f.ff).length, 4);
});

for (const [name, id, index, order] of [
  ["forward", 30, 2, [abc[1], abc[2], abc[0]]],
  ["backward", 20, 0, [abc[2], abc[0], abc[1]]],
]) test(`moving a tab ${name} uses the bookmark's final index and writes once`, async () => {
  const f = await synced(), before = structuredClone(f.state.tabs[id]);
  await f.api.tabs.move(id, { index });
  await f.outbound.syncTab(id);
  await f.outbound.syncTab(id);
  assert.deepEqual(await f.pages(), order);
  assert.deepEqual(f.state.tabs[id], before);
  assert.deepEqual(writes(f.ff).map(call => call.api), ["bookmarks.move"]);
});

test("outbound records each move before writing and preserves it through loadState", async (t) => {
  const f = await synced(), bid = f.state.tabs[20].bookmarkId, move = f.api.bookmarks.move;
  assert.equal(f.state.expectedMoves, undefined, "legacy state starts without expectedMoves");
  t.mock.method(f.api.bookmarks, "move", async (id, info) => {
    assert.equal(id, bid);
    assert.deepEqual(f.state.expectedMoves?.[id], [{ parentId: f.folder(), index: 0, at: 100 }]);
    assert.deepEqual((await loadState(f.api)).expectedMoves, f.state.expectedMoves);
    return move(id, info);
  });
  const warn = t.mock.method(console, "warn", () => {});
  await f.api.tabs.move(20, { index: 0 });
  await f.outbound.syncTab(20);
  assert.equal(warn.mock.callCount(), 0);
  assert.deepEqual(await f.pages(), [abc[2], abc[0], abc[1]]);
  assert.deepEqual(f.state.expectedMoves, { [bid]: [{ parentId: f.folder(), index: 0, at: 100 }] });
  assert.deepEqual(await loadState(f.api), f.state);
});

test("adding an expected move prunes records older than 60 seconds only", async () => {
  const f = await synced(), bid = f.state.tabs[20].bookmarkId;
  f.state.expectedMoves = {
    expired: [{ parentId: f.folder(), index: 0, at: 99 }],
    boundary: [{ parentId: f.folder(), index: 1, at: 100 }],
    recent: [{ parentId: f.folder(), index: 2, at: 99 }, { parentId: f.folder(), index: 2, at: 101 }],
  };
  f.tick(60000);
  await f.api.tabs.move(20, { index: 0 });
  await f.outbound.syncTab(20);
  assert.deepEqual(f.state.expectedMoves, {
    boundary: [{ parentId: f.folder(), index: 1, at: 100 }],
    recent: [{ parentId: f.folder(), index: 2, at: 101 }],
    [bid]: [{ parentId: f.folder(), index: 0, at: 60100 }],
  });
  assert.deepEqual(await loadState(f.api), f.state);
});

for (const pending of [false, true]) test(`rejected bookmark move deletes only its added echo record (prior echo=${pending}) and a later retry succeeds`, async (t) => {
  const f = await synced(), bid = f.state.tabs[20].bookmarkId, move = f.api.bookmarks.move;
  const before = structuredClone(f.state.tabs[20]);
  const previous = [{ parentId: f.folder(), index: 2, at: 99 }];
  f.state.expectedMoves = { ...(pending ? { [bid]: previous } : {}), other: [{ parentId: f.folder(), index: 1, at: 100 }] };
  t.mock.method(f.api.bookmarks, "move", async () => { throw new Error("move denied"); });
  const warn = t.mock.method(console, "warn", () => {});
  await f.api.tabs.move(20, { index: 0 });
  await f.outbound.syncTab(20);
  assert.deepEqual(f.state.expectedMoves[bid], pending ? previous : undefined, "only the failed write's echo must be removed");
  assert.deepEqual(f.state.expectedMoves.other, [{ parentId: f.folder(), index: 1, at: 100 }]);
  assert.deepEqual(await loadState(f.api), f.state);
  assert.deepEqual(f.state.tabs[20], before);
  assert.deepEqual(await f.pages(), abc);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /^Foxy:/);
  f.api.bookmarks.move = move;
  await f.outbound.syncTab(20);
  assert.deepEqual(await f.pages(), [abc[2], abc[0], abc[1]]);
});

test("expected move history keeps only the latest eight writes per bookmark", async () => {
  const f = await synced(), bid = f.state.tabs[20].bookmarkId;
  for (let i = 0; i < 10; i++) {
    f.tick(1);
    await f.api.tabs.move(20, { index: i % 2 === 0 ? 0 : 2 });
    await f.outbound.syncTab(20);
  }
  assert.equal(writes(f.ff).length, 10);
  assert.deepEqual(f.state.expectedMoves[bid].map(({ index, at }) => [index, at]),
    [[0, 103], [2, 104], [0, 105], [2, 106], [0, 107], [2, 108], [0, 109], [2, 110]]);
  assert.deepEqual(await loadState(f.api), f.state);
});

for (const shape of ["null map", "number map", "string map", "array map", "object entry", "string entry"]) {
  test(`malformed expectedMoves ${shape} does not prevent recording a new outbound move`, async (t) => {
    const f = await synced(), bid = f.state.tabs[20].bookmarkId;
    if (shape === "null map") f.state.expectedMoves = null;
    if (shape === "number map") f.state.expectedMoves = 7;
    if (shape === "string map") f.state.expectedMoves = "bad";
    if (shape === "array map") f.state.expectedMoves = [];
    if (shape === "object entry") f.state.expectedMoves = { [bid]: { parentId: f.folder(), index: 2, at: 99 }, bad: 7 };
    if (shape === "string entry") f.state.expectedMoves = { [bid]: "bad", bad: null };
    const warn = t.mock.method(console, "warn", () => {});
    await f.api.tabs.move(20, { index: 0 });
    await f.outbound.syncTab(20);
    assert.equal(warn.mock.callCount(), 0);
    assert.deepEqual(await f.pages(), [abc[2], abc[0], abc[1]]);
    assert.deepEqual(f.state.expectedMoves, { [bid]: [{ parentId: f.folder(), index: 0, at: 100 }] });
    assert.deepEqual(await loadState(f.api), f.state);
  });
}

test("tab leaving for another group moves the same bookmark without rewriting either folder", async () => {
  const f = await synced(), bookmarkId = f.state.tabs[10].bookmarkId;
  const newGroup = await f.api.tabs.group({ tabIds: [99] });
  await f.api.tabGroups.update(newGroup, { title: "Play", color: "blue" });
  await f.outbound.syncGroup(newGroup);
  f.ff.calls.length = 0;
  await f.api.tabs.group({ groupId: newGroup, tabIds: [10] });
  await f.outbound.syncTab(10);
  assert.deepEqual(await f.pages(), [abc[0], abc[2]]);
  assert.deepEqual(await f.pages(f.state.groups[newGroup].folderId), [abc[1], { title: "Loose", url: url("loose") }]);
  assert.equal(f.state.tabs[10].bookmarkId, bookmarkId);
  assert.equal(f.state.tabs[10].folderId, f.state.groups[newGroup].folderId);
  assert.deepEqual(writes(f.ff).map(call => call.api), ["bookmarks.move"]);
});

for (const reason of ["ungrouped", "closed"]) test(`${reason} tab removes one bookmark only after its delay while the group stays live`, async () => {
  const f = await synced({ removeDelayMs: 5 }), bookmarkId = f.state.tabs[10].bookmarkId;
  if (reason === "ungrouped") {
    await f.api.tabs.ungroup(10);
    await f.outbound.syncTab(10);
  } else {
    await f.api.tabs.remove(10);
    f.outbound.tabRemoved(10, { windowId: 1, isWindowClosing: false });
  }
  await f.outbound.flush();
  assert.deepEqual(await f.pages(), abc);
  assert.ok(f.state.tabs[10]);
  f.tick(5);
  await f.outbound.flush();
  await f.outbound.flush();
  assert.deepEqual(await f.pages(), [abc[0], abc[2]]);
  assert.equal(f.state.tabs[10], undefined);
  assert.deepEqual(writes(f.ff), [{ api: "bookmarks.remove", args: [bookmarkId] }]);
  assert.deepEqual(await loadState(f.api), f.state);
});

for (const reason of ["ungrouped", "closed", "unsyncable-left-folder"]) test(`${reason} removal asks the controller to schedule a queue-owned flush with removeDelayMs`, async () => {
  const scheduled = [];
  const f = await synced({ removeDelayMs: 5, schedule: ms => scheduled.push(ms) });
  if (reason === "closed") {
    await f.api.tabs.remove(10);
    f.outbound.tabRemoved(10, { isWindowClosing: false });
  } else {
    if (reason === "ungrouped") await f.api.tabs.ungroup(10);
    else {
      await f.api.tabs.update(10, { url: "about:blank" });
      await f.api.tabs.ungroup(10);
    }
    await f.outbound.syncTab(10);
  }
  assert.deepEqual(scheduled, [5]);
  assert.deepEqual(await f.pages(), abc);
  assert.deepEqual(writes(f.ff), []);
  f.tick(5);
  await f.outbound.flush();
  assert.deepEqual(await f.pages(), [abc[0], abc[2]]);
});

test("completed navigation updates URL and title in one delta and records lastSynced", async () => {
  const f = await synced(), bookmarkId = f.state.tabs[10].bookmarkId;
  await f.api.tabs.update(10, { url: url("new") });
  await f.outbound.syncTab(10);
  await f.outbound.syncTab(10);
  assert.deepEqual(await f.pages(), [abc[0], { title: url("new"), url: url("new") }, abc[2]]);
  assert.deepEqual(f.state.tabs[10], { bookmarkId, folderId: f.folder(), url: url("new"), title: url("new") });
  assert.deepEqual(writes(f.ff), [{ api: "bookmarks.update", args: [bookmarkId, { url: url("new"), title: url("new") }] }]);
});

test("completed title-only change updates no URL and records lastSynced", async (t) => {
  const f = await synced(), get = f.api.tabs.get;
  // Firefox's fake update has no title setter. Override only read snapshots.
  t.mock.method(f.api.tabs, "get", async id => ({ ...await get(id), ...(id === 10 ? { title: "New title" } : {}) }));
  await f.outbound.syncTab(10);
  await f.outbound.syncTab(10);
  assert.deepEqual(await f.pages(), [abc[0], { title: "New title", url: url("b") }, abc[2]]);
  assert.equal(f.state.tabs[10].title, "New title");
  assert.deepEqual(writes(f.ff), [{ api: "bookmarks.update", args: [f.state.tabs[10].bookmarkId, { title: "New title" }] }]);
});

test("group rename or recolour updates only its folder and trims the stored title", async () => {
  const f = await synced();
  await f.api.tabGroups.update(7, { title: "  Projects  ", color: "cyan" });
  await f.outbound.syncGroup(7);
  await f.outbound.syncGroup(7);
  assert.equal((await f.api.bookmarks.get(f.folder()))[0].title, "🩵 Projects");
  assert.deepEqual(await f.pages(), abc);
  assert.equal(f.state.groups[7].title, "🩵 Projects");
  assert.deepEqual(writes(f.ff), [{ api: "bookmarks.update", args: [f.folder(), { title: "🩵 Projects" }] }]);
});

test("group title already matching the local change advances lastSynced without an echo write", async () => {
  const f = await synced();
  await f.api.tabGroups.update(7, { title: "Projects", color: "cyan" });
  await f.api.bookmarks.update(f.folder(), { title: "🩵 Projects" });
  f.ff.calls.length = 0;
  await f.outbound.syncGroup(7);
  assert.equal((await f.api.bookmarks.get(f.folder()))[0].title, "🩵 Projects");
  assert.equal(f.state.groups[7].title, "🩵 Projects");
  assert.deepEqual(await f.pages(), abc);
  assert.deepEqual(writes(f.ff), []);
  assert.deepEqual(await loadState(f.api), f.state);
});

test("whole-group close removes mappings and open status but keeps every bookmark", async () => {
  const f = await synced(), folderId = f.folder(), before = await f.api.bookmarks.getTree();
  f.api.tabs.onRemoved.addListener((id, info) => f.outbound.tabRemoved(id, info));
  f.api.tabGroups.onRemoved.addListener((g, info) => f.outbound.groupRemoved(g, info));
  await f.api.tabs.remove(30);
  await f.ff.settle();
  await f.api.tabs.remove(10);
  await f.ff.settle();
  await f.api.tabs.remove(20);
  await f.ff.settle();
  await f.outbound.flush();
  assert.deepEqual(await f.api.bookmarks.getTree(), before);
  assert.equal(f.state.groups[7], undefined);
  assert.deepEqual(f.state.tabs, {});
  assert.equal(f.state.openFolders.includes(folderId), false);
  assert.deepEqual(writes(f.ff), []);
});

test("closing a group never touches bookmarks even if removeInfo is omitted", async () => {
  const f = await synced(), g = await f.api.tabGroups.get(7), folderId = f.folder();
  await f.outbound.groupRemoved(g);
  assert.deepEqual(await f.pages(folderId), abc);
  assert.deepEqual(f.state.groups, {});
  assert.deepEqual(f.state.openFolders, []);
  assert.deepEqual(writes(f.ff), []);
});

test("pinning moves a mapped bookmark into Pinned; unpinning removes only that bookmark", async () => {
  const f = await synced(), bookmarkId = f.state.tabs[10].bookmarkId;
  await f.api.tabs.update(10, { pinned: true });
  await f.outbound.syncTab(10);
  assert.deepEqual(await f.pages(f.state.pinnedId), [abc[1]]);
  assert.deepEqual(await f.pages(), [abc[0], abc[2]]);
  assert.equal(f.state.tabs[10].bookmarkId, bookmarkId);
  assert.equal(f.state.tabs[10].folderId, f.state.pinnedId);
  await f.api.tabs.update(10, { pinned: false });
  await f.outbound.syncTab(10);
  await f.outbound.flush();
  assert.deepEqual(await f.pages(f.state.pinnedId), []);
  assert.equal(f.state.tabs[10], undefined);
  assert.deepEqual(writes(f.ff).map(call => call.api), ["bookmarks.move", "bookmarks.remove"]);
});

test("new pinned tabs in two windows share one Pinned folder with window-local predecessors", async () => {
  const f = await fixture({ windows: [{ id: 1, focused: true }, { id: 2 }], groups: [], tabs: [
    { id: 8, windowId: 1, pinned: true, url: url("p1"), title: "P1" },
    { id: 3, windowId: 1, pinned: true, url: url("p2"), title: "P2" },
    { id: 6, windowId: 2, pinned: true, url: url("p3"), title: "P3" },
    { id: 2, windowId: 2, pinned: true, url: url("p4"), title: "P4" },
  ] });
  for (const id of [8, 3, 6, 2]) await f.outbound.syncTab(id);
  assert.deepEqual(await f.pages(f.state.pinnedId), [
    { title: "P1", url: url("p1") }, { title: "P2", url: url("p2") },
    { title: "P3", url: url("p3") }, { title: "P4", url: url("p4") },
  ]);
  assert.equal(Object.keys(f.state.tabs).length, 4);
  assert.ok(Object.values(f.state.tabs).every(entry => entry.folderId === f.state.pinnedId));
  assert.equal(writes(f.ff).length, 4);
});

async function interleavedPins() {
  const f = await fixture({ windows: [{ id: 1, focused: true }, { id: 2 }], groups: [], tabs: [
    { id: 8, windowId: 1, pinned: true, url: url("p1"), title: "P1" },
    { id: 3, windowId: 1, pinned: true, url: url("p2"), title: "P2" },
    { id: 6, windowId: 2, pinned: true, url: url("p3"), title: "P3" },
    { id: 2, windowId: 2, pinned: true, url: url("p4"), title: "P4" },
  ] });
  // Simulate a shared tree with bookmarks interleaved by window, as inbound
  // matching can supply. Window 1 is P1, P2; window 2 is P3, P4.
  for (const id of [8, 6, 3, 2]) {
    const tab = await f.api.tabs.get(id);
    const bookmark = await f.api.bookmarks.create({ parentId: f.state.pinnedId, url: tab.url, title: tab.title });
    f.state.tabs[id] = { bookmarkId: bookmark.id, folderId: f.state.pinnedId, url: tab.url, title: tab.title };
  }
  await saveState(f.api, f.state);
  f.ff.calls.length = 0;
  return f;
}

test("interleaved pins keep per-window relative order and a second full pass makes no bookmark calls", async () => {
  const f = await interleavedPins();
  const expected = [
    { title: "P1", url: url("p1") }, { title: "P3", url: url("p3") },
    { title: "P2", url: url("p2") }, { title: "P4", url: url("p4") },
  ];
  for (const id of [8, 3, 6, 2]) await f.outbound.syncTab(id);
  assert.deepEqual(await f.pages(f.state.pinnedId), expected);
  assert.deepEqual(writes(f.ff), []);
  f.ff.calls.length = 0;
  for (const id of [8, 3, 6, 2]) await f.outbound.syncTab(id);
  assert.deepEqual(await f.pages(f.state.pinnedId), expected);
  assert.deepEqual(writes(f.ff), []);
});

test("two-sided insertion: a new first pin goes before its later same-window neighbour without an echo", async () => {
  const f = await interleavedPins();
  const pin = await f.api.tabs.create({ windowId: 2, index: 0, pinned: true, active: false, url: url("new-pin") });
  await f.outbound.syncTab(pin.id);
  const expected = [
    { title: "P1", url: url("p1") }, { title: url("new-pin"), url: url("new-pin") },
    { title: "P3", url: url("p3") }, { title: "P2", url: url("p2") }, { title: "P4", url: url("p4") },
  ];
  assert.deepEqual(await f.pages(f.state.pinnedId), expected);
  assert.deepEqual(writes(f.ff).map(call => call.api), ["bookmarks.create"]);
  f.ff.calls.length = 0;
  await f.outbound.syncTab(pin.id);
  assert.deepEqual(await f.pages(f.state.pinnedId), expected);
  assert.deepEqual(writes(f.ff), []);
  f.ff.calls.length = 0;
  for (const id of [8, 3, pin.id, 6, 2]) await f.outbound.syncTab(id);
  assert.deepEqual(writes(f.ff), []);
});

for (const entering of [false, true]) for (const pinned of [false, true]) {
  test(`two-sided insertion: ${entering ? "entering" : "new"} ${pinned ? "pin" : "group bookmark"} goes after an unmapped front bookmark and before its later neighbour`, async () => {
    const f = await synced(), originalId = f.state.tabs[30].bookmarkId;
    let folderId = f.folder();
    if (pinned) {
      for (const id of [10, 20]) {
        await f.api.tabs.update(id, { pinned: true });
        await f.outbound.syncTab(id);
      }
      folderId = f.state.pinnedId;
    } else if (entering) {
      await f.api.bookmarks.move(originalId, { parentId: f.state.pinnedId });
      f.state.tabs[30].folderId = f.state.pinnedId;
    }
    if (!entering) {
      await f.api.bookmarks.remove(originalId);
      delete f.state.tabs[30];
    }
    if (pinned) {
      await f.api.tabs.update(30, { pinned: true });
      await f.api.tabs.move(30, { index: 0 });
    }
    await f.api.bookmarks.create({ parentId: folderId, index: 0, title: "X", url: "about:config" });
    await saveState(f.api, f.state);
    f.ff.calls.length = 0;
    await f.outbound.syncTab(30);
    const expected = [{ title: "X", url: "about:config" }, ...abc];
    assert.deepEqual(await f.pages(folderId), expected);
    assert.deepEqual(writes(f.ff).map(call => call.api), [entering ? "bookmarks.move" : "bookmarks.create"]);
    if (entering) assert.equal(f.state.tabs[30].bookmarkId, originalId);
    assert.equal(f.state.tabs[30].folderId, folderId);
    f.ff.calls.length = 0;
    for (const id of [30, 10, 20]) await f.outbound.syncTab(id);
    assert.deepEqual(await f.pages(folderId), expected);
    assert.deepEqual(writes(f.ff), []);
  });
}

test("an existing out-of-order pin moves right after its same-window predecessor using the final index", async () => {
  const f = await interleavedPins();
  await f.api.bookmarks.move(f.state.tabs[3].bookmarkId, { index: 0 });
  f.ff.calls.length = 0;
  await f.outbound.syncTab(3);
  assert.deepEqual(await f.pages(f.state.pinnedId), [
    { title: "P1", url: url("p1") }, { title: "P2", url: url("p2") },
    { title: "P3", url: url("p3") }, { title: "P4", url: url("p4") },
  ]);
  assert.deepEqual(writes(f.ff), [{ api: "bookmarks.move", args: [f.state.tabs[3].bookmarkId,
    { parentId: f.state.pinnedId, index: 1 }] }]);
  f.ff.calls.length = 0;
  for (const id of [8, 3, 6, 2]) await f.outbound.syncTab(id);
  assert.deepEqual(writes(f.ff), []);
});

test("window close keeps pins, group bookmarks and tab entries, cancelling already pending removals", async () => {
  const f = await synced(), originalTabs = structuredClone(f.state.tabs), folderId = f.folder();
  const pin = await f.api.tabs.create({ pinned: true, active: false, url: url("pin") });
  await f.outbound.syncTab(pin.id);
  const before = await f.api.bookmarks.getTree(), pinEntry = structuredClone(f.state.tabs[pin.id]);
  f.outbound.tabRemoved(10, { windowId: 1, isWindowClosing: false });
  f.api.tabs.onRemoved.addListener((id, info) => f.outbound.tabRemoved(id, info));
  f.api.tabGroups.onRemoved.addListener((g, info) => f.outbound.groupRemoved(g, info));
  f.ff.calls.length = 0;
  await f.ff.closeWindow(1);
  await f.ff.settle();
  await f.outbound.flush();
  assert.deepEqual(await f.api.bookmarks.getTree(), before);
  assert.deepEqual(f.state.tabs, { ...originalTabs, [pin.id]: pinEntry });
  assert.deepEqual(f.state.groups, {});
  assert.deepEqual(f.state.openFolders, [folderId]);
  assert.deepEqual(writes(f.ff), []);
});

test("isWindowClosing tab removal alone changes no state and writes nothing", async () => {
  const f = await synced(), before = structuredClone(f.state);
  f.outbound.tabRemoved(10, { windowId: 1, isWindowClosing: true });
  await f.outbound.flush();
  assert.deepEqual(f.state, before);
  assert.equal(f.ff.calls.some(call => call.api === "storage.local.set"), false);
  assert.deepEqual(writes(f.ff), []);
});

test("quiet tab preserves lastSynced URL until quietUntil expires", async () => {
  const f = await synced();
  f.state.quietUntil[10] = 110;
  await f.api.tabs.update(10, { url: url("quiet") });
  await f.outbound.syncTab(10);
  assert.deepEqual(await f.pages(), abc);
  assert.equal(f.state.tabs[10].url, url("b"));
  assert.deepEqual(writes(f.ff), []);
  f.tick(10);
  await f.outbound.syncTab(10);
  assert.equal((await f.children())[1].url, url("quiet"));
  assert.equal(f.state.tabs[10].url, url("quiet"));
});

test("navigation and title changes write only when the tab is complete", async (t) => {
  const f = await synced(), get = f.api.tabs.get;
  let status = "loading";
  t.mock.method(f.api.tabs, "get", async id => ({ ...await get(id), status }));
  await f.api.tabs.update(10, { url: url("loading") });
  await f.outbound.syncTab(10);
  assert.deepEqual(await f.pages(), abc);
  assert.deepEqual(writes(f.ff), []);
  status = "complete";
  await f.outbound.syncTab(10);
  assert.equal((await f.children())[1].url, url("loading"));
  assert.equal(writes(f.ff).length, 1);
});

test("title-only loading changes wait for completion even after the URL has already synced", async (t) => {
  const f = await synced(), get = f.api.tabs.get;
  let status = "loading";
  t.mock.method(f.api.tabs, "get", async id => ({ ...await get(id), status, ...(id === 10 ? { title: "Loaded title" } : {}) }));
  await f.outbound.syncTab(10);
  assert.deepEqual(await f.pages(), abc);
  assert.deepEqual(writes(f.ff), []);
  status = "complete";
  await f.outbound.syncTab(10);
  assert.deepEqual(await f.pages(), [abc[0], { title: "Loaded title", url: url("b") }, abc[2]]);
  assert.deepEqual(writes(f.ff), [{ api: "bookmarks.update", args: [f.state.tabs[10].bookmarkId, { title: "Loaded title" }] }]);
});

test("a tab already matching its live bookmark advances lastSynced without an echo update", async () => {
  const f = await synced();
  await f.api.tabs.update(10, { url: url("same") });
  await f.api.bookmarks.update(f.state.tabs[10].bookmarkId, { url: url("same"), title: url("same") });
  f.ff.calls.length = 0;
  await f.outbound.syncTab(10);
  assert.deepEqual(await f.pages(), [abc[0], { title: url("same"), url: url("same") }, abc[2]]);
  assert.equal(f.state.tabs[10].url, url("same"));
  assert.equal(f.state.tabs[10].title, url("same"));
  assert.deepEqual(writes(f.ff), []);
  assert.deepEqual(await loadState(f.api), f.state);
});

test("newtab, home, blank and every extension page are skipped without bookmarks", async () => {
  const f = await fixture({ tabs: [
    ...["about:newtab", "about:home", "about:blank", "moz-extension://foxy-test/nested/page.html?x=1"].map((url, i) =>
      ({ id: i + 1, windowId: 1, groupId: 7, url })),
    { id: 9, windowId: 1, groupId: 7, url: url("kept"), title: "Kept" },
    { id: 99, windowId: 1, url: url("loose") },
  ] });
  await f.outbound.syncGroup(7);
  assert.deepEqual(await f.pages(), [{ title: "Kept", url: url("kept") }]);
  assert.deepEqual(Object.keys(f.state.tabs), ["9"]);
  assert.equal(writes(f.ff).length, 2);
});

function* permutations(items) {
  if (!items.length) { yield []; return; }
  for (const [index, item] of items.entries()) {
    for (const rest of permutations(items.filter((_, i) => i !== index))) yield [item, ...rest];
  }
}

for (const pinned of [false, true]) test(`bookmark permutations: ${pinned ? "pins" : "group tabs"} converge and isolated middle sync writes at most once`, async (t) => {
  for (const size of [3, 4, 5]) {
    const labels = ["A", "B", "C", "D", "E"].slice(0, size);
    for (const order of permutations(labels)) await t.test(order.join(""), async () => {
      const members = labels.map((title, index) => ({ id: index + 1, windowId: 1,
        ...(pinned ? { pinned: true } : { groupId: 7 }), title, url: url(title.toLowerCase()) }));
      const f = await fixture({ groups: pinned ? [] : [group], tabs: members });
      if (pinned) for (const tab of members) await f.outbound.syncTab(tab.id);
      else await f.outbound.syncGroup(7);
      const folderId = pinned ? f.state.pinnedId : f.folder();
      const before = structuredClone(f.state.tabs);
      async function resetOrder() {
        for (const [index, label] of order.entries()) {
          await f.api.bookmarks.move(f.state.tabs[labels.indexOf(label) + 1].bookmarkId, { index });
        }
        await f.ff.settle();
        f.ff.calls.length = 0;
      }
      await resetOrder();
      const middleId = members[Math.floor(size / 2)].id;
      for (let repeat = 0; repeat < 5; repeat++) await f.outbound.syncTab(middleId);
      assert.ok(writes(f.ff).length <= 1, `isolated middle sync wrote ${writes(f.ff).length} times`);
      await resetOrder();
      let stable = false;
      for (let pass = 0; pass < 5; pass++) {
        f.ff.calls.length = 0;
        for (const tab of members) await f.outbound.syncTab(tab.id);
        if (!writes(f.ff).length) { stable = true; break; }
      }
      assert.ok(stable, "must reach a no-write pass within five passes");
      assert.deepEqual((await f.children(folderId)).map(node => node.title), labels,
        `starting order ${order.join("")} got stuck`);
      assert.deepEqual(f.state.tabs, before);
    });
  }
});

for (const pinned of [false, true]) for (const unsyncable of ["about:blank", "about:newtab", "about:home", "moz-extension://foxy-test/newtab.html"]) {
  test(`unsyncable URL: ${unsyncable} in the same ${pinned ? "pinned" : "group"} folder keeps its entry and bookmark`, async (t) => {
    const f = await synced();
    if (pinned) {
      await f.api.tabs.update(10, { pinned: true });
      await f.outbound.syncTab(10);
    }
    const entry = structuredClone(f.state.tabs[10]), before = await f.api.bookmarks.getTree();
    f.ff.calls.length = 0;
    const get = f.api.tabs.get;
    t.mock.method(f.api.tabs, "get", async id => ({ ...await get(id), ...(id === 10 ? { url: unsyncable, title: "Unsyncable" } : {}) }));
    await f.outbound.syncTab(10);
    await f.outbound.flush();
    assert.deepEqual(await f.api.bookmarks.getTree(), before);
    assert.deepEqual(f.state.tabs[10], entry);
    assert.deepEqual(f.state.pendingRemovals, {});
    assert.deepEqual(writes(f.ff), []);
    assert.equal(f.ff.calls.some(call => call.api === "storage.local.set"), false);
  });
}

for (const reason of ["other group", "unpinned", "closed"]) test(`unsyncable URL: ${reason} still schedules guarded removal`, async () => {
  const f = await synced({ removeDelayMs: 5 });
  if (reason === "unpinned") {
    await f.api.tabs.update(10, { pinned: true });
    await f.outbound.syncTab(10);
  }
  const bookmarkId = f.state.tabs[10].bookmarkId;
  await f.api.tabs.update(10, { url: "about:blank" });
  f.ff.calls.length = 0;
  if (reason === "closed") {
    await f.api.tabs.remove(10);
    f.outbound.tabRemoved(10);
  } else {
    if (reason === "unpinned") await f.api.tabs.update(10, { pinned: false });
    else {
      const other = await f.api.tabs.group({ tabIds: [99] });
      await f.outbound.syncGroup(other);
      f.ff.calls.length = 0;
      await f.api.tabs.group({ groupId: other, tabIds: [10] });
    }
    await f.outbound.syncTab(10);
  }
  await f.outbound.flush();
  assert.ok(f.state.tabs[10]);
  f.tick(5);
  await f.outbound.flush();
  assert.equal(f.state.tabs[10], undefined);
  assert.deepEqual(writes(f.ff), [{ api: "bookmarks.remove", args: [bookmarkId] }]);
});

test("unsyncable URL: rejoining the original folder cancels an already scheduled removal", async () => {
  const f = await synced({ removeDelayMs: 5 });
  await f.api.tabs.ungroup(10);
  await f.outbound.syncTab(10);
  await f.api.tabs.update(10, { url: "about:blank" });
  await f.api.tabs.group({ groupId: 7, tabIds: [10] });
  f.ff.calls.length = 0;
  await f.outbound.syncTab(10);
  f.tick(5);
  await f.outbound.flush();
  assert.deepEqual(await f.pages(), abc);
  assert.ok(f.state.tabs[10]);
  assert.deepEqual((await loadState(f.api)).pendingRemovals, {});
  assert.deepEqual(writes(f.ff), []);
});

test("syncTab twice and a repeated full group pass produce no echo writes or storage changes", async () => {
  const f = await synced();
  for (const id of [30, 10, 20, 99]) {
    await f.outbound.syncTab(id);
    await f.outbound.syncTab(id);
  }
  await f.outbound.syncGroup(7);
  assert.deepEqual(await f.pages(), abc);
  assert.deepEqual(writes(f.ff), []);
  assert.equal(f.ff.calls.some(call => call.api === "storage.local.set"), false);
});

test("mapped bookmark deleted remotely is left to inbound, not recreated", async (t) => {
  t.mock.method(console, "warn", () => {});
  const f = await synced(), before = structuredClone(f.state.tabs[10]);
  await f.api.bookmarks.remove(before.bookmarkId);
  f.ff.calls.length = 0;
  await f.outbound.syncTab(10);
  assert.deepEqual(await f.pages(), [abc[0], abc[2]]);
  assert.deepEqual(f.state.tabs[10], before);
  assert.deepEqual(writes(f.ff), []);
});

test("remote URL or title edit is not overwritten if the local tab still equals lastSynced", async () => {
  const f = await synced();
  await f.api.bookmarks.update(f.state.tabs[10].bookmarkId, { url: url("remote"), title: "Remote" });
  f.ff.calls.length = 0;
  await f.outbound.syncTab(10);
  assert.deepEqual(await f.pages(), [abc[0], { url: url("remote"), title: "Remote" }, abc[2]]);
  assert.equal(f.state.tabs[10].url, url("b"));
  assert.deepEqual(writes(f.ff), []);
});

test("rejoining a group cancels delayed ungroup removal", async () => {
  const f = await synced({ removeDelayMs: 5 });
  await f.api.tabs.ungroup(10);
  await f.outbound.syncTab(10);
  await f.api.tabs.group({ groupId: 7, tabIds: [10] });
  await f.outbound.syncTab(10);
  f.tick(5);
  await f.outbound.flush();
  assert.deepEqual(await f.pages(), [abc[0], abc[2], abc[1]]);
  assert.ok(f.state.tabs[10]);
  assert.deepEqual(writes(f.ff).map(call => call.api), ["bookmarks.move"]);
});

test("a delayed removal does not delete an entry rebound by inbound to another folder", async () => {
  const f = await synced(), entry = f.state.tabs[10];
  f.outbound.tabRemoved(10, { isWindowClosing: false });
  // An inbound pass moved this mapped bookmark and updated its lastSynced folder.
  await f.api.bookmarks.move(entry.bookmarkId, { parentId: f.state.pinnedId });
  entry.folderId = f.state.pinnedId;
  f.ff.calls.length = 0;
  await f.outbound.flush();
  assert.deepEqual(await f.pages(f.state.pinnedId), [abc[1]]);
  assert.equal(f.state.tabs[10], entry);
  assert.deepEqual(writes(f.ff), []);
});

test("a missing tab or group is a harmless no-op", async (t) => {
  t.mock.method(console, "warn", () => {});
  const f = await synced(), before = structuredClone(f.state);
  await f.outbound.syncTab(12345);
  await f.outbound.syncGroup(12345);
  await f.outbound.groupRemoved({ id: 12345 }, { isWindowClosing: false });
  assert.deepEqual(f.state, before);
  assert.deepEqual(await f.pages(), abc);
  assert.deepEqual(writes(f.ff), []);
});

test("missing bookmarks during removal still clear entries and do not break later removals", async (t) => {
  t.mock.method(console, "warn", () => {});
  const f = await synced();
  await f.api.bookmarks.remove(f.state.tabs[10].bookmarkId);
  f.state.removedIds[f.state.tabs[10].bookmarkId] = 100; // Explicit onRemoved evidence.
  await f.ff.settle();
  await f.api.tabs.remove([10, 20]);
  f.outbound.tabRemoved(10, { isWindowClosing: false });
  f.outbound.tabRemoved(20, { isWindowClosing: false });
  await f.outbound.flush();
  assert.deepEqual(await f.pages(), [abc[0]]);
  assert.equal(f.state.tabs[10], undefined);
  assert.equal(f.state.tabs[20], undefined);
});

test("bookmark creation rejection is logged and does not abort the group's other members", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const f = await fixture({ tabs: [
    { id: 1, windowId: 1, groupId: 7, url: "data:text/plain,no" },
    { id: 2, windowId: 1, groupId: 7, url: url("valid"), title: "Valid" },
  ] });
  await f.outbound.syncGroup(7);
  assert.deepEqual(await f.pages(), [{ title: "Valid", url: url("valid") }]);
  assert.equal(f.state.tabs[1], undefined);
  assert.ok(warn.mock.calls.some(call => /^Foxy:/.test(call.arguments[0])));
});

for (const pinned of [false, true]) test(`inverted neighbours: repeated middle ${pinned ? "pin" : "group tab"} sync does not oscillate and a full pass converges`, async () => {
  const f = await synced();
  if (pinned) {
    for (const id of [30, 10, 20]) {
      await f.api.tabs.update(id, { pinned: true });
      await f.outbound.syncTab(id);
    }
  }
  const folderId = pinned ? f.state.pinnedId : f.folder(), before = structuredClone(f.state.tabs);
  await f.api.bookmarks.move(f.state.tabs[20].bookmarkId, { index: 0 });
  await f.api.bookmarks.move(f.state.tabs[10].bookmarkId, { index: 1 });
  assert.deepEqual(await f.pages(folderId), [abc[2], abc[1], abc[0]]);
  f.ff.calls.length = 0;
  for (let repeat = 0; repeat < 3; repeat++) {
    await f.outbound.syncTab(10);
    assert.deepEqual(await f.pages(folderId), [abc[2], abc[0], abc[1]]);
    assert.deepEqual(writes(f.ff).map(call => call.api), ["bookmarks.move"]);
  }
  for (const id of [30, 10, 20]) await f.outbound.syncTab(id);
  assert.deepEqual(await f.pages(folderId), abc);
  assert.deepEqual(f.state.tabs, before);
  assert.deepEqual(writes(f.ff).map(call => call.api), ["bookmarks.move", "bookmarks.move"]);
  f.ff.calls.length = 0;
  for (const id of [30, 10, 20]) await f.outbound.syncTab(id);
  assert.deepEqual(await f.pages(folderId), abc);
  assert.deepEqual(writes(f.ff), []);
});

for (const pinned of [true, false]) for (const index of [1, 0]) {
  test(`relative order: ${pinned ? "pin" : "group tab"} moved backward to ${index} writes once then stabilizes`, async () => {
    const f = pinned ? await fixture({ groups: [], tabs: [
      { id: 30, windowId: 1, pinned: true, url: url("a"), title: "A" },
      { id: 10, windowId: 1, pinned: true, url: url("b"), title: "B" },
      { id: 20, windowId: 1, pinned: true, url: url("c"), title: "C" },
    ] }) : await synced();
    if (pinned) for (const id of [30, 10, 20]) await f.outbound.syncTab(id);
    const folderId = pinned ? f.state.pinnedId : f.folder();
    f.ff.calls.length = 0;
    await f.api.tabs.move(20, { index });
    await f.outbound.syncTab(20);
    assert.deepEqual(await f.pages(folderId), index === 1 ? [abc[0], abc[2], abc[1]] : [abc[2], abc[0], abc[1]]);
    assert.deepEqual(writes(f.ff).map(call => call.api), ["bookmarks.move"]);
    f.ff.calls.length = 0;
    for (const tab of await f.api.tabs.query({ windowId: 1 })) await f.outbound.syncTab(tab.id);
    assert.deepEqual(writes(f.ff), []);
  });
}

for (const pinned of [true, false]) test(`relative order: ${pinned ? "pins" : "group tabs"} preserve unmapped bookmarks between mapped neighbours`, async () => {
  const f = await synced();
  if (pinned) {
    for (const id of [30, 10, 20]) {
      await f.api.tabs.update(id, { pinned: true });
      await f.outbound.syncTab(id);
    }
  }
  const folderId = pinned ? f.state.pinnedId : f.folder();
  await f.api.bookmarks.create({ parentId: folderId, index: 1, title: "X", url: "about:config" });
  const expected = [abc[0], { title: "X", url: "about:config" }, abc[1], abc[2]];
  f.ff.calls.length = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (const id of [30, 10, 20]) await f.outbound.syncTab(id);
    assert.deepEqual(await f.pages(folderId), expected);
    assert.deepEqual(writes(f.ff), []);
  }
});

for (const reason of ["closed", "ungrouped"]) test(`persisted removal: ${reason} tab is removed by a fresh outbound after wake`, async () => {
  const f = await synced({ removeDelayMs: 5 }), entry = structuredClone(f.state.tabs[10]);
  if (reason === "closed") {
    await f.api.tabs.remove(10);
    f.outbound.tabRemoved(10);
  } else {
    await f.api.tabs.ungroup(10);
    await f.outbound.syncTab(10);
  }
  const restored = await loadState(f.api);
  assert.deepEqual(restored.pendingRemovals, { 10: { bookmarkId: entry.bookmarkId, folderId: entry.folderId, due: 105 } });
  let clock = 104;
  const fresh = createOutbound({ api: f.api, getState: () => restored, save: () => saveState(f.api, restored), now: () => clock });
  await fresh.flush();
  assert.deepEqual(await f.pages(), abc);
  clock = 105;
  await fresh.flush();
  assert.deepEqual(await f.pages(), [abc[0], abc[2]]);
  assert.equal(restored.tabs[10], undefined);
  assert.deepEqual(restored.pendingRemovals, {});
  assert.deepEqual(await loadState(f.api), restored);
});

for (const reason of ["rejoined", "window closing"]) test(`persisted removal: ${reason} cancellation survives wake`, async () => {
  const f = await synced({ removeDelayMs: 5 });
  await f.api.tabs.ungroup(10);
  await f.outbound.syncTab(10);
  assert.ok((await loadState(f.api)).pendingRemovals?.[10], "scheduled removal must be saved");
  if (reason === "rejoined") {
    await f.api.tabs.group({ groupId: 7, tabIds: [10] });
    await f.outbound.syncTab(10);
  } else f.outbound.tabRemoved(10, { isWindowClosing: true });
  const restored = await loadState(f.api);
  assert.deepEqual(restored.pendingRemovals, {});
  f.ff.calls.length = 0;
  await createOutbound({ api: f.api, getState: () => restored, save: () => saveState(f.api, restored), now: () => 105 }).flush();
  assert.ok(restored.tabs[10]);
  assert.deepEqual(writes(f.ff), []);
});

for (const missing of ["tab", "bookmark", "group during flush"]) test(`expected missing object: ${missing} does not log outbound sync failed`, async (t) => {
  const f = await synced(), warn = t.mock.method(console, "warn", () => {});
  if (missing === "tab") {
    await f.api.tabs.remove(10);
    await f.outbound.syncTab(10);
    assert.ok(f.state.tabs[10]);
  } else if (missing === "bookmark") {
    await f.api.bookmarks.remove(f.state.tabs[10].bookmarkId);
    await f.outbound.syncTab(10);
    assert.ok(f.state.tabs[10]);
  } else {
    const before = await f.api.bookmarks.getTree();
    await f.api.tabs.remove([30, 10, 20]);
    for (const id of [30, 10, 20]) f.outbound.tabRemoved(id);
    await f.outbound.flush();
    assert.deepEqual(await f.api.bookmarks.getTree(), before);
    assert.deepEqual(f.state.tabs, {});
  }
  assert.equal(warn.mock.callCount(), 0);
});

for (const readApi of ["tabs", "bookmarks", "tabGroups"]) test(`outbound read diagnostic: unexpected ${readApi}.get failure logs debug, not warn, and does not escape`, async (t) => {
  const f = await synced(), before = structuredClone(f.state), tree = await f.api.bookmarks.getTree();
  const error = new Error("unexpected API failure"), debug = t.mock.method(console, "debug", () => {});
  const warn = t.mock.method(console, "warn", () => {});
  t.mock.method(f.api[readApi], "get", async () => { throw error; });
  await assert.doesNotReject(readApi === "tabGroups" ? f.outbound.syncGroup(7) : f.outbound.syncTab(10));
  assert.deepEqual(debug.mock.calls.map(call => call.arguments), [["Foxy: outbound read skipped", error]]);
  assert.equal(warn.mock.callCount(), 0);
  assert.deepEqual(f.state, before);
  assert.deepEqual(await f.api.bookmarks.getTree(), tree);
  assert.deepEqual(writes(f.ff), []);
});

for (const failure of ["getState", "schedule", "save", "save rejection"]) test(`guarded tabRemoved: ${failure} never escapes the listener and logs Foxy`, async (t) => {
  const f = await synced(), error = new Error(failure), warn = t.mock.method(console, "warn", () => {});
  const outbound = createOutbound({ api: f.api,
    getState: () => { if (failure === "getState") throw error; return f.state; },
    save: () => {
      if (failure === "save") throw error;
      if (failure === "save rejection") return Promise.reject(error);
      return saveState(f.api, f.state);
    },
    schedule: () => { if (failure === "schedule") throw error; },
  });
  assert.doesNotThrow(() => outbound.tabRemoved(10));
  await f.ff.settle();
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /^Foxy:/);
  assert.ok(warn.mock.calls[0].arguments.includes(error));
});

test("guarded tabRemoved: a throwing scheduling hook still persists its removal deadline", async (t) => {
  const f = await synced(), warn = t.mock.method(console, "warn", () => {});
  const outbound = createOutbound({ api: f.api, getState: () => f.state, save: () => saveState(f.api, f.state),
    now: () => 100, removeDelayMs: 5, schedule: () => { throw new Error("scheduler unavailable"); } });
  assert.doesNotThrow(() => outbound.tabRemoved(10));
  assert.deepEqual((await loadState(f.api)).pendingRemovals, { 10: {
    bookmarkId: f.state.tabs[10].bookmarkId, folderId: f.folder(), due: 105,
  } });
  assert.equal(warn.mock.callCount(), 1);
});

async function rejectedCreateFixture(t) {
  const warn = t.mock.method(console, "warn", () => {});
  const f = await fixture({ tabs: [
    { id: 1, windowId: 1, groupId: 7, url: "data:text/plain,no", title: "Rejected" },
    { id: 2, windowId: 1, groupId: 7, url: url("valid"), title: "Valid" },
  ] });
  await f.outbound.syncGroup(7);
  assert.deepEqual(await f.pages(), [{ title: "Valid", url: url("valid") }]);
  assert.equal(warn.mock.callCount(), 1);
  f.ff.calls.length = 0;
  return { ...f, warn };
}

for (const isWindowClosing of [false, true]) test(`failed create cleanup: ${isWindowClosing ? "window-closing" : "ordinary"} tab removal prunes and persists the rejected URL`, async (t) => {
  const f = await rejectedCreateFixture(t);
  f.state.failedCreates[123] = "data:text/plain,another";
  await saveState(f.api, f.state);
  const before = structuredClone(f.state), tree = await f.api.bookmarks.getTree();
  f.ff.calls.length = 0;
  await f.api.tabs.remove(1);
  assert.doesNotThrow(() => f.outbound.tabRemoved(1, { isWindowClosing }));
  await f.ff.settle();
  assert.deepEqual(f.state, { ...before, failedCreates: { 123: "data:text/plain,another" } });
  assert.deepEqual(await loadState(f.api), f.state);
  assert.deepEqual(await f.api.bookmarks.getTree(), tree);
  assert.deepEqual(writes(f.ff), []);
  assert.equal(f.warn.mock.callCount(), 1);
  f.ff.calls.length = 0;
  f.outbound.tabRemoved(1, { isWindowClosing });
  await f.ff.settle();
  assert.equal(f.ff.calls.some(call => call.api === "storage.local.set"), false);
});

test("failed create cleanup: rejected save is contained by the tabRemoved listener", async (t) => {
  const f = await rejectedCreateFixture(t), error = new Error("cleanup save failed");
  t.mock.method(f.api.storage.local, "set", async () => { throw error; });
  assert.doesNotThrow(() => f.outbound.tabRemoved(1));
  await f.ff.settle();
  assert.deepEqual(f.state.failedCreates, {});
  assert.equal(f.warn.mock.callCount(), 2);
  assert.deepEqual(f.warn.mock.calls[1].arguments, ["Foxy: outbound sync failed", error]);
});

test("failed create: identical URL is suppressed across wake and a changed URL can create", async (t) => {
  const f = await rejectedCreateFixture(t);
  await f.outbound.syncTab(1);
  await f.outbound.syncTab(1);
  assert.deepEqual(writes(f.ff), []);
  assert.equal(f.warn.mock.callCount(), 1);
  const restored = await loadState(f.api);
  assert.deepEqual(restored.failedCreates, { 1: "data:text/plain,no" });
  const fresh = createOutbound({ api: f.api, getState: () => restored, save: () => saveState(f.api, restored) });
  await fresh.syncTab(1);
  assert.deepEqual(writes(f.ff), []);
  assert.equal(f.warn.mock.callCount(), 1);
  await f.api.tabs.update(1, { url: url("accepted") });
  await fresh.syncTab(1);
  await fresh.syncTab(1);
  assert.deepEqual(await f.pages(), [{ title: url("accepted"), url: url("accepted") }, { title: "Valid", url: url("valid") }]);
  assert.equal(restored.tabs[1].url, url("accepted"));
  assert.deepEqual(restored.failedCreates, {});
  assert.deepEqual(writes(f.ff).map(call => call.api), ["bookmarks.create"]);
  assert.equal(f.warn.mock.callCount(), 1);
});

test("failed create: a different rejected URL is tried and logged only once", async (t) => {
  const f = await rejectedCreateFixture(t);
  const get = f.api.tabs.get;
  t.mock.method(f.api.tabs, "get", async id => ({ ...await get(id), ...(id === 1 ? { url: "data:text/plain,other" } : {}) }));
  await f.outbound.syncTab(1);
  await f.outbound.syncTab(1);
  assert.deepEqual(writes(f.ff).map(call => call.api), ["bookmarks.create"]);
  assert.equal(f.warn.mock.callCount(), 2);
  assert.deepEqual((await loadState(f.api)).failedCreates, { 1: "data:text/plain,other" });
});

test("failed create: changing through an unsyncable URL permits retry when the original URL returns", async (t) => {
  const f = await rejectedCreateFixture(t);
  await f.api.tabs.update(1, { url: "about:blank" });
  await f.outbound.syncTab(1);
  assert.deepEqual((await loadState(f.api)).failedCreates, {});
  const get = f.api.tabs.get;
  t.mock.method(f.api.tabs, "get", async id => ({ ...await get(id), ...(id === 1 ? { url: "data:text/plain,no" } : {}) }));
  await f.outbound.syncTab(1);
  await f.outbound.syncTab(1);
  assert.deepEqual(writes(f.ff).map(call => call.api), ["bookmarks.create"]);
  assert.equal(f.warn.mock.callCount(), 2);
});

test("failed bookmark update is logged without advancing lastSynced", async (t) => {
  const f = await synced(), before = structuredClone(f.state.tabs[10]);
  t.mock.method(f.api.bookmarks, "update", async () => { throw new Error("offline"); });
  const warn = t.mock.method(console, "warn", () => {});
  await f.api.tabs.update(10, { url: url("failed") });
  await f.outbound.syncTab(10);
  assert.deepEqual(await f.pages(), abc);
  assert.deepEqual(f.state.tabs[10], before);
  assert.match(warn.mock.calls[0].arguments[0], /^Foxy:/);
});

test("future-stamped expected moves are pruned outbound after clock rollback", async () => {
  const f = await synced(), bid = f.state.tabs[20].bookmarkId;
  f.state.expectedMoves = { future: [{ parentId: f.folder(), index: 0, at: 101 }],
    [bid]: [{ parentId: f.folder(), index: 2, at: 101 }] };
  await f.api.tabs.move(20, { index: 0 });
  await f.outbound.syncTab(20);
  assert.deepEqual(f.state.expectedMoves, { [bid]: [{ parentId: f.folder(), index: 0, at: 100 }] });
  assert.deepEqual(await f.pages(), [abc[2], abc[0], abc[1]]);
});

for (const pinned of [false, true]) {
  test(`outbound ${pinned ? "pins" : "groups"} escape marker-like page titles on create, title and URL deltas`, async () => {
    const ff = createFirefox({ groups: [{ id: 10, windowId: 1, title: "Group", color: "blue" }],
      tabs: [{ id: 2, windowId: 1, pinned, groupId: pinned ? -1 : 10,
        url: "https://example.com/a", title: "  ✏️ Drafts" }], bookmarks: [
        { id: "root", title: "Foxy", children: [{ id: "pins", title: "📌 Pinned" }, { id: "group", title: "🔵 Group" }] },
      ] });
    const state = emptyState();
    Object.assign(state, { rootId: "root", pinnedId: "pins", groups: { 10: { folderId: "group", title: "🔵 Group" } } });
    const outbound = createOutbound({ api: ff.browser, getState: () => state, save: async () => {} });
    await outbound.syncTab(2);
    const id = state.tabs[2].bookmarkId;
    assert.equal((await ff.browser.bookmarks.get(id))[0].title, "\u200B  ✏️ Drafts");
    const get = ff.browser.tabs.get;
    ff.browser.tabs.get = async id => ({ ...await get(id), title: "✏ Next" });
    await outbound.syncTab(2);
    assert.equal((await ff.browser.bookmarks.get(id))[0].title, "\u200B✏ Next");
    await ff.browser.tabs.update(2, { url: "https://example.com/b" });
    ff.browser.tabs.get = async id => ({ ...await get(id), title: "✏️ Navigation" });
    await outbound.syncTab(2);
    assert.equal((await ff.browser.bookmarks.get(id))[0].title, "\u200B✏️ Navigation");
    if (!pinned) {
      await ff.browser.tabs.update(2, { pinned: true });
      await outbound.syncTab(2);
      assert.equal((await ff.browser.bookmarks.get(id))[0].parentId, "pins");
      assert.equal((await ff.browser.bookmarks.get(id))[0].title, "\u200B✏️ Navigation");
    }
  });
}

test("a named pin moved outbound into Pinned preserves its existing marker despite a raw marker-like page title", async () => {
  const ff = createFirefox({ tabs: [{ id: 2, windowId: 1, pinned: true,
    url: "https://example.com/a", title: "✏️ Raw page" }], bookmarks: [
    { id: "root", title: "Foxy", children: [
      { id: "pins", title: "📌 Pinned" },
      { id: "group", title: "🔵 Group", children: [
        { id: "bookmark", url: "https://example.com/a", title: "✏️ Work" },
      ] },
    ] },
  ] });
  const state = emptyState();
  Object.assign(state, { rootId: "root", pinnedId: "pins", tabs: {
    2: { bookmarkId: "bookmark", folderId: "pins", url: "https://example.com/a", title: "Before" },
  } });
  const outbound = createOutbound({ api: ff.browser, getState: () => state, save: async () => {} });
  await outbound.syncTab(2);
  const [bookmark] = await ff.browser.bookmarks.get("bookmark");
  assert.equal(bookmark.parentId, "pins");
  assert.equal(bookmark.title, "✏️ Work");
  assert.equal(ff.calls.filter(c => c.api === "bookmarks.update").length, 0);
});
