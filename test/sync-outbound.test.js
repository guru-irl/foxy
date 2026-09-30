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
    { title: "P3", url: url("p3") }, { title: "P4", url: url("p4") },
    { title: "P1", url: url("p1") }, { title: "P2", url: url("p2") },
  ]);
  assert.equal(Object.keys(f.state.tabs).length, 4);
  assert.ok(Object.values(f.state.tabs).every(entry => entry.folderId === f.state.pinnedId));
  assert.equal(writes(f.ff).length, 4);
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

test("mapped tab navigating to an unsyncable URL uses guarded delayed removal", async () => {
  const f = await synced();
  await f.api.tabs.update(10, { url: "about:blank" });
  await f.outbound.syncTab(10);
  assert.deepEqual(await f.pages(), abc);
  await f.outbound.flush();
  assert.deepEqual(await f.pages(), [abc[0], abc[2]]);
  assert.equal(f.state.tabs[10], undefined);
  assert.deepEqual(writes(f.ff).map(call => call.api), ["bookmarks.remove"]);
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
