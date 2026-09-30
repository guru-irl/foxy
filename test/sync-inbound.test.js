import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { emptyState, loadState, saveState, createQueue } from "../extension/src/sync/state.js";
import { createOutbound } from "../extension/src/sync/outbound.js";
import { createInbound } from "../extension/src/sync/inbound.js";

const url = name => `https://example.com/${name}`;
const bookmarkWrites = ff => ff.calls.filter(c => /^bookmarks\.(create|update|move|remove|removeTree)$/.test(c.api));
const mutations = ff => ff.calls.filter(c => /^(tabs\.(create|update|move|group|ungroup|remove|discard)|tabGroups\.(update|move)|storage\.local\.set)$/.test(c.api));
const tabActions = ff => mutations(ff).filter(c => !c.api.startsWith("storage."));

async function fixture(options = {}) {
  const ff = createFirefox({
    windows: [{ id: 1, focused: true }, { id: 2 }],
    groups: [{ id: 7, windowId: 1, title: "  Work  ", color: "red" },
      { id: 8, windowId: 2, title: "Play", color: "blue" }],
    tabs: [
      { id: 30, windowId: 1, groupId: 7, url: url("a"), title: "A" },
      { id: 10, windowId: 1, groupId: 7, url: url("b"), title: "B" },
      { id: 20, windowId: 1, groupId: 7, url: url("c"), title: "C" },
      { id: 99, windowId: 1, url: url("loose"), active: true },
      { id: 40, windowId: 2, groupId: 8, url: url("d"), title: "D" },
      { id: 50, windowId: 2, groupId: 8, url: url("e"), title: "E" },
      { id: 199, windowId: 2, url: url("other"), active: true },
    ],
    bookmarks: [{ title: "Foxy", children: [{ title: "📌 Pinned" }, { title: "🩶 Saved" }] }],
  });
  const api = ff.browser;
  let state = emptyState();
  [state.rootId] = (await api.bookmarks.getChildren("unfiled_____")).map(n => n.id);
  [state.pinnedId] = (await api.bookmarks.getChildren(state.rootId)).map(n => n.id);
  let clock = 100;
  const config = { api, getState: () => state, save: () => saveState(api, state), now: () => clock, ...options };
  const outbound = createOutbound({ ...config, removeDelayMs: 0, extensionBaseUrl: api.runtime.getURL("") });
  const inbound = createInbound(config);
  await outbound.syncGroup(7);
  await outbound.syncGroup(8);
  await ff.settle();
  ff.calls.length = 0;
  return { ff, api, get state() { return state; }, outbound, inbound,
    folder: (id = 7) => state.groups[id].folderId,
    bookmark: id => state.tabs[id].bookmarkId,
    config, restart: async () => { state = await loadState(api); return createInbound(config); },
    tick: ms => { clock += ms; } };
}

// Catch missing entry updates, duplicate creates, redirect echoes and repeated writes.
async function echoAndStable(f) {
  await f.ff.settle();
  assert.deepEqual(f.ff.errors, []);
  f.ff.calls.length = 0;
  for (const id of Object.keys(f.state.tabs).map(Number)) await f.outbound.syncTab(id);
  for (const id of Object.keys(f.state.groups).map(Number)) await f.outbound.syncGroup(id);
  await f.ff.settle();
  assert.deepEqual(bookmarkWrites(f.ff), [], "inbound tab events must not echo bookmark writes");
  const before = structuredClone(f.state), layouts = [f.ff.layout(1), f.ff.layout(2)];
  f.ff.calls.length = 0;
  await f.inbound.reconcileAll();
  await f.ff.settle();
  assert.deepEqual(mutations(f.ff), [], "second inbound pass must have no mutations");
  assert.deepEqual(f.state, before);
  assert.deepEqual([f.ff.layout(1), f.ff.layout(2)], layouts);
}

for (const [index, layout] of [[0, "| [7: 200 30 10 20] 99"], [1, "| [7: 30 200 10 20] 99"], [3, "| [7: 30 10 20 200] 99"]]) {
  test(`bookmark addition at index ${index} creates one unloaded group tab at that position`, async () => {
    const f = await fixture();
    const b = await f.api.bookmarks.create({ parentId: f.folder(), index, url: url("remote"), title: "Remote" });
    f.ff.calls.length = 0;
    await f.inbound.reconcileFolder(f.folder());
    const t = await f.api.tabs.get(200);
    assert.equal(f.ff.layout(1), layout);
    assert.equal(t.discarded, true);
    assert.equal(t.active, false);
    assert.deepEqual(f.state.tabs[200], { bookmarkId: b.id, folderId: f.folder(), url: url("remote"), title: "Remote" });
    assert.equal(f.state.quietUntil[200], 10100);
    assert.deepEqual(f.ff.calls.find(c => c.api === "tabs.create").args,
      [{ windowId: 1, url: url("remote"), title: "Remote", discarded: true, active: false }]);
    assert.deepEqual(await loadState(f.api), f.state);
    await echoAndStable(f);
  });
}

test("about:blank additions and URL changes are skipped and recorded once under the HTTP(S)-only ruling", async () => {
  const f = await fixture();
  await f.api.bookmarks.create({ parentId: f.folder(), index: 0, url: "about:blank", title: "Blank" });
  await f.api.bookmarks.update(f.bookmark(10), { url: "about:blank" });
  f.ff.calls.length = 0;
  await f.inbound.reconcileFolder(f.folder());
  assert.deepEqual(tabActions(f.ff), []);
  assert.equal(f.state.tabs[200], undefined);
  assert.equal((await f.api.tabs.get(10)).url, url("b"));
  assert.deepEqual(f.state.cantReopen[f.folder()], ["about:blank"]);
  await echoAndStable(f);
});

test("removed bookmark closes only its mapped tab and deletes quiet bookkeeping", async (t) => {
  t.mock.method(console, "warn", () => {});
  const f = await fixture();
  f.state.quietUntil[10] = 200;
  await f.api.bookmarks.remove(f.bookmark(10));
  f.ff.calls.length = 0;
  await f.inbound.reconcileFolder(f.folder());
  assert.equal(f.ff.layout(1), "| [7: 30 20] 99");
  assert.equal(f.state.tabs[10], undefined);
  assert.equal(f.state.quietUntil[10], undefined);
  assert.deepEqual(tabActions(f.ff).map(c => c.api), ["tabs.remove"]);
  await echoAndStable(f);
});

for (const [id, index, layout] of [[30, 2, "| [7: 10 20 30] 99"], [20, 0, "| [7: 20 30 10] 99"]]) {
  test(`bookmarkMoved reorders tab ${id} using the final index and does not move it twice`, async () => {
    const f = await fixture(), bid = f.bookmark(id), folderId = f.folder();
    await f.api.bookmarks.move(bid, { index });
    f.ff.calls.length = 0;
    const info = { parentId: folderId, oldParentId: folderId, index };
    await f.inbound.bookmarkMoved(bid, info);
    assert.equal(f.ff.layout(1), layout);
    assert.deepEqual(tabActions(f.ff).map(c => c.api), ["tabs.move"]);
    f.ff.calls.length = 0;
    await f.inbound.bookmarkMoved(bid, info);
    assert.deepEqual(mutations(f.ff), []);
    await echoAndStable(f);
  });
}

for (const targetFirst of [false, true]) test(`move between open groups preserves tab identity, target-first=${targetFirst}`, async () => {
  const f = await fixture(), bid = f.bookmark(10), source = f.folder(), target = f.folder(8);
  await f.api.bookmarks.move(bid, { parentId: target, index: 1 });
  f.ff.calls.length = 0;
  if (targetFirst) await f.inbound.reconcileFolder(target);
  await f.inbound.bookmarkMoved(bid, { parentId: target, oldParentId: source, index: 1 });
  assert.equal(f.ff.layout(1), "| [7: 30 20] 99");
  assert.equal(f.ff.layout(2), "| [8: 40 10 50] 199");
  assert.equal(f.state.tabs[10].bookmarkId, bid);
  assert.equal(f.state.tabs[10].folderId, target);
  assert.equal(f.ff.calls.filter(c => c.api === "tabs.create").length, 0);
  await echoAndStable(f);
});

test("bookmark moved to a saved folder closes its tab, without opening the saved group", async () => {
  const f = await fixture(), source = f.folder();
  const saved = (await f.api.bookmarks.getChildren(f.state.rootId)).find(n => n.title === "🩶 Saved").id;
  const bid = f.bookmark(10);
  await f.api.bookmarks.move(bid, { parentId: saved });
  await f.inbound.bookmarkMoved(bid, { oldParentId: source, parentId: saved });
  assert.equal(f.state.tabs[10], undefined);
  assert.equal(f.ff.layout(1), "| [7: 30 20] 99");
  assert.equal((await f.api.bookmarks.get(bid))[0].parentId, saved);
  await echoAndStable(f);
});

test("bookmark URL change navigates once, records the actual title and starts the redirect quiet period", async () => {
  const f = await fixture({ quietMs: 25 });
  await f.api.bookmarks.update(f.bookmark(10), { url: url("remote"), title: "Remote bookmark title" });
  f.ff.calls.length = 0;
  await f.inbound.reconcileFolder(f.folder());
  assert.equal((await f.api.tabs.get(10)).url, url("remote"));
  assert.equal(f.state.tabs[10].url, url("remote"));
  assert.equal(f.state.tabs[10].title, url("remote"));
  assert.equal(f.state.quietUntil[10], 125);
  assert.deepEqual(tabActions(f.ff), [{ api: "tabs.update", args: [10, { url: url("remote") }] }]);
  await echoAndStable(f);
  await f.api.tabs.update(10, { url: url("redirect") });
  f.ff.calls.length = 0;
  await f.outbound.syncTab(10);
  await f.inbound.reconcileFolder(f.folder());
  assert.deepEqual(bookmarkWrites(f.ff), []);
  assert.deepEqual(tabActions(f.ff), []);
  assert.equal((await f.api.tabs.get(10)).url, url("redirect"));
});

test("pending local navigation is not reverted using the live tab URL as direction", async () => {
  const f = await fixture();
  await f.api.tabs.update(10, { url: url("local") });
  f.ff.calls.length = 0;
  await f.inbound.reconcileFolder(f.folder());
  assert.equal(f.state.tabs[10].url, url("b"));
  assert.equal((await f.api.tabs.get(10)).url, url("local"));
  assert.deepEqual(tabActions(f.ff), []);
});

test("remote folder rename/recolour trims names and leaves syncGroup with no echo", async () => {
  const f = await fixture();
  await f.api.bookmarks.update(f.folder(), { title: "  🩵 Projects  " });
  f.ff.calls.length = 0;
  await f.inbound.reconcileFolder(f.folder());
  const g = await f.api.tabGroups.get(7);
  assert.equal(g.title, "Projects");
  assert.equal(g.color, "cyan");
  assert.equal(f.state.groups[7].title, "🩵 Projects");
  assert.deepEqual(tabActions(f.ff), [{ api: "tabGroups.update", args: [7, { title: "Projects", color: "cyan" }] }]);
  await echoAndStable(f);
});

test("a new saved folder is not opened or mapped automatically", async () => {
  const f = await fixture();
  const saved = await f.api.bookmarks.create({ parentId: f.state.rootId, title: "🟣 Remote" });
  await f.api.bookmarks.create({ parentId: saved.id, url: url("saved"), title: "Saved" });
  const before = structuredClone(f.state);
  f.ff.calls.length = 0;
  await f.inbound.reconcileFolder(saved.id);
  assert.deepEqual(f.state, before);
  assert.deepEqual(mutations(f.ff), []);
  await echoAndStable(f);
});

test("deleted group folder ungroups tabs, preserves pages and clears all folder bookkeeping", async () => {
  const f = await fixture(), folderId = f.folder();
  f.state.missing.push(folderId);
  f.state.cantReopen[folderId] = ["about:config"];
  f.state.deferred.push(folderId);
  f.state.quietUntil[10] = 999;
  await f.api.bookmarks.removeTree(folderId);
  await f.inbound.folderRemoved(folderId);
  assert.equal(f.ff.layout(1), "| 30 10 20 99");
  assert.equal((await f.api.tabs.get(10)).url, url("b"));
  assert.equal(f.state.groups[7], undefined);
  for (const id of [30, 10, 20]) assert.equal(f.state.tabs[id], undefined);
  assert.equal(f.state.quietUntil[10], undefined);
  assert.equal(f.state.openFolders.includes(folderId), false);
  assert.equal(f.state.missing.includes(folderId), false);
  assert.equal(f.state.cantReopen[folderId], undefined);
  assert.equal(f.state.deferred.includes(folderId), false);
  assert.deepEqual(await loadState(f.api), f.state);
  await echoAndStable(f);
});

test("root removal resets identities and stale folder bookkeeping without closing tabs", async () => {
  const f = await fixture(), before = [f.ff.layout(1), f.ff.layout(2)];
  f.state.deferred.push(f.folder());
  f.state.cantReopen[f.folder()] = ["about:config"];
  await f.api.bookmarks.removeTree(f.state.rootId);
  await f.inbound.folderRemoved(f.state.rootId);
  assert.deepEqual(f.state, emptyState());
  assert.deepEqual([f.ff.layout(1), f.ff.layout(2)], before);
  assert.deepEqual(await loadState(f.api), emptyState());
});

async function addPins(f) {
  for (const windowId of [1, 2]) {
    const pin = await f.api.tabs.create({ windowId, url: url(`pin${windowId}`), pinned: true, active: false });
    await f.outbound.syncTab(pin.id);
  }
}

test("pin addition uses the last focused window and follows its earlier mapped pin before discarding", async () => {
  const f = await fixture();
  await addPins(f);
  await f.api.windows.update(2, { focused: true });
  const b = await f.api.bookmarks.create({ parentId: f.state.pinnedId, url: url("pin-remote"), title: "Bookmark pin title" });
  f.ff.calls.length = 0;
  await f.inbound.reconcileFolder(f.state.pinnedId);
  const t = await f.api.tabs.get(202);
  assert.equal(t.windowId, 2);
  assert.equal(t.index, 1);
  assert.equal(t.pinned, true);
  assert.equal(t.discarded, true);
  assert.equal(t.active, false);
  assert.deepEqual(f.state.tabs[202], { bookmarkId: b.id, folderId: f.state.pinnedId, url: url("pin-remote"), title: url("pin-remote") });
  const props = f.ff.calls.find(c => c.api === "tabs.create").args[0];
  assert.equal(props.windowId, 2);
  assert.equal(props.pinned, true);
  assert.equal(props.active, false);
  assert.equal(props.url, url("pin-remote"));
  assert.equal(Object.hasOwn(props, "discarded"), false);
  assert.equal(Object.hasOwn(props, "title"), false);
  assert.equal(f.state.quietUntil[202], 10100);
  await echoAndStable(f);
});

test("pin removal closes its mapped pinned tab", async (t) => {
  t.mock.method(console, "warn", () => {});
  const f = await fixture();
  await addPins(f);
  await f.api.bookmarks.remove(f.bookmark(200));
  await f.inbound.reconcileFolder(f.state.pinnedId);
  assert.equal(f.state.tabs[200], undefined);
  assert.equal((await f.api.tabs.query({ windowId: 1, pinned: true })).length, 0);
  await echoAndStable(f);
});

test("pin URL changes navigate rather than creating another pin", async () => {
  const f = await fixture();
  await addPins(f);
  await f.api.bookmarks.update(f.bookmark(200), { url: url("pin-new") });
  f.ff.calls.length = 0;
  await f.inbound.reconcileFolder(f.state.pinnedId);
  assert.equal((await f.api.tabs.get(200)).url, url("pin-new"));
  assert.deepEqual(tabActions(f.ff).map(c => c.api), ["tabs.update"]);
  await echoAndStable(f);
});

test("failed pin discard is logged but keeps the mapping and permits the next bookmark to open", async (t) => {
  const f = await fixture();
  t.mock.method(f.api.tabs, "discard", async () => { throw new Error("discard denied"); });
  const warnings = t.mock.method(console, "warn", () => {});
  for (const name of ["pin-a", "pin-b"]) await f.api.bookmarks.create({ parentId: f.state.pinnedId, url: url(name) });
  await f.inbound.reconcileFolder(f.state.pinnedId);
  assert.equal(f.state.tabs[200].url, url("pin-a"));
  assert.equal(f.state.tabs[201].url, url("pin-b"));
  assert.equal(warnings.mock.callCount(), 2);
  assert.ok(warnings.mock.calls.every(c => /^Foxy:/.test(c.arguments[0])));
  await echoAndStable(f);
});

test("unopenable URLs are recorded once, with no illegal create or navigate", async () => {
  const f = await fixture();
  // A leading skipped node and gaps between mapped nodes must not make
  // outbound tighten relative order into adjacency and echo bookmark moves.
  for (const [index, bad] of [[0, "about:config"], [2, "file:///notes.txt"],
    [4, "chrome://browser/content/"], [6, "about:config"]]) {
    await f.api.bookmarks.create({ parentId: f.folder(), index, url: bad });
  }
  await f.api.bookmarks.update(f.bookmark(50), { url: "file:///mapped.txt" });
  f.ff.calls.length = 0;
  await f.inbound.reconcileAll();
  assert.deepEqual(f.state.cantReopen[f.folder()], ["about:config", "file:///notes.txt", "chrome://browser/content/"]);
  assert.deepEqual(f.state.cantReopen[f.folder(8)], ["file:///mapped.txt"]);
  assert.equal((await f.api.tabs.get(50)).url, url("e"));
  assert.deepEqual(tabActions(f.ff), []);
  assert.deepEqual(await loadState(f.api), f.state);
  await echoAndStable(f);
});

for (const action of ["close", "navigate", "move", "cross-window move", "ungroup"]) {
  test(`shown tab ${action} is deferred durably and applies after activation`, async (t) => {
    t.mock.method(console, "warn", () => {});
    const f = await fixture(), source = f.folder(), bid = f.bookmark(10), target = f.folder(8);
    await f.api.tabs.update(10, { active: true });
    if (action === "close") await f.api.bookmarks.remove(bid);
    if (action === "navigate") await f.api.bookmarks.update(bid, { url: url("safe") });
    if (action === "move") await f.api.bookmarks.move(bid, { index: 0 });
    if (action === "cross-window move") await f.api.bookmarks.move(bid, { parentId: target, index: 1 });
    if (action === "ungroup") await f.api.bookmarks.removeTree(source);
    f.ff.calls.length = 0;
    if (action === "ungroup") await f.inbound.folderRemoved(source);
    else if (action.includes("move")) await f.inbound.bookmarkMoved(bid,
      { oldParentId: source, parentId: action === "move" ? source : target, index: action === "move" ? 0 : 1 });
    else await f.inbound.reconcileFolder(source);
    const shown = await f.api.tabs.get(10);
    assert.equal(shown.url, url("b"));
    assert.equal(shown.windowId, 1);
    assert.equal(shown.groupId, 7);
    assert.ok(f.state.deferred.includes(source));
    assert.ok(!tabActions(f.ff).some(c => c.args[0] === 10 || c.args[0]?.tabIds?.includes(10)
      || (Array.isArray(c.args[0]) && c.args[0].includes(10))), "no destructive action on the shown tab");
    assert.deepEqual(await loadState(f.api), f.state);
    const resumed = await f.restart();
    await resumed.applyDeferred();
    assert.ok(f.state.deferred.includes(source), "still shown must stay deferred");
    await f.api.tabs.update(99, { active: true });
    await resumed.applyDeferred();
    assert.deepEqual(f.state.deferred, []);
    if (action === "close") assert.equal(f.state.tabs[10], undefined);
    if (action === "navigate") assert.equal((await f.api.tabs.get(10)).url, url("safe"));
    if (action === "move") assert.equal(f.ff.layout(1), "| [7: 10 30 20] 99");
    if (action === "cross-window move") {
      assert.equal((await f.api.tabs.get(10)).groupId, 8);
      assert.equal(f.ff.layout(2), "| [8: 40 10 50] 199");
    }
    if (action === "ungroup") {
      assert.equal((await f.api.tabs.get(10)).groupId, -1);
      assert.equal(f.state.groups[7], undefined);
    }
    await echoAndStable(f);
  });
}

test("deferred navigation is revalidated and cancelled when the bookmark is changed back", async () => {
  const f = await fixture();
  await f.api.tabs.update(10, { active: true });
  await f.api.bookmarks.update(f.bookmark(10), { url: url("remote") });
  await f.inbound.reconcileFolder(f.folder());
  await f.api.bookmarks.update(f.bookmark(10), { url: url("b") });
  f.ff.calls.length = 0;
  await f.inbound.applyDeferred();
  assert.deepEqual(f.state.deferred, []);
  assert.deepEqual(tabActions(f.ff), []);
  assert.equal((await f.api.tabs.get(10)).url, url("b"));
  await echoAndStable(f);
});

test("isShown requires active and both the last-focused window identity and current focus", async (t) => {
  const f = await fixture();
  assert.equal(await f.inbound.isShown(await f.api.tabs.get(99)), true);
  assert.equal(await f.inbound.isShown(await f.api.tabs.get(30)), false);
  assert.equal(await f.inbound.isShown(await f.api.tabs.get(199)), false);
  await f.api.windows.update(2, { focused: true });
  assert.equal(await f.inbound.isShown(await f.api.tabs.get(99)), false);
  assert.equal(await f.inbound.isShown(await f.api.tabs.get(199)), true);
  const get = f.api.windows.getLastFocused;
  t.mock.method(f.api.windows, "getLastFocused", async props => ({ ...await get(props), focused: false }));
  assert.equal(await f.inbound.isShown(await f.api.tabs.get(199)), false);
});

test("focus change releases a deferred active tab in the previously focused window", async (t) => {
  t.mock.method(console, "warn", () => {});
  const f = await fixture();
  await f.api.tabs.update(10, { active: true });
  await f.api.bookmarks.remove(f.bookmark(10));
  await f.inbound.reconcileFolder(f.folder());
  await f.api.windows.update(2, { focused: true });
  await f.inbound.applyDeferred();
  assert.equal(f.state.tabs[10], undefined);
  assert.deepEqual(f.state.deferred, []);
  await echoAndStable(f);
});

test("API navigation rejection is logged without advancing lastSynced and later reconciliation retries", async (t) => {
  const f = await fixture(), update = f.api.tabs.update, before = structuredClone(f.state.tabs[10]);
  await f.api.bookmarks.update(f.bookmark(10), { url: url("retry") });
  t.mock.method(f.api.tabs, "update", async () => { throw new Error("navigation failed"); });
  const warn = t.mock.method(console, "warn", () => {});
  await f.inbound.reconcileFolder(f.folder());
  assert.deepEqual(f.state.tabs[10], before);
  assert.equal(f.state.quietUntil[10], undefined);
  assert.ok(warn.mock.calls.some(c => /^Foxy:/.test(c.arguments[0])));
  f.api.tabs.update = update;
  await f.inbound.reconcileFolder(f.folder());
  assert.equal((await f.api.tabs.get(10)).url, url("retry"));
  await echoAndStable(f);
});

test("queue-owned reconcileAll and applyDeferred do not enqueue or await their own queue", async () => {
  const f = await fixture(), queue = createQueue();
  await f.api.bookmarks.create({ parentId: f.folder(8), url: url("remote") });
  await queue.run(() => f.inbound.reconcileAll());
  await queue.run(() => f.inbound.applyDeferred());
  await queue.idle();
  assert.equal((await f.api.tabs.get(200)).groupId, 8);
  await echoAndStable(f);
});

// These regression cases catch lost persisted retries and Firefox's cross-window
// group insertion constraint, rather than merely checking that methods exist.
test("shown pin move is retried within its window without moving another window's pins", async () => {
  const f = await fixture();
  await addPins(f);
  const pin = await f.api.tabs.create({ windowId: 1, url: url("pin3"), pinned: true, active: false });
  await f.outbound.syncTab(pin.id);
  await f.api.tabs.update(pin.id, { active: true });
  const bid = f.bookmark(pin.id);
  await f.api.bookmarks.move(bid, { index: 0 });
  await f.inbound.bookmarkMoved(bid, { parentId: f.state.pinnedId, oldParentId: f.state.pinnedId, index: 0 });
  assert.equal((await f.api.tabs.get(pin.id)).index, 1);
  assert.deepEqual(f.state.deferred, [f.state.pinnedId]);
  const resumed = await f.restart();
  await resumed.applyDeferred();
  assert.deepEqual(f.state.deferred, [f.state.pinnedId]);
  await f.api.tabs.update(99, { active: true });
  await resumed.applyDeferred();
  assert.equal((await f.api.tabs.get(pin.id)).index, 0);
  assert.equal((await f.api.tabs.get(200)).index, 1);
  assert.equal((await f.api.tabs.get(201)).windowId, 2);
  assert.equal((await f.api.tabs.get(201)).index, 0);
  assert.deepEqual(f.state.deferred, []);
  await echoAndStable(f);
});

test("cross-window group move works when the destination group starts after the source tab index", async (t) => {
  const f = await fixture(), source = f.folder(), target = f.folder(8), bid = f.bookmark(10);
  for (let index = 0; index < 3; index++) await f.api.tabs.create({ windowId: 2, index: 0, url: url(`prefix${index}`), active: false });
  const warnings = t.mock.method(console, "warn", () => {});
  await f.api.bookmarks.move(bid, { parentId: target, index: 1 });
  await f.inbound.bookmarkMoved(bid, { oldParentId: source, parentId: target, index: 1 });
  assert.equal((await f.api.tabs.get(10)).groupId, 8);
  assert.equal((await f.api.tabs.get(10)).windowId, 2);
  assert.equal(f.ff.layout(2), "| 202 201 200 [8: 40 10 50] 199");
  assert.equal(warnings.mock.callCount(), 0);
  await echoAndStable(f);
});

test("a group-to-pin bookmark move reconciles in one target-first full pass", async () => {
  const f = await fixture(), bid = f.bookmark(10);
  await f.api.bookmarks.move(bid, { parentId: f.state.pinnedId });
  await f.inbound.reconcileAll();
  assert.equal(f.state.tabs[10], undefined);
  const pins = await f.api.tabs.query({ pinned: true });
  assert.equal(pins.length, 1);
  assert.equal(f.state.tabs[pins[0].id].bookmarkId, bid);
  assert.equal(f.state.tabs[pins[0].id].folderId, f.state.pinnedId);
  await echoAndStable(f);
});

for (const index of [0, 1]) test(`remote pin inserted at folder index ${index} precedes the target window's first pin without outbound echoes`, async () => {
  const f = await fixture();
  await addPins(f);
  await f.api.windows.update(2, { focused: true });
  const b = await f.api.bookmarks.create({ parentId: f.state.pinnedId, index, url: url("earlier-pin"), title: "Earlier" });
  await f.inbound.reconcileFolder(f.state.pinnedId);
  assert.equal((await f.api.tabs.get(202)).windowId, 2);
  assert.equal((await f.api.tabs.get(202)).index, 0);
  assert.equal((await f.api.tabs.get(201)).index, 1);
  assert.equal((await f.api.tabs.get(200)).windowId, 1);
  assert.equal((await f.api.tabs.get(200)).index, 0);
  assert.equal(f.state.tabs[202].bookmarkId, b.id);
  await echoAndStable(f);
});
