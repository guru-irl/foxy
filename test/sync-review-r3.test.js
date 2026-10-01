import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { wire, drain } from "./fakes/sync.js";
import { createInbound } from "../extension/src/sync/inbound.js";
import { emptyState, loadState, saveState, wasRemoved } from "../extension/src/sync/state.js";

const setup = () => ({
  groups: [{ id: 11, windowId: 1, title: "Dev", color: "red" },
    { id: 12, windowId: 1, title: "Ops", color: "blue" }],
  tabs: [{ id: 1, windowId: 1, url: "about:home", active: true },
    { id: 3, windowId: 1, groupId: 11, url: "https://one/" },
    { id: 4, windowId: 1, groupId: 11, url: "https://two/" },
    { id: 5, windowId: 1, groupId: 12, url: "https://ops/" }],
});

// Stale removal evidence must not turn a same-GUID revival's later move into deletion.
for (const undo of [false, true]) {
  test(`bookmark transfers its tab after ${undo ? "delete and same-GUID undo" : "no deletion"}, 11 minutes later`, async () => {
    let clock = 1000;
    const ff = createFirefox(setup());
    ff.sync = wire(ff, { now: () => clock }); await drain(ff, ff.sync);
    const before = await loadState(ff.browser), id = before.tabs[4].bookmarkId;
    const dev = before.groups[11].folderId, ops = before.groups[12].folderId;
    let tabId = 4;
    if (undo) {
      const [node] = await ff.browser.bookmarks.get(id);
      await ff.browser.bookmarks.remove(id); await drain(ff, ff.sync);
      assert.equal((await loadState(ff.browser)).removedIds[id], 1000);
      await ff.browser.bookmarks.create({ id, parentId: dev, index: node.index,
        url: node.url, title: node.title });
      await drain(ff, ff.sync);
      const revived = await loadState(ff.browser);
      tabId = Number(Object.entries(revived.tabs).find(([, entry]) => entry.bookmarkId === id)[0]);
    }
    clock += 11 * 60 * 1000;
    ff.calls.length = 0;
    await ff.browser.bookmarks.move(id, { parentId: ops }); await drain(ff, ff.sync);
    assert.equal(ff.calls.filter(call => call.api === "tabs.remove").length, 0);
    assert.equal(ff.calls.filter(call => call.api === "tabs.create").length, 0);
    assert.equal((await ff.browser.tabs.get(tabId)).groupId, 12);
    const after = await loadState(ff.browser);
    assert.equal(after.tabs[tabId].bookmarkId, id);
    assert.equal(after.tabs[tabId].folderId, ops);
    assert.equal(after.removedIds[id], undefined);
  });
}

// Folder deletion records descendants from state; each restored onCreated must clear its own GUID.
test("folder undo clears persisted removal evidence for the folder and restored children", async () => {
  const ff = createFirefox(setup());
  ff.sync = wire(ff, { now: () => 1000 }); await drain(ff, ff.sync);
  const before = await loadState(ff.browser), id = before.groups[11].folderId;
  const [folder] = await ff.browser.bookmarks.get(id);
  const children = await ff.browser.bookmarks.getChildren(id);
  await ff.browser.bookmarks.removeTree(id); await drain(ff, ff.sync);
  const removed = await loadState(ff.browser);
  for (const node of [folder, ...children]) assert.equal(removed.removedIds[node.id], 1000);
  await ff.browser.bookmarks.create({ id, parentId: folder.parentId, index: folder.index, title: folder.title });
  await drain(ff, ff.sync);
  assert.equal((await loadState(ff.browser)).removedIds[id], undefined);
  for (const child of children) {
    await ff.browser.bookmarks.create({ id: child.id, parentId: id, index: child.index,
      url: child.url, title: child.title });
    await drain(ff, ff.sync);
    assert.equal((await loadState(ff.browser)).removedIds[child.id], undefined);
  }
});

// A live folder read must repair evidence even without a delivered onCreated event.
test("reconcile clears removal evidence for live bookmark nodes and preserves absent evidence", async () => {
  const ff = createFirefox(setup());
  ff.sync = wire(ff); await drain(ff, ff.sync);
  const state = await loadState(ff.browser), folderId = state.groups[11].folderId;
  const ids = (await ff.browser.bookmarks.getChildren(folderId)).map(node => node.id);
  for (const id of ids) state.removedIds[id] = 1000;
  state.removedIds.absent = 1000;
  await saveState(ff.browser, state);
  const inbound = createInbound({ api: ff.browser, getState: () => state,
    save: () => saveState(ff.browser, state), now: () => 1000 });
  ff.calls.length = 0;
  await inbound.reconcileFolder(folderId);
  const after = await loadState(ff.browser);
  assert.deepEqual(after.removedIds, { absent: 1000 });
  assert.equal(ff.calls.some(call => call.api === "tabs.remove" || call.api === "tabs.create"), false);
});

// A wall-clock rollback does not invalidate finite onRemoved evidence.
test("removal evidence recorded in the future still counts after a clock step back", () => {
  const state = emptyState();
  state.removedIds.removed = 2000;
  assert.equal(wasRemoved(state, "removed", 1000), true);
  for (const value of [undefined, NaN, Infinity, "2000"]) {
    state.removedIds.removed = value;
    assert.equal(wasRemoved(state, "removed", 1000), false);
  }
});
