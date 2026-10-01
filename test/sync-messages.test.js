import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { wire, unwire, drain, localSetup, sharedTree, mutations } from "./fakes/sync.js";
import { loadState, saveState } from "../extension/src/sync/state.js";

async function savedSetup(options = {}) {
  const ff = createFirefox({ bookmarks: sharedTree,
    tabs: [{ id: 1, windowId: 1, url: "about:home", active: true }], ...options });
  const sync = wire(ff);
  await drain(ff, sync);
  const state = await loadState(ff.browser);
  const folders = (await ff.browser.bookmarks.getChildren(state.rootId)).filter(n => n.title !== "📌 Pinned");
  return { ff, sync, folders };
}

test("saved lists closed folders in folder order with counts and current cantReopen URLs", async () => {
  const { ff, sync, folders } = await savedSetup();
  const response = await sync.onMessage({ type: "foxy:saved" });
  assert.deepEqual(response, { saved: [
    { folderId: folders[0].id, title: "Work", color: "red", count: 3, cantReopen: ["file:///private"] },
    { folderId: folders[1].id, title: "Read", color: "blue", count: 1, cantReopen: [] },
  ], missing: [] });
  await ff.browser.bookmarks.create({ parentId: folders[1].id, url: "about:config" });
  assert.deepEqual((await sync.onMessage({ type: "foxy:saved" })).saved[1].cantReopen, ["about:config"]);
});

test("open-saved creates unloaded tabs in the requested window and maps before returning without echoes", async () => {
  const { ff, sync, folders } = await savedSetup({ windows: [{ id: 1, focused: true }, { id: 2 }],
    tabs: [{ id: 1, windowId: 1, url: "about:home", active: true },
      { id: 8, windowId: 2, url: "about:home", active: true }] });
  const response = await sync.onMessage({ type: "foxy:open-saved", folderId: folders[0].id, windowId: 2 });
  assert.equal(response.ok, true);
  const state = await loadState(ff.browser);
  assert.equal(state.groups[response.groupId].folderId, folders[0].id);
  const tabs = await ff.browser.tabs.query({ groupId: response.groupId });
  assert.equal((await ff.browser.tabGroups.get(response.groupId)).windowId, 2);
  assert.ok(tabs.every(tab => tab.windowId === 2));
  assert.deepEqual(tabs.map(t => [t.url, t.discarded, t.active]), [["https://work/", true, false], ["https://extra/", true, false]]);
  assert.equal(tabs.every(t => state.tabs[t.id]?.folderId === folders[0].id), true);
  assert.equal((await ff.browser.tabGroups.get(response.groupId)).title, "Work");
  assert.equal((await ff.browser.tabGroups.get(response.groupId)).color, "red");
  const count = mutations(ff).length;
  await drain(ff, sync);
  assert.equal(mutations(ff).length, count);
  assert.equal((await sync.onMessage({ type: "foxy:saved" })).saved.length, 1);
  const again = await sync.onMessage({ type: "foxy:open-saved", folderId: folders[0].id, windowId: 2 });
  assert.equal(again.groupId, response.groupId);
  assert.equal(mutations(ff).length, count);
});

test("delete-saved refuses an open folder and deletes/cleans only a closed group folder", async () => {
  const { ff, sync, folders } = await savedSetup();
  await sync.onMessage({ type: "foxy:open-saved", folderId: folders[0].id, windowId: 1 });
  assert.deepEqual(await sync.onMessage({ type: "foxy:delete-saved", folderId: folders[0].id }), { ok: false });
  assert.deepEqual(await sync.onMessage({ type: "foxy:delete-saved", folderId: folders[1].id }), { ok: true });
  await drain(ff, sync);
  await assert.rejects(ff.browser.bookmarks.get(folders[1].id));
  assert.equal((await ff.browser.bookmarks.get(folders[0].id))[0].type, "folder");
  const state = await loadState(ff.browser);
  assert.equal(state.missing.includes(folders[1].id), false);
  assert.equal(state.cantReopen[folders[1].id], undefined);
  assert.deepEqual(await sync.onMessage({ type: "foxy:delete-saved", folderId: state.rootId }), { ok: false });
  assert.deepEqual(await sync.onMessage({ type: "foxy:open-saved", folderId: state.pinnedId, windowId: 1 }), { ok: false });
});

async function missingSetup() {
  const ff = createFirefox(localSetup);
  let sync = wire(ff);
  await drain(ff, sync);
  await ff.restart({ restore: false });
  sync = wire(ff);
  await drain(ff, sync);
  return { ff, sync };
}

test("restore-all restores every missing folder in one queue job and clears the banner", async () => {
  const { ff, sync } = await missingSetup();
  assert.equal((await sync.onMessage({ type: "foxy:saved" })).missing.length, 2);
  assert.deepEqual(await sync.onMessage({ type: "foxy:restore-all", windowId: 1 }), { ok: true });
  await drain(ff, sync);
  assert.deepEqual(await sync.onMessage({ type: "foxy:saved" }), { saved: [], missing: [] });
  assert.equal((await ff.browser.tabGroups.query({})).length, 2);
});

test("open-saved removes just its missing folder and dismiss-missing keeps saved folders/bookmarks", async () => {
  const { ff, sync } = await missingSetup();
  const before = await sync.onMessage({ type: "foxy:saved" });
  await sync.onMessage({ type: "foxy:open-saved", folderId: before.missing[0].folderId, windowId: 1 });
  assert.equal((await sync.onMessage({ type: "foxy:saved" })).missing.length, 1);
  assert.deepEqual(await sync.onMessage({ type: "foxy:dismiss-missing" }), { ok: true });
  assert.equal((await sync.onMessage({ type: "foxy:saved" })).saved.length, 1);
  assert.deepEqual((await sync.onMessage({ type: "foxy:saved" })).missing, []);
  assert.equal(ff.calls.filter(c => c.api.startsWith("bookmarks.remove")).length, 0);
});

test("reconcile applies a remote change and does not revert a racing local navigation", async () => {
  const ff = createFirefox(localSetup), sync = wire(ff);
  await drain(ff, sync);
  const state = await loadState(ff.browser);
  await ff.browser.tabs.update(4, { url: "https://local-new/" });
  await sync.onMessage({ type: "foxy:reconcile" });
  assert.equal((await ff.browser.tabs.get(4)).url, "https://local-new/");
  await drain(ff, sync);
  assert.equal((await ff.browser.bookmarks.get(state.tabs[4].bookmarkId))[0].url, "https://local-new/");
  await ff.browser.bookmarks.update(state.tabs[5].bookmarkId, { url: "https://remote-new/" });
  assert.deepEqual(await sync.onMessage({ type: "foxy:reconcile" }), { ok: true });
  await drain(ff, sync);
  assert.equal((await ff.browser.tabs.get(5)).url, "https://remote-new/");
});

test("whole-group close and window close keep bookmarks through queued removal drains", async () => {
  const ff = createFirefox(localSetup), sync = wire(ff);
  await drain(ff, sync);
  const before = await ff.browser.bookmarks.getTree();
  await ff.browser.tabs.remove(4);
  await drain(ff, sync);
  assert.deepEqual(await ff.browser.bookmarks.getTree(), before);
  await ff.closeWindow(1);
  await drain(ff, sync);
  assert.deepEqual(await ff.browser.bookmarks.getTree(), before);
});

test("unrelated bookmark changes are ignored; group-folder move out is a removal and move in is saved", async () => {
  const ff = createFirefox(localSetup), sync = wire(ff);
  await drain(ff, sync);
  const before = await loadState(ff.browser);
  const unrelated = await ff.browser.bookmarks.create({ title: "Unrelated" });
  await ff.browser.bookmarks.create({ parentId: unrelated.id, url: "https://unrelated/" });
  await drain(ff, sync);
  assert.deepEqual(await loadState(ff.browser), before);
  await ff.browser.bookmarks.move(before.groups[11].folderId, { parentId: unrelated.id });
  await drain(ff, sync);
  assert.equal((await ff.browser.tabs.get(4)).groupId, -1);
  assert.equal((await loadState(ff.browser)).groups[11], undefined);
  await ff.browser.bookmarks.move(before.groups[11].folderId, { parentId: before.rootId });
  await drain(ff, sync);
  assert.equal((await sync.onMessage({ type: "foxy:saved" })).saved[0].title, "Work");
});

test("deleted pinned folder is reset and recreated on the next wake", async () => {
  const ff = createFirefox(localSetup), sync = wire(ff);
  await drain(ff, sync);
  const before = await loadState(ff.browser);
  await ff.browser.bookmarks.removeTree(before.pinnedId);
  await drain(ff, sync);
  const after = await loadState(ff.browser);
  assert.notEqual(after.pinnedId, before.pinnedId);
  assert.ok(after.pinnedId);
  assert.equal((await ff.browser.bookmarks.getChildren(after.pinnedId)).length, 2);
});

test("a last-focused popup protects the shown tab in the first eligible normal window", async () => {
  const ff = createFirefox({ ...localSetup,
    windows: [{ id: 3, type: "popup", focused: true }, { id: 2, incognito: true }, { id: 1 }],
    tabs: [...localSetup.tabs, { id: 100, windowId: 3, url: "https://popup/", active: true },
      { id: 101, windowId: 2, url: "https://private/", active: true }] });
  const sync = wire(ff);
  await drain(ff, sync);
  await ff.browser.tabs.update(4, { active: true });
  await drain(ff, sync);
  const state = await loadState(ff.browser);
  assert.equal(state.lastFocusedNormalWindowId, 1);
  await ff.browser.bookmarks.update(state.tabs[4].bookmarkId, { url: "https://remote-new/" });
  await drain(ff, sync);
  assert.equal((await ff.browser.tabs.get(4)).url, "https://work/");
  assert.deepEqual(ff.errors, []);
});

test("external app focus does not release shown-tab deferrals; a real activation does", async () => {
  const ff = createFirefox(localSetup), sync = wire(ff);
  await drain(ff, sync);
  await ff.browser.tabs.update(4, { active: true });
  await drain(ff, sync);
  const state = await loadState(ff.browser);
  await ff.browser.bookmarks.update(state.tabs[4].bookmarkId, { url: "https://remote-new/" });
  await drain(ff, sync);
  assert.equal((await ff.browser.tabs.get(4)).url, "https://work/");
  const actualLastFocused = ff.browser.windows.getLastFocused;
  ff.browser.windows.getLastFocused = async props => ({ ...await actualLastFocused(props), focused: false });
  ff.fire("windows.onFocusChanged", ff.browser.windows.WINDOW_ID_NONE);
  await drain(ff, sync);
  // Even an explicit reconcile while another app has focus must protect the shown tab.
  await sync.onMessage({ type: "foxy:reconcile" });
  assert.equal((await ff.browser.tabs.get(4)).url, "https://work/");
  await ff.browser.tabs.update(1, { active: true });
  await drain(ff, sync);
  assert.equal((await ff.browser.tabs.get(4)).url, "https://remote-new/");
});

test("a background wake retains and releases stored deferrals without rematching by URL", async () => {
  const ff = createFirefox(localSetup), sync = wire(ff);
  await drain(ff, sync);
  await ff.browser.tabs.update(4, { active: true });
  await drain(ff, sync);
  const state = await loadState(ff.browser);
  await ff.browser.bookmarks.update(state.tabs[4].bookmarkId, { url: "https://deferred/" });
  await drain(ff, sync);
  const waking = wire(ff);
  await waking.start();
  assert.equal((await ff.browser.tabs.get(4)).url, "https://work/");
  await ff.browser.tabs.update(1, { active: true });
  await drain(ff, waking);
  assert.equal((await ff.browser.tabs.get(4)).url, "https://deferred/");
});

test("unknown messages are ignored and existing trusted blank-and-close messages still work", async () => {
  const ff = createFirefox({ selfTabId: 1, tabs: [
    { id: 1, windowId: 1, url: "moz-extension://foxy-test/newtab.html", active: true },
    { id: 2, windowId: 1, url: "https://keep/" },
  ] });
  const sync = wire(ff);
  await drain(ff, sync);
  assert.equal(await sync.onMessage({ type: "unknown" }), undefined);
  ff.browser.tabs.onUpdated.addListener((id, changes, tab) => {
    if (changes.url === "about:blank") ff.fire("tabs.onUpdated", id, { status: "complete" }, tab);
  });
  const response = sync.onMessage({ type: "blank-and-close" }, { id: ff.browser.runtime.id, tab: { id: 1 } });
  await drain(ff, sync);
  await response;
  await drain(ff, sync);
  assert.deepEqual((await ff.browser.tabs.query({})).map(t => t.id), [2]);
  assert.equal(ff.calls.some(c => c.api === "tabs.update" && c.args[1].loadReplace === true), true);
});

// Catch a moved-out folder becoming a navigation source during a safety deferral.
test("a shown group's moved-out folder stays removed across reconciles and releases only after activation", async () => {
  const ff = createFirefox(localSetup), sync = wire(ff);
  await drain(ff, sync);
  await ff.browser.tabs.update(4, { active: true });
  await drain(ff, sync);
  const before = await loadState(ff.browser);
  const folderId = before.groups[11].folderId;
  const outside = await ff.browser.bookmarks.create({ title: "Outside" });
  await ff.browser.bookmarks.move(folderId, { parentId: outside.id });
  await drain(ff, sync);
  assert.equal((await ff.browser.tabs.get(4)).groupId, 11);
  await ff.browser.bookmarks.update(before.tabs[4].bookmarkId, { url: "https://outside/" });
  await ff.browser.bookmarks.create({ parentId: folderId, url: "https://outside-extra/" });
  await sync.onMessage({ type: "foxy:reconcile" });
  assert.equal((await ff.browser.tabs.query({})).some(tab => tab.url === "https://outside-extra/"), false);
  await ff.browser.tabs.update(1, { active: true });
  await drain(ff, sync);
  const after = await loadState(ff.browser);
  assert.equal((await ff.browser.tabs.get(4)).groupId, -1);
  assert.equal((await ff.browser.tabs.get(4)).url, "https://work/");
  assert.equal(after.groups[11], undefined);
  assert.equal(after.tabs[4], undefined);
  assert.equal((await ff.browser.bookmarks.get(folderId))[0].parentId, outside.id);
});

test("malformed message types are ignored rather than escaping a listener", async () => {
  const ff = createFirefox({ tabs: [{ id: 1, windowId: 1, url: "about:home" }] }), sync = wire(ff);
  for (const message of [null, {}, { type: 42 }, { type: {} }, { type: "foxy:unknown" }]) {
    assert.equal(await sync.onMessage(message), undefined);
  }
  await drain(ff, sync);
});

test("background registers every wake listener at module evaluation and routes saved messages", async t => {
  const { ff, sync } = await savedSetup();
  unwire(ff);
  const previous = globalThis.browser;
  t.after(() => { globalThis.browser = previous; });
  globalThis.browser = ff.browser;
  const registered = [], filters = [];
  for (const [namespace, names] of Object.entries({
    runtime: ["onStartup", "onInstalled", "onMessage"],
    tabs: ["onCreated", "onUpdated", "onRemoved", "onMoved", "onAttached", "onDetached", "onActivated"],
    tabGroups: ["onCreated", "onUpdated", "onRemoved", "onMoved"],
    bookmarks: ["onCreated", "onChanged", "onMoved", "onRemoved"],
    windows: ["onFocusChanged"],
  })) for (const name of names) {
    const source = ff.browser[namespace][name], add = source.addListener;
    source.addListener = (listener, filter) => {
      registered.push(`${namespace}.${name}`);
      if (namespace === "tabs" && name === "onUpdated") filters.push(filter);
      add(listener, filter);
    };
  }
  await import(`../extension/background.js?task5=${Date.now()}`);
  assert.deepEqual(registered.sort(), [
    "runtime.onStartup", "runtime.onInstalled", "runtime.onMessage",
    "tabs.onCreated", "tabs.onUpdated", "tabs.onRemoved", "tabs.onMoved", "tabs.onAttached", "tabs.onDetached", "tabs.onActivated",
    "tabGroups.onCreated", "tabGroups.onUpdated", "tabGroups.onRemoved", "tabGroups.onMoved",
    "bookmarks.onCreated", "bookmarks.onChanged", "bookmarks.onMoved", "bookmarks.onRemoved", "windows.onFocusChanged",
  ].sort());
  assert.deepEqual(filters, [{ properties: ["url", "title", "pinned", "groupId", "status"] }]);
  const saved = await ff.browser.runtime.sendMessage({ type: "foxy:saved" });
  assert.equal(saved.saved.length, 2);
  const opened = await ff.browser.runtime.sendMessage({ type: "foxy:open-saved", folderId: saved.saved[1].folderId, windowId: 1 });
  assert.equal(opened.ok, true);
  await ff.settle();
  await ff.browser.runtime.sendMessage({ type: "foxy:reconcile" });
  const state = await loadState(ff.browser);
  const tabId = Number(Object.keys(state.tabs).find(id => state.tabs[id].folderId === saved.saved[1].folderId));
  await ff.browser.bookmarks.update(state.tabs[tabId].bookmarkId, { url: "https://background-remote/" });
  await ff.settle();
  // A read-only page message is a queue barrier, not a substitute for reconcile routing.
  await ff.browser.runtime.sendMessage({ type: "foxy:saved" });
  assert.equal((await ff.browser.tabs.get(tabId)).url, "https://background-remote/");
  assert.equal(await ff.browser.runtime.sendMessage({ type: 42 }), undefined);
  await ff.settle();
  assert.deepEqual(ff.errors, []);
  await sync.idle();
});

test("restore-all retains missing folders with no openable bookmarks, without deleting them", async () => {
  const { ff, sync } = await missingSetup();
  const before = await sync.onMessage({ type: "foxy:saved" });
  const folderId = before.missing[1].folderId;
  const [bookmark] = await ff.browser.bookmarks.getChildren(folderId);
  await ff.browser.bookmarks.update(bookmark.id, { url: "file:///cannot-reopen" });
  await drain(ff, sync);
  assert.deepEqual(await sync.onMessage({ type: "foxy:restore-all", windowId: 1 }), { ok: false });
  await drain(ff, sync);
  const after = await sync.onMessage({ type: "foxy:saved" });
  assert.deepEqual(after.missing, [before.missing[1]]);
  assert.equal(after.saved[0].folderId, folderId);
  assert.deepEqual(after.saved[0].cantReopen, ["file:///cannot-reopen"]);
  assert.equal((await ff.browser.bookmarks.getChildren(folderId)).length, 1);
});

test("delete-saved cleans a durable pending removal even before its deadline", async () => {
  const { ff, folders } = await savedSetup();
  const state = await loadState(ff.browser), folderId = folders[1].id;
  const [bookmark] = await ff.browser.bookmarks.getChildren(folderId);
  state.tabs[999] = { bookmarkId: bookmark.id, folderId, url: bookmark.url, title: bookmark.title };
  state.pendingRemovals[999] = { bookmarkId: bookmark.id, folderId, due: Date.now() + 999999 };
  state.quietUntil[999] = Date.now() + 999999;
  await saveState(ff.browser, state);
  const sync = wire(ff);
  await sync.start();
  assert.deepEqual(await sync.onMessage({ type: "foxy:delete-saved", folderId }), { ok: true });
  const after = await loadState(ff.browser);
  assert.equal(after.tabs[999], undefined);
  assert.equal(after.quietUntil[999], undefined);
  assert.equal(after.pendingRemovals[999], undefined);
});

test("a removal timer drains through the queue without another background event", async () => {
  const ff = createFirefox(localSetup), sync = wire(ff, { removeDelayMs: 5 });
  await drain(ff, sync);
  const state = await loadState(ff.browser);
  await ff.browser.tabs.remove(2);
  await ff.settle();
  await sync.idle();
  await new Promise(resolve => setTimeout(resolve, 15));
  await sync.idle();
  await assert.rejects(ff.browser.bookmarks.get(state.tabs[2].bookmarkId));
  assert.equal((await loadState(ff.browser)).pendingRemovals[2], undefined);
  await drain(ff, sync);
});

test("focusing another Firefox window releases a shown tab's deferred navigation", async () => {
  const ff = createFirefox({ ...localSetup, windows: [{ id: 1, focused: true }, { id: 2 }],
    tabs: [...localSetup.tabs, { id: 8, windowId: 2, url: "about:home", active: true }] });
  const sync = wire(ff);
  await drain(ff, sync);
  await ff.browser.tabs.update(4, { active: true });
  await drain(ff, sync);
  const state = await loadState(ff.browser);
  await ff.browser.bookmarks.update(state.tabs[4].bookmarkId, { url: "https://other-window/" });
  await drain(ff, sync);
  assert.equal((await ff.browser.tabs.get(4)).url, "https://work/");
  await ff.browser.windows.update(2, { focused: true });
  await drain(ff, sync);
  assert.equal((await ff.browser.tabs.get(4)).url, "https://other-window/");
});

test("outbound does not write to a moved-out folder while its shown tab waits to be ungrouped", async () => {
  const ff = createFirefox(localSetup), sync = wire(ff);
  await drain(ff, sync);
  await ff.browser.tabs.update(4, { active: true });
  await drain(ff, sync);
  const before = await loadState(ff.browser), folderId = before.groups[11].folderId;
  const outside = await ff.browser.bookmarks.create({ title: "Outside" });
  await ff.browser.bookmarks.move(folderId, { parentId: outside.id });
  await drain(ff, sync);
  await ff.browser.tabs.update(4, { url: "https://local-after-removal/" });
  await ff.browser.tabGroups.update(11, { title: "Changed locally" });
  await drain(ff, sync);
  assert.equal((await ff.browser.bookmarks.get(before.tabs[4].bookmarkId))[0].url, "https://work/");
  assert.equal((await ff.browser.bookmarks.get(folderId))[0].title, "🔴 Work");
  await ff.browser.tabs.update(1, { active: true });
  await drain(ff, sync);
  assert.equal((await ff.browser.tabs.get(4)).groupId, -1);
  assert.equal((await ff.browser.tabs.get(4)).url, "https://local-after-removal/");
});

test("background falls back to unfiltered updates when the properties filter is unavailable", async t => {
  const { ff } = await savedSetup(); unwire(ff);
  const previous = globalThis.browser;
  t.after(() => { globalThis.browser = previous; });
  globalThis.browser = ff.browser;
  const source = ff.browser.tabs.onUpdated, add = source.addListener, filters = [];
  source.addListener = (listener, filter) => {
    filters.push(filter);
    if (filter) throw new Error("filter unavailable");
    add(listener);
  };
  const warn = t.mock.method(console, "warn", () => {});
  await import(`../extension/background.js?filter-fallback=${Date.now()}`);
  assert.deepEqual(filters, [{ properties: ["url", "title", "pinned", "groupId", "status"] }, undefined]);
  assert.ok(warn.mock.calls.every(call => call.arguments[0].startsWith("Foxy:")));
  const saved = await ff.browser.runtime.sendMessage({ type: "foxy:saved" });
  assert.equal(saved.saved.length, 2);
  const opened = await ff.browser.runtime.sendMessage({ type: "foxy:open-saved", folderId: saved.saved[0].folderId });
  await ff.settle();
  const tab = (await ff.browser.tabs.query({ groupId: opened.groupId }))[0];
  await ff.browser.tabs.update(tab.id, { pinned: true }); await ff.settle();
  await ff.browser.runtime.sendMessage({ type: "foxy:saved" });
  const state = await loadState(ff.browser);
  assert.equal((await ff.browser.bookmarks.get(state.tabs[tab.id].bookmarkId))[0].parentId, state.pinnedId);
  assert.deepEqual(ff.errors, []);
});
