import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { wire, drain, localSetup, sharedTree, mutations } from "./fakes/sync.js";
import { loadState, saveState } from "../extension/src/sync/state.js";
import { readTree } from "../extension/src/sync/tree.js";
import { settle } from "../extension/src/sync/startup.js";

async function snapshot(ff) {
  const state = await loadState(ff.browser);
  return { state, tree: await readTree(ff.browser, state.rootId) };
}

test("first run saves two groups and two pins; queued echoes and reconcile are no-ops", async () => {
  const ff = createFirefox(localSetup), sync = wire(ff);
  await drain(ff, sync);
  const { state, tree } = await snapshot(ff);
  assert.deepEqual(tree.folders.map(f => [f.title, f.bookmarks.map(b => b.url)]), [
    ["🔴 Work", ["https://work/"]], ["🔵 Read", ["https://read/"]],
  ]);
  assert.deepEqual(tree.pinned.bookmarks.map(b => b.url), ["https://pin-a/", "https://pin-b/"]);
  assert.equal(Object.keys(state.tabs).length, 4);
  assert.equal(state.openFolders.length, 2);
  const count = mutations(ff).length;
  await sync.onMessage({ type: "foxy:reconcile" });
  await drain(ff, sync);
  assert.equal(mutations(ff).length, count);
});

test("restore restart rebinds changed ids without new bookmarks, folders or tabs", async () => {
  const ff = createFirefox(localSetup);
  let sync = wire(ff);
  await drain(ff, sync);
  const before = await snapshot(ff);
  // Poison all id-keyed transient state: none may survive a browser session.
  before.state.pendingRemovals[2] = { bookmarkId: before.tree.pinned.bookmarks[0].id,
    folderId: before.tree.pinned.id, due: 0 };
  before.state.failedCreates[99] = "https://stale/";
  before.state.quietUntil[99] = 999999;
  before.state.expectedMoves = { stale: { parentId: before.tree.pinned.id, index: 0, at: 0 } };
  await saveState(ff.browser, before.state);
  await ff.settle();
  await ff.restart({ restore: true });
  const count = mutations(ff).length;
  sync = wire(ff);
  await drain(ff, sync);
  const after = await snapshot(ff);
  assert.deepEqual(after.tree, before.tree);
  assert.equal(mutations(ff).length, count);
  assert.ok(Object.keys(after.state.groups).every(id => !["11", "12"].includes(id)));
  assert.ok(Object.keys(after.state.tabs).every(id => !["2", "3", "4", "5"].includes(id)));
  assert.deepEqual(after.state.pendingRemovals, {});
  assert.deepEqual(after.state.failedCreates, {});
  assert.deepEqual(after.state.quietUntil, {});
  assert.deepEqual(after.state.expectedMoves, {});
  assert.deepEqual(after.state.missing, []);
});

test("restart without restore opens only pins unloaded and marks both groups missing without deletion", async () => {
  const ff = createFirefox(localSetup);
  let sync = wire(ff);
  await drain(ff, sync);
  const before = await snapshot(ff);
  await ff.restart({ restore: false });
  const count = ff.calls.length;
  sync = wire(ff);
  await drain(ff, sync);
  const { state, tree } = await snapshot(ff);
  assert.deepEqual(tree, before.tree);
  assert.deepEqual(state.missing, before.state.openFolders);
  assert.deepEqual(state.openFolders, []);
  assert.deepEqual((await ff.browser.tabs.query({ pinned: true })).map(t => [t.url, t.discarded]),
    [["https://pin-a/", true], ["https://pin-b/", true]]);
  assert.equal((await ff.browser.tabGroups.query({})).length, 0);
  assert.equal(ff.calls.slice(count).some(c => c.api.startsWith("bookmarks.remove")), false);
  for (const call of ff.calls.slice(count).filter(c => c.api === "tabs.create")) {
    assert.equal(call.args[0].active, false);
    assert.equal(call.args[0].pinned, true);
    assert.equal(call.args[0].discarded, undefined);
    assert.equal(call.args[0].title, undefined);
  }
});

test("second device matches a shared folder and opens only its extra openable bookmarks", async () => {
  const ff = createFirefox({ bookmarks: sharedTree, groups: [localSetup.groups[0]],
    tabs: [localSetup.tabs[0], localSetup.tabs[3]] });
  const sync = wire(ff);
  await drain(ff, sync);
  const { state, tree } = await snapshot(ff);
  assert.equal(tree.folders.length, 2);
  assert.equal(tree.folders[0].bookmarks.length, 3);
  assert.deepEqual((await ff.browser.tabs.query({ groupId: 11 })).map(t => t.url), ["https://work/", "https://extra/"]);
  assert.equal(Object.keys(state.groups).length, 1);
  assert.deepEqual(state.missing, []);
  assert.equal(ff.calls.filter(c => c.api === "bookmarks.create").length, 0);
});

test("user-deleted root is recreated on the next rebuild without deleting live groups", async () => {
  const ff = createFirefox(localSetup), sync = wire(ff);
  await drain(ff, sync);
  const before = await snapshot(ff);
  await ff.browser.bookmarks.removeTree(before.state.rootId);
  await drain(ff, sync);
  const after = await snapshot(ff);
  assert.notEqual(after.state.rootId, before.state.rootId);
  assert.equal(after.tree.folders.length, 2);
  assert.equal(after.tree.pinned.bookmarks.length, 2);
});

test("duplicate roots and pinned folders merge by moving, leave duplicates and never delete", async () => {
  const ff = createFirefox({ tabs: [{ id: 1, windowId: 1, url: "about:home" }], bookmarks: [
    { title: "Foxy", children: [{ title: "📌 Pinned", children: [{ url: "https://same/" }] }] },
    { title: "Foxy", children: [{ title: "📌 Pinned", children: [{ url: "https://same/" }, { url: "https://unique/" }] },
      { title: "🟢 Remote", children: [{ url: "https://remote/" }] }] },
  ] });
  const roots = await ff.browser.bookmarks.search({ title: "Foxy" });
  const sync = wire(ff);
  await drain(ff, sync);
  const { tree } = await snapshot(ff);
  assert.deepEqual(tree.pinned.bookmarks.map(b => b.url), ["https://same/", "https://unique/"]);
  assert.equal(tree.folders[0].title, "🟢 Remote");
  assert.equal((await ff.browser.bookmarks.getChildren(roots[1].id)).length, 0);
  assert.equal((await ff.browser.bookmarks.get(tree.extraPinned[0].id))[0].type, "folder");
  assert.deepEqual(tree.extraPinned[0].bookmarks.map(b => b.url), ["https://same/"]);
  assert.equal(ff.calls.some(c => c.api.startsWith("bookmarks.remove")), false);
});

test("start is single-flight and an event-page wake reuses session maps and drains persisted removals", async () => {
  const ff = createFirefox(localSetup), sync = wire(ff);
  await Promise.all([sync.start(), sync.start()]);
  await drain(ff, sync);
  const state = await loadState(ff.browser), entry = state.tabs[2];
  assert.equal(ff.calls.filter(c => c.api === "bookmarks.getSubTree").length, 2, "one rebuild despite concurrent start calls");
  // Lose the controller but keep the browser session, as an MV3 wake does.
  await ff.browser.tabs.remove(2);
  // Do not deliver the old controller's event: emulate suspension after persisting a removal.
  state.pendingRemovals[2] = { bookmarkId: entry.bookmarkId, folderId: entry.folderId, due: 0 };
  await saveState(ff.browser, state);
  const waking = wire(ff);
  const before = ff.calls.filter(c => c.api === "bookmarks.getSubTree").length;
  await waking.start();
  await waking.start();
  assert.equal(ff.calls.filter(c => c.api === "bookmarks.getSubTree").length, before);
  await assert.rejects(ff.browser.bookmarks.get(entry.bookmarkId));
});

test("settle resets the quiet interval on tab/group events and cleans up listeners", async () => {
  const ff = createFirefox();
  let done = false;
  const promise = settle(ff.browser, { settleMs: 25, maxWaitMs: 100, now: Date.now }).then(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 15));
  ff.fire("tabGroups.onUpdated", { id: 1 });
  await ff.settle();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(done, false);
  await promise;
  // A later event cannot restart or retain a settled waiter.
  ff.fire("tabs.onCreated", { id: 1 });
  await ff.settle();
});

test("settle stops at maxWaitMs even while events keep arriving", async () => {
  const ff = createFirefox();
  const interval = setInterval(() => { ff.fire("tabs.onUpdated", 1, {}); void ff.settle(); }, 2);
  try {
    await settle(ff.browser, { settleMs: 500, maxWaitMs: 20, now: Date.now });
  } finally { clearInterval(interval); }
});
