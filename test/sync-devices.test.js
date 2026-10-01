import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { createSyncServer } from "./fakes/sync-server.js";
import { wire, drain, mutations } from "./fakes/sync.js";
import { loadState } from "../extension/src/sync/state.js";
import { readTree } from "../extension/src/sync/tree.js";

for (const [deliveryOrder, expected] of [
  ["reverse", ["two", "one", "g", "p", "r"]],
  ["shuffle", ["g", "one", "two", "r", "p"]], // Seed 42: swaps (4,1), (3,0), (2,1), (1,0).
]) nodeTest(`harness ${deliveryOrder} delivery reorders events without changing the final tree`, async () => {
  const a = createFirefox({ bookmarks: [{ id: "r", title: "Foxy", children: [
    { id: "p", title: "📌 Pinned" }, { id: "g", title: "🔴 Dev", children: [
      { id: "one", url: "https://one/" }, { id: "two", url: "https://two/" }] }] }] });
  const b = createFirefox(), received = [];
  b.browser.bookmarks.onCreated.addListener(id => received.push(id));
  const server = createSyncServer({ deliveryOrder, seed: 42 });
  for (const ff of [a, b]) { ff.sync = { idle: async () => {} }; server.attach(ff); }
  await server.syncAll();
  assert.deepEqual(received, expected);
  assert.deepEqual(await b.browser.bookmarks.getTree(), await a.browser.bookmarks.getTree());
  assert.equal((await server.syncAll()).uploaded, 0);
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const home = { id: 1, windowId: 1, url: "about:home", active: true };
const seed = [{ title: "Foxy", children: [{ title: "📌 Pinned" }] }];
async function devices(openB = true, options = {}) {
  const a = createFirefox({ bookmarkPrefix: "a", bookmarks: seed, groups: [{ id: 11, windowId: 1, title: "Dev", color: "red" }],
    tabs: [home, { id: 2, windowId: 1, groupId: 11, url: "https://one/" },
      { id: 3, windowId: 1, groupId: 11, url: "https://two/" }] });
  const b = createFirefox({ bookmarkPrefix: "z", bookmarks: seed, tabs: [home] });
  const server = createSyncServer(options);
  for (const ff of [a, b]) { ff.sync = wire(ff); await drain(ff, ff.sync); server.attach(ff); }
  await converge(server, a, b);
  if (openB) {
    const saved = await b.sync.onMessage({ type: "foxy:saved" });
    assert.equal((await b.sync.onMessage({ type: "foxy:open-saved", folderId: saved.saved[0].folderId })).ok, true);
    await converge(server, a, b);
  }
  return { a, b, server };
}
async function converge(server, ...devices) {
  for (const ff of devices) { await drain(ff, ff.sync); }
  await delay(5); // Injected zero-delay removal timers run outside fake event delivery.
  for (let round = 0; round < 5; round++) {
    const result = await server.syncAll();
    if (!result.uploaded) {
      const before = devices.map(ff => mutations(ff).length);
      assert.equal((await server.syncAll()).uploaded, 0, "second round uploads nothing");
      assert.deepEqual(devices.map(ff => mutations(ff).length), before, "second round moves/writes nothing");
      assert.deepEqual(await devices[0].browser.bookmarks.getTree(), await devices[1].browser.bookmarks.getTree());
      for (const ff of devices) assert.deepEqual(ff.errors, []);
      return;
    }
  }
  assert.fail("bookmark sync did not converge in five rounds");
}
async function group(ff) { return (await ff.browser.tabGroups.query({}))[0]; }
async function urls(ff) { const g = await group(ff); return g ? (await ff.browser.tabs.query({ groupId: g.id })).map(t => t.url) : []; }
async function tree(ff) { return readTree(ff.browser, (await loadState(ff.browser)).rootId); }
async function bothUrls(a, b, want) { assert.deepEqual(await urls(a), want); assert.deepEqual(await urls(b), want); }

for (const deliveryOrder of ["forward", "reverse", "shuffle"]) {
const test = (name, body) => nodeTest(`${deliveryOrder}: ${name}`, body);
const orderedDevices = openB => devices(openB, { deliveryOrder, seed: 42 });

test("1: a new group is saved on B and opens as two unloaded tabs", async () => {
  const { a, b, server } = await orderedDevices(false);
  const saved = await b.sync.onMessage({ type: "foxy:saved" });
  assert.deepEqual(saved.saved.map(s => [s.title, s.color, s.count]), [["Dev", "red", 2]]);
  assert.deepEqual(await urls(b), []);
  const response = await b.sync.onMessage({ type: "foxy:open-saved", folderId: saved.saved[0].folderId });
  assert.equal(response.ok, true);
  await converge(server, a, b);
  await bothUrls(a, b, ["https://one/", "https://two/"]);
  assert.equal((await group(b)).title, "Dev");
  assert.deepEqual((await b.browser.tabs.query({ groupId: response.groupId })).map(t => [t.active, t.discarded]), [[false, true], [false, true]]);
});
test("2: a tab added in the middle arrives in the middle", async () => {
  const { a, b, server } = await orderedDevices();
  const added = await a.browser.tabs.create({ windowId: 1, index: 2, url: "https://middle/", active: false });
  await a.browser.tabs.group({ groupId: 11, tabIds: [added.id] });
  await converge(server, a, b);
  await bothUrls(a, b, ["https://one/", "https://middle/", "https://two/"]);
});
for (const shown of [false, true]) test(`3: remote close ${shown ? "defers B's shown tab" : "closes B's hidden tab"}`, async () => {
  const { a, b, server } = await orderedDevices();
  const target = (await b.browser.tabs.query({ groupId: (await group(b)).id }))[0];
  if (shown) await b.browser.tabs.update(target.id, { active: true });
  await a.browser.tabs.remove(2);
  await converge(server, a, b);
  assert.deepEqual(await urls(a), ["https://two/"]);
  assert.deepEqual(await urls(b), shown ? ["https://one/", "https://two/"] : ["https://two/"]);
  if (shown) { await b.browser.tabs.update(1, { active: true }); await converge(server, a, b); }
  await bothUrls(a, b, ["https://two/"]);
});
test("4: remote rename and recolour update B's group", async () => {
  const { a, b, server } = await orderedDevices();
  await a.browser.tabGroups.update(11, { title: "Tools", color: "green" });
  await converge(server, a, b);
  for (const ff of [a, b]) { const g = await group(ff); assert.deepEqual([g.title, g.color], ["Tools", "green"]); }
  await bothUrls(a, b, ["https://one/", "https://two/"]);
});
test("5: complete navigation propagates without redirect ping-pong", async () => {
  const { a, b, server } = await orderedDevices();
  await a.browser.tabs.update(2, { url: "https://navigated/" });
  a.fire("tabs.onUpdated", 2, { status: "complete" }, await a.browser.tabs.get(2));
  await converge(server, a, b);
  await bothUrls(a, b, ["https://navigated/", "https://two/"]);
});
test("6: pin transfers B's tab and unpin closes B's pin", async () => {
  const { a, b, server } = await orderedDevices();
  await a.browser.tabs.update(2, { pinned: true });
  await converge(server, a, b);
  for (const ff of [a, b]) assert.deepEqual((await ff.browser.tabs.query({ pinned: true })).map(t => t.url), ["https://one/"]);
  await bothUrls(a, b, ["https://two/"]);
  await a.browser.tabs.update(2, { pinned: false });
  await converge(server, a, b);
  for (const ff of [a, b]) assert.deepEqual(await ff.browser.tabs.query({ pinned: true }), []);
  assert.equal((await b.browser.tabs.query({})).some(t => t.url === "https://one/"), false);
  await bothUrls(a, b, ["https://two/"]);
});
test("7: whole-group close keeps the folder and B's open group", async () => {
  const { a, b, server } = await orderedDevices();
  const before = await a.browser.bookmarks.getTree();
  await a.browser.tabs.remove([2, 3]);
  await converge(server, a, b);
  assert.deepEqual(await a.browser.bookmarks.getTree(), before);
  assert.deepEqual(await urls(a), []);
  assert.deepEqual(await urls(b), ["https://one/", "https://two/"]);
});
test("8: deleting a saved group leaves B's tabs open and ungrouped", async () => {
  const { a, b, server } = await orderedDevices();
  await a.browser.tabs.remove([2, 3]);
  await converge(server, a, b);
  const saved = await a.sync.onMessage({ type: "foxy:saved" });
  assert.deepEqual(await a.sync.onMessage({ type: "foxy:delete-saved", folderId: saved.saved[0].folderId }), { ok: true });
  await converge(server, a, b);
  for (const ff of [a, b]) assert.deepEqual((await tree(ff)).folders, []);
  assert.deepEqual(await urls(a), []);
  assert.deepEqual(await urls(b), []);
  assert.deepEqual((await b.browser.tabs.query({})).filter(t => t.url.startsWith("https:")).map(t => [t.url, t.groupId]), [["https://one/", -1], ["https://two/", -1]]);
});
test("9: concurrent additions to one group both survive the per-id merge", async () => {
  const { a, b, server } = await orderedDevices();
  for (const [ff, url] of [[a, "https://from-a/"], [b, "https://from-b/"]]) {
    const tab = await ff.browser.tabs.create({ windowId: 1, url, active: false });
    await ff.browser.tabs.group({ groupId: (await group(ff)).id, tabIds: [tab.id] });
    await drain(ff, ff.sync);
  }
  await converge(server, a, b);
  await bothUrls(a, b, ["https://one/", "https://two/", "https://from-b/", "https://from-a/"]);
  assert.deepEqual((await tree(a)).folders[0].bookmarks.map(t => t.url), await urls(a));
});
test("10: closing A's window uploads no bookmark changes", async () => {
  const { a, b, server } = await orderedDevices();
  const cursor = a.bookmarkChanges(0).cursor, before = await a.browser.bookmarks.getTree();
  await a.closeWindow(1);
  await drain(a, a.sync);
  await delay(5);
  assert.deepEqual(a.bookmarkChanges(cursor).nodes, []);
  assert.equal((await server.syncAll()).uploaded, 0);
  await converge(server, a, b);
  assert.equal(a.layout(1), "| ");
  assert.deepEqual(await urls(b), ["https://one/", "https://two/"]);
  assert.deepEqual(await a.browser.bookmarks.getTree(), before);
});

test("first-run independent roots merge into one managed oldest root and pinned folder without deleting", async () => {
  const a = createFirefox({ bookmarkPrefix: "a", groups: [{ id: 11, windowId: 1, title: "A", color: "red" }],
    tabs: [home, { id: 2, windowId: 1, pinned: true, url: "https://pin-a/" },
      { id: 3, windowId: 1, groupId: 11, url: "https://from-a/" }] });
  // Different dateAdded values ensure the winner is determined by age, not delivery order.
  const b = createFirefox({ bookmarkPrefix: "z", bookmarks: [{ id: "older-root", title: "Foxy", dateAdded: 1 }],
    groups: [{ id: 11, windowId: 1, title: "B", color: "blue" }],
    tabs: [home, { id: 2, windowId: 1, pinned: true, url: "https://pin-b/" },
      { id: 3, windowId: 1, groupId: 11, url: "https://from-b/" }] });
  const server = createSyncServer({ deliveryOrder, seed: 42 });
  for (const ff of [a, b]) { ff.sync = wire(ff); await drain(ff, ff.sync); server.attach(ff); }
  const original = await Promise.all([a, b].map(ff => loadState(ff.browser)));
  assert.notEqual(original[0].rootId, original[1].rootId);
  assert.notEqual(original[0].pinnedId, original[1].pinnedId);
  await converge(server, a, b);
  for (const ff of [a, b]) {
    const state = await loadState(ff.browser), merged = await tree(ff);
    assert.equal(state.rootId, "older-root", "oldest root wins before a browser restart");
    assert.equal(state.pinnedId, original[1].pinnedId);
    assert.deepEqual(merged.pinned.bookmarks.map(n => n.url).sort(), ["https://pin-a/", "https://pin-b/"]);
    assert.deepEqual(merged.folders.map(f => f.bookmarks.map(n => n.url)).flat().sort(), ["https://from-a/", "https://from-b/"]);
    assert.deepEqual((await ff.browser.tabs.query({ pinned: true })).map(t => t.url).sort(), ["https://pin-a/", "https://pin-b/"]);
    assert.deepEqual((await ff.browser.tabs.query({ groupId: 11 })).map(t => t.url), [ff === a ? "https://from-a/" : "https://from-b/"]);
    // Task 1 leaves empty duplicates in place, rather than deleting their GUIDs.
    assert.equal((await ff.browser.bookmarks.getChildren(original[0].rootId)).length, 0);
    assert.deepEqual(merged.extraPinned.map(f => f.bookmarks), [[]]);
    for (const initial of original) {
      assert.equal((await ff.browser.bookmarks.get(initial.rootId))[0].type, "folder");
      assert.equal((await ff.browser.bookmarks.get(initial.pinnedId))[0].type, "folder");
    }
    assert.equal(ff.calls.some(call => /^bookmarks\.remove/.test(call.api)), false);
  }
});

for (const kind of ["remote batch", "local multi-drag"]) test(`multi-move ${kind} converges on both devices and stays quiet`, async () => {
  const { a, b, server } = await orderedDevices();
  for (const url of ["https://three/", "https://four/", "https://five/"]) {
    const tab = await a.browser.tabs.create({ windowId: 1, url, active: false });
    await a.browser.tabs.group({ groupId: 11, tabIds: [tab.id] });
  }
  await converge(server, a, b);
  if (kind === "remote batch") {
    const nodes = (await tree(a)).folders[0].bookmarks;
    await a.browser.bookmarks.move(nodes[4].id, { index: 0 });
    await a.browser.bookmarks.move(nodes[2].id, { index: 1 });
    await a.browser.bookmarks.move(nodes[0].id, { index: 4 });
  } else {
    const tabs = await a.browser.tabs.query({ groupId: 11 });
    // Several drags before events drain. Earlier outbound jobs see the final strip.
    await a.browser.tabs.move(tabs[4].id, { index: 1 });
    await a.browser.tabs.move(tabs[2].id, { index: 2 });
    await a.browser.tabs.move(tabs[0].id, { index: 5 });
    const before = a.calls.length;
    await drain(a, a.sync);
    const reads = a.calls.slice(before).filter(call => call.api === "tabs.get").length;
    assert.ok(reads <= 15, `one five-member sweep for the drained batch, not one per move: ${reads} reads`);
  }
  await converge(server, a, b);
  await bothUrls(a, b, ["https://five/", "https://three/", "https://two/", "https://four/", "https://one/"]);
  assert.deepEqual((await tree(a)).folders[0].bookmarks.map(b => b.url), await urls(a));
});

}
