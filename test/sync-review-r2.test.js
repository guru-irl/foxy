import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { createSyncServer } from "./fakes/sync-server.js";
import { wire, unwire, drain, mutations } from "./fakes/sync.js";
import { createOutbound } from "../extension/src/sync/outbound.js";
import { emptyState, loadState, saveState, pruneRemovedIds, wasRemoved, probeMissingBookmark } from "../extension/src/sync/state.js";

const home = { id: 1, windowId: 1, url: "about:home", active: true };
const setup = {
  groups: [{ id: 11, windowId: 1, title: "Dev", color: "red" }],
  tabs: [home, { id: 2, windowId: 1, pinned: true, url: "https://pin/" },
    { id: 3, windowId: 1, groupId: 11, url: "https://one/" },
    { id: 4, windowId: 1, groupId: 11, url: "https://two/" }],
};
const tabMutations = ff => mutations(ff).filter(call => /^(tabs|tabGroups)\./.test(call.api));

// Expiring evidence must not turn a safety-deferred real deletion into identity loss.
for (const wait of [1000, 600001]) {
  test(`shown bookmark deletion still closes after ${wait} ms safety deferral`, async () => {
    let clock = 1000;
    const ff = createFirefox({ ...setup, tabs: setup.tabs.map(tab => ({ ...tab, active: tab.id === 3 })) });
    ff.sync = wire(ff, { now: () => clock }); await drain(ff, ff.sync);
    const before = await loadState(ff.browser), id = before.tabs[3].bookmarkId;
    await ff.browser.bookmarks.remove(id); await drain(ff, ff.sync);
    assert.equal((await ff.browser.tabs.get(3)).active, true);
    assert.ok((await loadState(ff.browser)).deferred.includes(before.groups[11].folderId));
    clock += wait;
    ff.calls.length = 0;
    await ff.browser.tabs.update(1, { active: true }); await drain(ff, ff.sync);
    await assert.rejects(ff.browser.tabs.get(3), /Invalid tab ID/);
    const after = await loadState(ff.browser);
    assert.equal(after.tabs[3], undefined);
    assert.deepEqual(after.deferred, []);
    await ff.sync.handlers["tabs.onUpdated"](3); await drain(ff, ff.sync);
    assert.deepEqual((await ff.browser.bookmarks.getChildren(before.groups[11].folderId)).map(node => node.url), ["https://two/"]);
    assert.equal(ff.calls.some(call => call.api === "bookmarks.create"), false);
    assert.equal(ff.calls.filter(call => call.api === "tabs.remove").length, 1);
  });

  test(`shown group-folder deletion still ungroups after ${wait} ms safety deferral`, async () => {
    let clock = 1000;
    const ff = createFirefox({ ...setup, tabs: setup.tabs.map(tab => ({ ...tab, active: tab.id === 3 })) });
    ff.sync = wire(ff, { now: () => clock }); await drain(ff, ff.sync);
    const before = await loadState(ff.browser), folderId = before.groups[11].folderId;
    await ff.browser.bookmarks.removeTree(folderId); await drain(ff, ff.sync);
    assert.equal((await ff.browser.tabs.get(3)).groupId, 11);
    assert.equal((await ff.browser.tabs.get(4)).groupId, -1);
    clock += wait;
    ff.calls.length = 0;
    await ff.browser.tabs.update(1, { active: true }); await drain(ff, ff.sync);
    const after = await loadState(ff.browser);
    for (const id of [3, 4]) {
      assert.equal((await ff.browser.tabs.get(id)).groupId, -1);
      assert.equal(after.tabs[id], undefined);
    }
    assert.deepEqual(after.groups, {});
    assert.deepEqual(after.deferred, []);
    assert.deepEqual((await ff.browser.bookmarks.getChildren(after.rootId)).map(node => node.title), ["📌 Pinned"]);
    assert.equal(ff.calls.some(call => call.api === "bookmarks.create"), false);
    assert.equal(ff.calls.some(call => call.api === "tabs.create" || call.api === "tabs.remove"), false);
  });
}

for (const [name, reference] of [
  ["root", state => { state.rootId = "removed"; }],
  ["pinned", state => { state.pinnedId = "removed"; }],
  ["tab bookmark", state => { state.tabs[3] = { bookmarkId: "removed", folderId: "folder" }; }],
  ["tab folder", state => { state.tabs[3] = { bookmarkId: "bookmark", folderId: "removed" }; }],
  ["group", state => { state.groups[11] = { folderId: "removed", pendingOrder: true, rebindUntil: 900000 }; }],
  ...["openFolders", "missing", "deferred"].map(key => [key, state => { state[key] = ["removed"]; }]),
  ["pending removal bookmark", state => { state.pendingRemovals[3] = { bookmarkId: "removed", folderId: "folder" }; }],
  ["pending removal folder", state => { state.pendingRemovals[3] = { bookmarkId: "bookmark", folderId: "removed" }; }],
  ["move echo bookmark", state => { state.expectedMoves = { removed: [{ parentId: "folder" }] }; }],
  ["move echo parent", state => { state.expectedMoves = { bookmark: [{ parentId: "removed" }] }; }],
]) test(`removal evidence survives its TTL while referenced by ${name}`, () => {
  const state = emptyState(); state.removedIds.removed = 1000; reference(state);
  assert.equal(pruneRemovedIds(state, 601001), false);
  assert.equal(wasRemoved(state, "removed", 601001), true);
  const released = emptyState(); released.removedIds = { ...state.removedIds };
  assert.equal(pruneRemovedIds(released, 601001), true);
  assert.deepEqual(released.removedIds, {});
});

// Rekeying against live navigation would forget the original and open a duplicate.
for (const navigation of [{ url: "about:blank" }, { url: "https://loading/", status: "loading" }]) {
  test(`bookmark-only dedupe uses last-synced URL during ${navigation.url} navigation`, async t => {
    const a = createFirefox({ ...setup, bookmarkPrefix: "a" }), b = createFirefox({ tabs: [home], bookmarkPrefix: "z" });
    const server = createSyncServer();
    a.sync = wire(a); await drain(a, a.sync); server.attach(a); await server.syncDevice(a);
    b.sync = { idle: async () => {} }; server.attach(b); await server.syncDevice(b);
    b.sync = wire(b); await drain(b, b.sync);
    const folderId = (await loadState(a.browser)).groups[11].folderId;
    await b.sync.onMessage({ type: "foxy:open-saved", folderId, windowId: 1 }); await drain(b, b.sync);
    const groupB = (await b.browser.tabGroups.query({}))[0].id, added = [];
    for (const [ff, groupId] of [[a, 11], [b, groupB]]) {
      const tab = await ff.browser.tabs.create({ url: "https://same/", active: false });
      await ff.browser.tabs.group({ groupId, tabIds: [tab.id] }); await drain(ff, ff.sync); added.push(tab);
    }
    const expected = (await loadState(a.browser)).tabs[added[0].id].bookmarkId;
    if (navigation.status === "loading") {
      const get = b.browser.tabs.get;
      t.mock.method(b.browser.tabs, "get", async id => {
        const tab = await get(id);
        return id === added[1].id ? { ...tab, status: "loading" } : tab;
      });
    }
    await b.browser.tabs.update(added[1].id, { url: navigation.url }); await drain(b, b.sync);
    assert.equal((await loadState(b.browser)).tabs[added[1].id].url, "https://same/");
    await server.syncDevice(a); b.calls.length = 0;
    await server.syncDevice(b);
    await b.sync.onMessage({ type: "foxy:reconcile" }); await drain(b, b.sync);
    const state = await loadState(b.browser);
    assert.equal(state.tabs[added[1].id]?.bookmarkId, expected);
    assert.equal(state.tabs[added[1].id].url, "https://same/");
    assert.equal((await b.browser.tabs.get(added[1].id)).url, navigation.url);
    assert.equal((await b.browser.tabs.query({ groupId: groupB })).length, 3);
    assert.deepEqual(tabMutations(b), [], "no close, group, move, navigate or reopen");
  });
}

// Firefox exposes missing IDs differently per operation, not one generic error.
const missingMessages = {
  get: "Bookmark not found",
  getChildren: 'can\'t access property "children", root is null',
  getSubTree: 'can\'t access property "guid", node is null',
  update: "No bookmarks found for the provided GUID",
  move: "No bookmarks found for the provided GUID",
  remove: "No bookmarks found for the provided GUID.",
  removeTree: "No bookmarks found for the provided GUID.",
  create: "parentGuid must be valid",
};
for (const [method, message] of Object.entries(missingMessages)) test(`fake missing bookmark ${method} mirrors Firefox 157`, async () => {
  const b = createFirefox().browser.bookmarks;
  const args = method === "create" ? [{ parentId: "missing_____", title: "Page" }]
    : method === "move" ? ["missing_____", { parentId: "unfiled_____" }]
    : method === "update" ? ["missing_____", { title: "Page" }] : ["missing_____"];
  await assert.rejects(b[method](...args), { message });
});

test("first SAVED tree read recovers a silently deduped root with Firefox errors", async t => {
  const a = createFirefox({ ...setup, bookmarkPrefix: "a" }), b = createFirefox({ ...setup, bookmarkPrefix: "z" });
  const server = createSyncServer();
  for (const ff of [a, b]) { ff.sync = wire(ff); await drain(ff, ff.sync); server.attach(ff); }
  const expected = await loadState(a.browser), old = await loadState(b.browser);
  await server.syncDevice(a); await server.syncDevice(b);
  const errors = t.mock.method(console, "error", () => {});
  b.calls.length = 0;
  assert.deepEqual(await b.sync.onMessage({ type: "foxy:saved" }), {
    saved: [], missing: [], folders: { 11: expected.groups[11].folderId },
  });
  await drain(b, b.sync);
  assert.equal((await loadState(b.browser)).rootId, expected.rootId);
  assert.deepEqual(tabMutations(b), []);
  assert.equal(errors.mock.calls.length, 0, "recovery must not log sync task failed");
  assert.equal(b.calls.filter(call => call.api === "bookmarks.get" && call.args[0] === old.rootId).length, 3,
    "one tree-failure probe, then startup's root read and single probe");
});

for (const event of ["bookmarks.onCreated", "bookmarks.onChanged"]) test(`stale root in ${event} requests recovery without a queue error`, async t => {
  const a = createFirefox({ ...setup, bookmarkPrefix: "a" }), b = createFirefox({ ...setup, bookmarkPrefix: "z" });
  const server = createSyncServer();
  for (const ff of [a, b]) { ff.sync = wire(ff); await drain(ff, ff.sync); server.attach(ff); }
  const expected = await loadState(a.browser);
  await server.syncDevice(a); await server.syncDevice(b);
  const errors = t.mock.method(console, "error", () => {}); b.calls.length = 0;
  const node = (await b.browser.bookmarks.get(expected.tabs[3].bookmarkId))[0];
  await b.sync.handlers[event](node.id, node); await drain(b, b.sync);
  assert.equal((await loadState(b.browser)).rootId, expected.rootId);
  assert.deepEqual(tabMutations(b), []);
  assert.equal(errors.mock.calls.length, 0);
});

for (const probe of ["Firefox error", "opaque error", "empty result"]) {
for (const method of ["update", "move", "create", "remove"]) test(`outbound ${method} failure probes the silently deduped stored ID (${probe})`, async t => {
  const ff = createFirefox(setup); ff.sync = wire(ff); await drain(ff, ff.sync); unwire(ff);
  const state = await loadState(ff.browser), requests = [];
  const outbound = createOutbound({ api: ff.browser, getState: () => state, save: () => saveState(ff.browser, state),
    lostIdentity: id => requests.push(id), quietMs: 0 });
  const id = method === "create" ? state.groups[11].folderId : state.tabs[4].bookmarkId;
  const [node] = await ff.browser.bookmarks.get(id);
  if (method === "update") await ff.browser.tabs.update(4, { url: "https://local/" });
  if (method === "move") await ff.browser.tabs.move(4, { index: 2 });
  let tab;
  if (method === "create") {
    tab = await ff.browser.tabs.create({ url: "https://new/", active: false });
    await ff.browser.tabs.group({ groupId: 11, tabIds: [tab.id] });
  }
  if (method === "remove") state.pendingRemovals[4] = { bookmarkId: id, folderId: node.parentId, due: 0 };
  const original = ff.browser.bookmarks[method];
  if (probe === "empty result") {
    const get = ff.browser.bookmarks.get;
    t.mock.method(ff.browser.bookmarks, "get", async key => {
      try { return await get(key); }
      catch (error) { if (key === id && error.message === "Bookmark not found") return []; throw error; }
    });
  }
  t.mock.method(ff.browser.bookmarks, method, async (...args) => {
    await ff.applyRemoteBookmarks([{ ...node, id: "remote______" }]);
    try { return await original(...args); }
    catch (error) { if (probe === "opaque error") throw { message: "unclassified failure" }; throw error; }
  });
  ff.calls.length = 0;
  if (method === "remove") await outbound.flush();
  else await outbound.syncTab(tab?.id ?? 4);
  assert.deepEqual(requests, [id]);
  assert.equal(ff.calls.filter(call => call.api === "bookmarks.create").length, method === "create" ? 1 : 0,
    "no replacement create after a missing stored identity");
  assert.equal(state.failedCreates[tab?.id ?? 4], undefined, "identity loss is not a rejected URL");
  const calls = ff.calls.filter(call => call.api.startsWith("bookmarks."));
  assert.equal(calls.at(-1)?.api, "bookmarks.get", "failure confirmed by a read probe");
  assert.equal(calls.at(-1)?.args[0], id);
  const failure = calls.findLastIndex(call => call.api === `bookmarks.${method}`);
  assert.deepEqual(calls.slice(failure + 1), [{ api: "bookmarks.get", args: [id] }], "single confirming probe");
});
}

for (const result of ["present", "missing", "empty", "permission error", "generic invalid ID"]) {
  test(`missing-ID confirmation accepts only Firefox get absence (${result})`, async t => {
    const ff = createFirefox();
    const node = await ff.browser.bookmarks.create({ title: "Exists" });
    const get = ff.browser.bookmarks.get;
    let reads = 0;
    t.mock.method(ff.browser.bookmarks, "get", async id => {
      reads++;
      if (result === "empty") return [];
      if (result === "permission error") throw { message: "permission denied" };
      if (result === "generic invalid ID") throw { message: `Invalid bookmark ID: ${id}` };
      return get(id);
    });
    assert.equal(await probeMissingBookmark(ff.browser, result === "missing" ? "missing_____" : node.id),
      ["missing", "empty"].includes(result));
    assert.equal(reads, 1);
  });
}

test("outbound failure on a surviving identity does not rebuild or create a replacement", async t => {
  const ff = createFirefox(setup); ff.sync = wire(ff); await drain(ff, ff.sync); unwire(ff);
  const state = await loadState(ff.browser), requests = [];
  const outbound = createOutbound({ api: ff.browser, getState: () => state, save: () => saveState(ff.browser, state),
    lostIdentity: id => requests.push(id), quietMs: 0 });
  await ff.browser.tabs.update(4, { url: "https://local/" });
  t.mock.method(ff.browser.bookmarks, "update", async () => { throw { message: "No bookmarks found for the provided GUID" }; });
  const warnings = t.mock.method(console, "warn", () => {}); ff.calls.length = 0;
  await outbound.syncTab(4);
  assert.deepEqual(requests, []);
  assert.equal(state.tabs[4].url, "https://two/");
  assert.equal(ff.calls.some(call => call.api === "bookmarks.create"), false);
  assert.equal(warnings.mock.calls.length, 1, "real non-identity failures stay visible");
});

test("known bookmark deletion skips the failing departure read and warning", async t => {
  const ff = createFirefox(setup); ff.sync = wire(ff); await drain(ff, ff.sync);
  const state = await loadState(ff.browser), id = state.tabs[4].bookmarkId;
  const warnings = t.mock.method(console, "warn", () => {});
  ff.calls.length = 0;
  await ff.browser.bookmarks.remove(id); await drain(ff, ff.sync);
  await assert.rejects(ff.browser.tabs.get(4), /Invalid tab ID/);
  assert.equal(warnings.mock.calls.length, 0);
  assert.equal(ff.calls.some(call => call.api === "bookmarks.get" && call.args[0] === id), false);
});
