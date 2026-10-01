import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { createSyncServer } from "./fakes/sync-server.js";
import { wire, drain, mutations } from "./fakes/sync.js";
import { loadState, saveState } from "../extension/src/sync/state.js";
import { createOutbound } from "../extension/src/sync/outbound.js";

const home = { id: 1, windowId: 1, url: "about:home", active: true };
const setup = {
  groups: [{ id: 11, windowId: 1, title: "Dev", color: "red" }],
  tabs: [home, { id: 2, windowId: 1, pinned: true, url: "https://pin/" },
    { id: 3, windowId: 1, groupId: 11, url: "https://one/" },
    { id: 4, windowId: 1, groupId: 11, url: "https://two/" }],
};
const tabMutations = ff => mutations(ff).filter(call => /^(tabs|tabGroups)\./.test(call.api));
async function stable(server, a, b) {
  for (let round = 0; round < 5; round++) {
    await drain(a, a.sync); await drain(b, b.sync);
    if (!(await server.syncAll()).uploaded) break;
    if (round === 4) assert.fail("did not converge");
  }
  const counts = [a, b].map(ff => mutations(ff).length);
  assert.equal((await server.syncAll()).uploaded, 0);
  assert.deepEqual([a, b].map(ff => mutations(ff).length), counts);
  assert.deepEqual(await a.browser.bookmarks.getTree(), await b.browser.bookmarks.getTree());
}

for (const deliveryOrder of ["forward", "reverse", "shuffle"]) test(`silent dedupe first-run ${deliveryOrder}: B keeps every live tab and rebinds its whole tree`, async () => {
  const a = createFirefox({ ...setup, bookmarkPrefix: "a" });
  const b = createFirefox({ ...setup, bookmarkPrefix: "z" });
  const server = createSyncServer({ deliveryOrder });
  for (const ff of [a, b]) { ff.sync = wire(ff); await drain(ff, ff.sync); server.attach(ff); }
  const original = await loadState(b.browser), expected = await loadState(a.browser);
  let events = 0;
  for (const name of ["onCreated", "onRemoved", "onMoved", "onChanged"]) b.browser.bookmarks[name].addListener(() => events++);
  await server.syncDevice(a);
  b.calls.length = 0;
  await server.syncDevice(b);
  assert.equal(events, 0, "all equal-content GUID changes must be silent to the extension");
  await assert.rejects(b.browser.bookmarks.get(original.rootId), /Bookmark not found/);
  const burst = await Promise.all([b.sync.onMessage({ type: "foxy:reconcile" }),
    ...[2, 3, 4].map(id => b.sync.handlers["tabs.onUpdated"](id))]);
  assert.deepEqual(burst[0], { ok: true });
  for (const id of [2, 3, 4]) b.fire("tabs.onUpdated", id, { title: "wake" }, await b.browser.tabs.get(id));
  b.fire("tabs.onMoved", 3, { windowId: 1, fromIndex: 2, toIndex: 2 });
  await drain(b, b.sync);
  const after = await loadState(b.browser);
  assert.equal(after.rootId, expected.rootId);
  assert.equal(after.pinnedId, expected.pinnedId);
  assert.equal(after.groups[11].folderId, expected.groups[11].folderId);
  for (const id of [2, 3, 4]) assert.equal(after.tabs[id].bookmarkId, expected.tabs[id].bookmarkId);
  assert.deepEqual(tabMutations(b), [], "no close, ungroup, move, navigate, discard or reopen on identity loss");
  assert.deepEqual(await b.sync.onMessage({ type: "foxy:saved" }), { saved: [], missing: [] });
  assert.equal(b.calls.filter(call => call.api === "bookmarks.getSubTree" && call.args[0] === expected.rootId).length, 3,
    "one rebuild (two snapshots), then one SAVED snapshot");
  await stable(server, a, b);
});

test("silent dedupe running session: concurrent same URL and title additions keep B's original tab", async () => {
  const a = createFirefox({ ...setup, bookmarkPrefix: "a" }), b = createFirefox({ tabs: [home], bookmarkPrefix: "z" });
  const server = createSyncServer();
  a.sync = wire(a); await drain(a, a.sync); server.attach(a); await server.syncDevice(a);
  b.sync = { idle: async () => {} }; server.attach(b); await server.syncDevice(b);
  b.sync = wire(b); await drain(b, b.sync);
  const folderId = (await loadState(a.browser)).groups[11].folderId;
  await b.sync.onMessage({ type: "foxy:open-saved", folderId, windowId: 1 }); await drain(b, b.sync);
  const groupB = (await b.browser.tabGroups.query({}))[0].id;
  const added = [];
  for (const [ff, groupId] of [[a, 11], [b, groupB]]) {
    const tab = await ff.browser.tabs.create({ url: "https://same/", active: false });
    await ff.browser.tabs.group({ groupId, tabIds: [tab.id] }); await drain(ff, ff.sync); added.push(tab);
  }
  const expected = (await loadState(a.browser)).tabs[added[0].id].bookmarkId;
  await server.syncDevice(a); b.calls.length = 0;
  await server.syncDevice(b);
  await b.sync.onMessage({ type: "foxy:reconcile" }); await drain(b, b.sync);
  assert.equal((await loadState(b.browser)).tabs[added[1].id]?.bookmarkId, expected);
  assert.deepEqual(tabMutations(b), []);
  assert.equal((await b.browser.tabs.query({ groupId: groupB })).filter(tab => tab.url === "https://same/").length, 1);
  await stable(server, a, b);
});

async function local() {
  const ff = createFirefox(setup); ff.sync = wire(ff); await drain(ff, ff.sync);
  return { ff, state: await loadState(ff.browser) };
}

test("unexplained absent bookmark with no URL counterpart is forgotten, never closed", async t => {
  const { ff, state } = await local(), id = state.tabs[3].bookmarkId;
  const getChildren = ff.browser.bookmarks.getChildren;
  t.mock.method(ff.browser.bookmarks, "getChildren", async folder => (await getChildren(folder)).filter(node => node.id !== id));
  const debug = t.mock.method(console, "debug", () => {});
  ff.calls.length = 0;
  await ff.sync.onMessage({ type: "foxy:reconcile" });
  assert.equal((await loadState(ff.browser)).tabs[3], undefined);
  assert.equal((await ff.browser.tabs.get(3)).groupId, 11);
  assert.deepEqual(tabMutations(ff), []);
  assert.ok(debug.mock.calls.some(call => call.arguments[0].startsWith("Foxy:")));
});

for (const kind of ["root", "pinned", "group"]) test(`not-found ${kind} requests one rebuild without folder removal`, async t => {
  const { ff, state } = await local();
  const id = kind === "root" ? state.rootId : kind === "pinned" ? state.pinnedId : state.groups[11].folderId;
  const get = ff.browser.bookmarks.get;
  t.mock.method(ff.browser.bookmarks, "get", async key => {
    if (key === id) throw new Error("Bookmark not found");
    return get(key);
  });
  ff.calls.length = 0;
  await ff.sync.onMessage({ type: "foxy:reconcile" }); await drain(ff, ff.sync);
  assert.deepEqual(tabMutations(ff), []);
  assert.equal((await loadState(ff.browser)).groups[11].folderId, state.groups[11].folderId);
  assert.equal(ff.calls.filter(call => call.api === "bookmarks.getSubTree").length, 2);
});

for (const method of ["get", "update", "move"]) test(`outbound stored bookmark ${method} not-found schedules recovery without a replacement`, async t => {
  const { ff, state } = await local(), requests = [];
  const outbound = createOutbound({ api: ff.browser, getState: () => state, save: () => saveState(ff.browser, state),
    lostIdentity: id => requests.push(id) });
  const id = state.tabs[4].bookmarkId;
  const original = ff.browser.bookmarks[method];
  t.mock.method(ff.browser.bookmarks, method, async (...args) => {
    if (args[0] === id) { originalFailure = true; throw new Error(method === "get" ? "Bookmark not found" : "operation rejected"); }
    return original(...args);
  });
  if (method !== "get") {
    const get = ff.browser.bookmarks.get;
    t.mock.method(ff.browser.bookmarks, "get", async key => {
      if (key === id && originalFailure) throw new Error("Bookmark not found");
      return get(key);
    });
  }
  let originalFailure = false;
  if (method === "update") await ff.browser.tabs.update(4, { url: "https://local/" });
  if (method === "move") await ff.browser.tabs.move(4, { index: 2 });
  ff.calls.length = 0;
  await outbound.syncTab(4);
  assert.deepEqual(requests, [id]);
  assert.equal(ff.calls.some(call => call.api === "bookmarks.create"), false);
  assert.equal(state.tabs[4].bookmarkId, id);
});

test("onRemoved records descendants before reconciling, persists and prunes after ten minutes", async () => {
  let clock = 1000;
  const ff = createFirefox(setup); ff.sync = wire(ff, { now: () => clock }); await drain(ff, ff.sync);
  const before = await loadState(ff.browser);
  await ff.browser.bookmarks.removeTree(before.groups[11].folderId); await drain(ff, ff.sync);
  let after = await loadState(ff.browser);
  for (const id of [before.groups[11].folderId, before.tabs[3].bookmarkId, before.tabs[4].bookmarkId]) assert.equal(after.removedIds?.[id], 1000);
  assert.equal((await ff.browser.tabs.get(3)).groupId, -1, "real folder deletion still ungroups hidden tabs");
  clock += 600001;
  await ff.sync.onMessage({ type: "foxy:reconcile" });
  after = await loadState(ff.browser);
  assert.deepEqual(after.removedIds, {});
});

test("already uploaded local content is not silently deduped", async () => {
  const ff = createFirefox();
  const node = await ff.browser.bookmarks.create({ title: "Foxy" }); await ff.settle();
  ff.markUploaded(ff.bookmarkChanges().cursor);
  await ff.applyRemoteBookmarks([{ id: "remote", parentId: "unfiled_____", index: 1, title: "Foxy", type: "folder" }]);
  assert.equal((await ff.browser.bookmarks.get(node.id))[0].id, node.id);
  assert.equal((await ff.browser.bookmarks.getChildren("unfiled_____")).length, 2);
});

for (const scenario of ["closed pin", "missing group", "unpublished navigation", "move echo history", "malformed echo history", "failed create"]) test(`live rebuild retains ${scenario} semantics after silent dedupe`, async () => {
  let clock = 1000;
  const a = createFirefox({ ...setup, bookmarkPrefix: "a" }), b = createFirefox({ ...setup, bookmarkPrefix: "z",
    tabs: scenario === "failed create" ? [...setup.tabs, { id: 5, windowId: 1, groupId: 11, url: "data:text/plain,rejected" }] : setup.tabs });
  const server = createSyncServer();
  for (const ff of [a, b]) { ff.sync = wire(ff, { now: () => clock, removeDelayMs: 50 }); await drain(ff, ff.sync); server.attach(ff); }
  const expected = await loadState(a.browser), original = await loadState(b.browser);
  if (scenario === "closed pin") {
    await b.browser.tabs.remove(2); await drain(b, b.sync);
  } else if (scenario === "missing group") {
    await b.browser.tabs.remove([3, 4]); await drain(b, b.sync);
    const state = await loadState(b.browser); state.missing = [original.groups[11].folderId];
    await saveState(b.browser, state); b.sync = wire(b, { now: () => clock, removeDelayMs: 50 }); await drain(b, b.sync);
  } else if (scenario !== "failed create") {
    // Quiet suppresses a local navigation, not its old URL identity.
    const state = await loadState(b.browser); state.quietUntil[3] = 5000;
    if (scenario.includes("echo history")) state.expectedMoves = { [state.tabs[3].bookmarkId]:
      scenario === "move echo history" ? [{ parentId: state.groups[11].folderId, index: 1, at: 1000 }] : {} };
    await saveState(b.browser, state); b.sync = wire(b, { now: () => clock, removeDelayMs: 50 }); await drain(b, b.sync);
    await b.browser.tabs.update(3, { url: "https://unpublished/", active: true }); await drain(b, b.sync);
  }
  await server.syncDevice(a); b.calls.length = 0; await server.syncDevice(b);
  await b.sync.onMessage({ type: "foxy:reconcile" }); await drain(b, b.sync);
  const state = await loadState(b.browser);
  if (scenario === "closed pin") {
    assert.deepEqual(await b.browser.tabs.query({ pinned: true }), [], "a pending user close must not reopen its pin during recovery");
    assert.deepEqual(state.pendingRemovals[2], { bookmarkId: expected.tabs[2].bookmarkId, folderId: expected.pinnedId, due: 1050 });
    assert.equal(state.tabs[2].bookmarkId, expected.tabs[2].bookmarkId);
    clock = 1050;
    // A new lifetime drains the persisted deadline without waiting for a timer.
    b.sync = wire(b, { now: () => clock, removeDelayMs: 50 }); await drain(b, b.sync);
    assert.deepEqual(await b.browser.bookmarks.getChildren(expected.pinnedId), []);
  } else if (scenario === "missing group") {
    assert.deepEqual(state.missing, [expected.groups[11].folderId]);
    assert.equal((await b.sync.onMessage({ type: "foxy:saved" })).missing[0].folderId, expected.groups[11].folderId);
  } else if (scenario === "failed create") {
    assert.equal(state.failedCreates[5], "data:text/plain,rejected");
    assert.equal(b.calls.some(call => call.api === "bookmarks.create" && call.args[0].url === "data:text/plain,rejected"), false,
      "live recovery must retain already-rejected URLs rather than attempting them again");
    assert.deepEqual(tabMutations(b), []);
  } else {
    assert.equal(state.tabs[3].url, "https://one/");
    assert.equal(state.quietUntil[3], 5000);
    if (scenario === "move echo history") assert.deepEqual(state.expectedMoves[expected.tabs[3].bookmarkId],
      [{ parentId: expected.groups[11].folderId, index: 1, at: 1000 }]);
    if (scenario === "malformed echo history") assert.deepEqual(state.expectedMoves, {});
    assert.equal((await b.browser.tabs.get(3)).url, "https://unpublished/");
    assert.equal((await b.browser.bookmarks.get(expected.tabs[3].bookmarkId))[0].url, "https://one/");
    assert.deepEqual(tabMutations(b), []);
  }
});

test("bookmark-only dedupe rekeys a closed pin's pending removal without reopening it", async () => {
  let clock = 1000;
  const a = createFirefox({ ...setup, bookmarkPrefix: "a" }), b = createFirefox({ tabs: [home], bookmarkPrefix: "z" });
  const server = createSyncServer();
  a.sync = wire(a, { now: () => clock, removeDelayMs: 100 }); await drain(a, a.sync); server.attach(a); await server.syncDevice(a);
  b.sync = { idle: async () => {} }; server.attach(b); await server.syncDevice(b);
  b.sync = wire(b, { now: () => clock, removeDelayMs: 100 }); await drain(b, b.sync);
  const pins = [];
  for (const ff of [a, b]) {
    const pin = await ff.browser.tabs.create({ url: "https://new-pin/", pinned: true, active: false });
    await drain(ff, ff.sync); pins.push(pin);
  }
  const expected = (await loadState(a.browser)).tabs[pins[0].id].bookmarkId;
  await b.browser.tabs.remove(pins[1].id); await drain(b, b.sync);
  await server.syncDevice(a); b.calls.length = 0; await server.syncDevice(b);
  await b.sync.onMessage({ type: "foxy:reconcile" }); await drain(b, b.sync);
  const state = await loadState(b.browser);
  assert.deepEqual(tabMutations(b), [], "the closed pin must stay closed even when only its GUID changes");
  assert.equal(state.pendingRemovals[pins[1].id].bookmarkId, expected);
  assert.equal(state.pendingRemovals[pins[1].id].due, 1100);
});

test("not-found move of an explicitly removed bookmark does not request identity recovery", async t => {
  const { ff, state } = await local(), id = state.tabs[4].bookmarkId, requests = [];
  state.removedIds[id] = 1000;
  const outbound = createOutbound({ api: ff.browser, getState: () => state, save: () => saveState(ff.browser, state),
    now: () => 1000, lostIdentity: id => requests.push(id) });
  t.mock.method(ff.browser.bookmarks, "move", async () => { throw new Error("Bookmark not found"); });
  await ff.browser.tabs.move(4, { index: 2 });
  await outbound.syncTab(4);
  assert.deepEqual(requests, []);
});
