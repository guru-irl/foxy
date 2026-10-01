import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { createSync } from "../extension/src/sync/sync.js";
import { wire, unwire, drain, localSetup, sharedTree } from "./fakes/sync.js";
import { loadState, saveState } from "../extension/src/sync/state.js";
import { settle } from "../extension/src/sync/startup.js";
import { readTree } from "../extension/src/sync/tree.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const closeSetup = { selfTabId: 1, tabs: [
  { id: 1, windowId: 1, url: "moz-extension://foxy-test/newtab.html", active: true },
  { id: 2, windowId: 1, url: "https://keep/" },
] };

for (const route of ["controller", "background"]) test(`close via ${route} blanks before startup settles`, async t => {
  const ff = createFirefox(closeSetup);
  let response, startup;
  if (route === "controller") {
    const sync = createSync({ api: ff.browser, settleMs: 250, maxWaitMs: 500 });
    startup = sync.start();
    response = sync.onMessage({ type: "blank-and-close" }, { id: ff.browser.runtime.id, tab: { id: 1 } });
  } else {
    const previous = globalThis.browser;
    t.after(() => { globalThis.browser = previous; });
    globalThis.browser = ff.browser;
    await import(`../extension/background.js?r1-close=${Date.now()}`);
    response = ff.browser.runtime.sendMessage({ type: "blank-and-close" });
  }
  // Complete the helper without waiting for its fallback timeout, even on RED.
  ff.browser.tabs.onUpdated.addListener((id, changes, tab) => {
    if (changes.url === "about:blank") ff.fire("tabs.onUpdated", id, { status: "complete" }, tab);
  });
  await delay(20);
  const blankedEarly = ff.calls.some(c => c.api === "tabs.update" && c.args[1].loadReplace);
  await startup;
  await ff.settle();
  await response;
  await ff.settle();
  assert.equal(blankedEarly, true, "loadReplace must precede startup settle");
  assert.deepEqual(ff.errors, []);
});

const privateSetup = {
  windows: [{ id: 1 }, { id: 2, focused: true, incognito: true }],
  groups: [{ id: 21, windowId: 2, title: "Private", color: "red" }],
  tabs: [{ id: 1, windowId: 1, url: "about:home", active: true },
    { id: 8, windowId: 2, url: "https://private-pin/", pinned: true },
    { id: 9, windowId: 2, url: "https://private-group/", groupId: 21, active: true }],
};

test("fake private tabs inherit their window's incognito flag", async () => {
  const ff = createFirefox(privateSetup);
  assert.equal((await ff.browser.windows.getLastFocused()).incognito, true);
  assert.equal((await ff.browser.tabs.get(9)).incognito, true);
  assert.equal((await ff.browser.tabs.create({ windowId: 2, url: "https://new/" })).incognito, true);
});

test("fake restart defaults to no restore", async () => {
  const ff = createFirefox(localSetup);
  ff.restart();
  assert.deepEqual((await ff.browser.tabs.query({})).map(t => t.url), ["about:home"]);
  assert.deepEqual(await ff.browser.tabGroups.query({}), []);
});

test("private groups, pins and event updates never write shared bookmarks", async () => {
  const ff = createFirefox({ ...privateSetup, bookmarks: sharedTree }), sync = wire(ff);
  await drain(ff, sync);
  let state = await loadState(ff.browser), tree = await readTree(ff.browser, state.rootId);
  assert.deepEqual(Object.keys(state.groups), []);
  assert.equal(tree.folders.some(f => f.name === "Private"), false);
  assert.equal(tree.pinned.bookmarks.some(b => b.url.includes("private")), false);
  assert.equal(ff.calls.filter(c => c.api === "tabs.create").every(c => c.args[0].windowId === 1), true);
  const before = await ff.browser.bookmarks.getTree();
  await ff.browser.tabs.update(9, { url: "https://changed-private/" });
  await ff.browser.tabGroups.update(21, { title: "Renamed private" });
  await ff.browser.tabs.move(8, { index: 0 });
  ff.fire("tabs.onAttached", 9, { newWindowId: 2, newPosition: 1 });
  const extra = await ff.browser.tabs.create({ windowId: 2, url: "https://new-private/", active: false });
  await ff.browser.tabs.group({ tabIds: [extra.id], createProperties: { windowId: 2 } });
  await drain(ff, sync);
  assert.deepEqual(await ff.browser.bookmarks.getTree(), before);
  await ff.browser.bookmarks.removeTree(state.pinnedId);
  await drain(ff, sync);
  state = await loadState(ff.browser);
  tree = await readTree(ff.browser, state.rootId);
  assert.equal(tree.pinned.bookmarks.some(b => b.url.includes("private")), false, "ensureTree also filters private pins");
});

test("open-saved and restore-all redirect a private destination to a normal window", async () => {
  const ff = createFirefox({ ...privateSetup, bookmarks: sharedTree }), sync = wire(ff);
  await drain(ff, sync);
  const saved = await sync.onMessage({ type: "foxy:saved" });
  const opened = await sync.onMessage({ type: "foxy:open-saved", folderId: saved.saved[0].folderId, windowId: 2 });
  assert.equal(opened.ok, true);
  assert.equal((await ff.browser.tabGroups.get(opened.groupId)).windowId, 1);
  const state = await loadState(ff.browser);
  state.missing = [saved.saved[1].folderId];
  await saveState(ff.browser, state);
  const waking = wire(ff);
  assert.deepEqual(await waking.onMessage({ type: "foxy:restore-all", windowId: 2 }), { ok: true });
  await drain(ff, waking);
  assert.equal((await ff.browser.tabGroups.query({})).filter(g => g.id !== 21).every(g => g.windowId === 1), true);
});

test("private-only windows cannot receive shared pins or saved groups", async () => {
  const ff = createFirefox({ windows: [{ id: 2, incognito: true, focused: true }],
    tabs: [privateSetup.tabs[1]], bookmarks: sharedTree }), sync = wire(ff);
  await drain(ff, sync);
  const saved = await sync.onMessage({ type: "foxy:saved" });
  assert.equal(ff.calls.some(c => c.api === "tabs.create"), false);
  assert.deepEqual(await sync.onMessage({ type: "foxy:open-saved", folderId: saved.saved[0].folderId, windowId: 2 }), { ok: false });
  assert.equal(ff.calls.some(c => c.api === "tabs.create"), false);
});

// Firefox namespace members need not be enumerable and methods need receivers.
function prototypeNamespaces(value) {
  const proto = {}, result = Object.create(proto);
  for (const [name, member] of Object.entries(value)) {
    const wrapped = typeof member === "function" ? function (...args) {
      assert.equal(this, result, `detached API method: ${name}`);
      return member(...args);
    } : member && typeof member === "object" && !member.addListener ? prototypeNamespaces(member) : member;
    Object.defineProperty(proto, name, { get: () => wrapped });
  }
  return result;
}

test("prototype namespace adapters reconcile pins and protect shown tabs", async () => {
  const ff = createFirefox({ ...localSetup, tabs: [localSetup.tabs[0], localSetup.tabs[3], localSetup.tabs[4]], bookmarks: sharedTree });
  ff.browser = prototypeNamespaces(ff.browser);
  const sync = wire(ff);
  await drain(ff, sync);
  const state = await loadState(ff.browser);
  assert.deepEqual((await ff.browser.tabs.query({ pinned: true })).map(t => [t.url, t.discarded]),
    [["https://pin-a/", true], ["https://pin-b/", true]]);
  assert.deepEqual((await ff.browser.tabs.query({ groupId: 11 })).map(t => t.url), ["https://work/", "https://extra/"]);
  await ff.browser.tabs.update(4, { active: true });
  await drain(ff, sync);
  await ff.browser.bookmarks.update(state.tabs[4].bookmarkId, { url: "https://remote/" });
  await drain(ff, sync);
  assert.equal((await ff.browser.tabs.get(4)).url, "https://work/");
  await ff.browser.tabs.update(1, { active: true });
  await drain(ff, sync);
  assert.equal((await ff.browser.tabs.get(4)).url, "https://remote/");
});

test("prototype namespace settle observes events rather than resolving early", async () => {
  const ff = createFirefox();
  ff.browser = prototypeNamespaces(ff.browser);
  let done = false;
  const waiting = settle(ff.browser, { settleMs: 60, maxWaitMs: 500 }).then(() => { done = true; });
  await delay(35);
  ff.fire("tabs.onUpdated", 1, {});
  await ff.settle();
  await delay(35);
  const early = done;
  await waiting;
  assert.equal(early, false);
});

async function returningGroup(ff, url, title = "  Work  ", color = "red") {
  const tab = await ff.browser.tabs.create({ windowId: 1, url, active: false });
  const groupId = await ff.browser.tabs.group({ tabIds: [tab.id], createProperties: { windowId: 1 } });
  await ff.browser.tabGroups.update(groupId, { title, color });
  return { tab, groupId };
}

test("late restored group rebinds its missing folder after startup settle", async () => {
  const ff = createFirefox(localSetup);
  let sync = wire(ff);
  await drain(ff, sync);
  const before = await loadState(ff.browser), tree = await ff.browser.bookmarks.getTree();
  ff.restart();
  sync = wire(ff);
  await drain(ff, sync);
  const returning = await returningGroup(ff, "https://work/");
  await drain(ff, sync);
  const after = await loadState(ff.browser);
  assert.equal(after.groups[returning.groupId].folderId, before.groups[11].folderId);
  assert.equal(after.tabs[returning.tab.id].bookmarkId, before.tabs[4].bookmarkId);
  assert.equal(after.missing.includes(before.groups[11].folderId), false);
  assert.deepEqual(await ff.browser.bookmarks.getTree(), tree);
});

test("history reopened group rebinds an unmapped openFolder without duplicate bookmarks", async () => {
  const ff = createFirefox({ ...localSetup, windows: [{ id: 1, focused: true }, { id: 2 }],
    groups: localSetup.groups.map(g => ({ ...g, windowId: g.id === 11 ? 2 : 1 })),
    tabs: localSetup.tabs.map(t => ({ ...t, windowId: t.id === 4 ? 2 : 1 })) }), sync = wire(ff);
  await drain(ff, sync);
  const before = await loadState(ff.browser), tree = await ff.browser.bookmarks.getTree();
  await ff.closeWindow(2);
  await drain(ff, sync);
  const returning = await returningGroup(ff, "https://work/");
  await drain(ff, sync);
  const after = await loadState(ff.browser);
  assert.equal(after.groups[returning.groupId].folderId, before.groups[11].folderId);
  assert.deepEqual(await ff.browser.bookmarks.getTree(), tree);
});

test("empty returning group waits for a syncable tab and then rebinds", async () => {
  const ff = createFirefox(localSetup);
  let sync = wire(ff);
  await drain(ff, sync);
  const before = await loadState(ff.browser), tree = await ff.browser.bookmarks.getTree();
  ff.restart();
  sync = wire(ff);
  await drain(ff, sync);
  const returning = await returningGroup(ff, "about:blank");
  await drain(ff, sync);
  assert.deepEqual(await ff.browser.bookmarks.getTree(), tree, "no empty duplicate folder");
  await ff.browser.tabs.update(returning.tab.id, { url: "https://work/" });
  await drain(ff, sync);
  assert.equal((await loadState(ff.browser)).groups[returning.groupId].folderId, before.groups[11].folderId);
  assert.deepEqual(await ff.browser.bookmarks.getTree(), tree);
});

test("new same-name group with no shared URL gets its own folder", async () => {
  const ff = createFirefox({ bookmarks: sharedTree, tabs: [localSetup.tabs[0]] }), sync = wire(ff);
  await drain(ff, sync);
  const before = await loadState(ff.browser);
  const tree = await readTree(ff.browser, before.rootId);
  before.missing = [tree.folders[0].id];
  await saveState(ff.browser, before);
  const waking = wire(ff);
  const returning = await returningGroup(ff, "https://unrelated/");
  await drain(ff, waking);
  const after = await readTree(ff.browser, before.rootId);
  assert.equal(after.folders.length, 3);
  assert.notEqual((await loadState(ff.browser)).groups[returning.groupId].folderId, tree.folders[0].id);
  assert.deepEqual(after.folders[2].bookmarks.map(b => b.url), ["https://unrelated/"]);
});

async function missingSetup() {
  const ff = createFirefox(localSetup);
  let sync = wire(ff);
  await drain(ff, sync);
  ff.restart();
  sync = wire(ff);
  await drain(ff, sync);
  return { ff, sync };
}

test("restore-all continues after one folder throws and retains only failed missing folders", async () => {
  const { ff, sync } = await missingSetup();
  const before = await sync.onMessage({ type: "foxy:saved" });
  const create = ff.browser.tabs.create;
  ff.browser.tabs.create = props => {
    if (props.url === "https://work/") throw new Error("injected create failure");
    return create(props);
  };
  assert.deepEqual(await sync.onMessage({ type: "foxy:restore-all", windowId: 1 }), { ok: false });
  await drain(ff, sync);
  const after = await sync.onMessage({ type: "foxy:saved" });
  assert.deepEqual(after.missing, [before.missing[0]]);
  assert.deepEqual((await ff.browser.tabGroups.query({})).map(g => g.title), ["Read"]);
  ff.browser.tabs.create = create;
  assert.deepEqual(await sync.onMessage({ type: "foxy:restore-all", windowId: 1 }), { ok: true });
  assert.deepEqual((await sync.onMessage({ type: "foxy:saved" })).missing, []);
});

test("missing folders survive successive non-restoring restarts until dismissed", async () => {
  const { ff, sync } = await missingSetup();
  const missing = (await sync.onMessage({ type: "foxy:saved" })).missing;
  ff.restart();
  let waking = wire(ff);
  await drain(ff, waking);
  assert.deepEqual((await waking.onMessage({ type: "foxy:saved" })).missing, missing);
  await waking.onMessage({ type: "foxy:dismiss-missing" });
  await drain(ff, waking);
  ff.restart();
  waking = wire(ff);
  await drain(ff, waking);
  assert.deepEqual((await waking.onMessage({ type: "foxy:saved" })).missing, []);
});

test("each controller wake drains removals once, not once per delivered event", async () => {
  const ff = createFirefox(localSetup), sync = wire(ff);
  await drain(ff, sync);
  const state = await loadState(ff.browser), entry = state.tabs[2];
  unwire(ff);
  await ff.browser.tabs.remove(2);
  await ff.settle();
  state.pendingRemovals[2] = { bookmarkId: entry.bookmarkId, folderId: entry.folderId, due: 0 };
  await saveState(ff.browser, state);
  let attempts = 0;
  ff.browser.bookmarks.remove = async () => { attempts++; throw new Error("injected removal failure"); };
  const waking = wire(ff);
  await waking.start();
  await waking.start();
  for (let i = 0; i < 5; i++) ff.fire("tabs.onUpdated", 5, {}, await ff.browser.tabs.get(5));
  await drain(ff, waking);
  assert.equal(attempts, 1);
  const nextWake = wire(ff);
  await nextWake.start();
  assert.equal(attempts, 2, "a new event-page lifetime retries persisted removal once");
});


test("foxy message failures reply ok false and later queue work still runs", async () => {
  const ff = createFirefox({ bookmarks: sharedTree, tabs: [localSetup.tabs[0]] }), sync = wire(ff);
  await drain(ff, sync);
  const saved = await sync.onMessage({ type: "foxy:saved" });
  ff.browser.tabs.create = async () => { throw new Error("injected open failure"); };
  assert.deepEqual(await sync.onMessage({ type: "foxy:open-saved", folderId: saved.saved[0].folderId, windowId: 1 }), { ok: false });
  assert.deepEqual(await sync.onMessage({ type: "foxy:saved" }), saved);
});


test("a mapped group moved into a private window receives no inbound changes", async () => {
  const ff = createFirefox({ ...localSetup, windows: [{ id: 1, focused: true }, { id: 2, incognito: true }],
    tabs: [...localSetup.tabs, { id: 8, windowId: 2, url: "about:home", active: true }] }), sync = wire(ff);
  await drain(ff, sync);
  const state = await loadState(ff.browser);
  await ff.browser.tabGroups.move(11, { windowId: 2, index: -1 });
  await drain(ff, sync);
  await ff.browser.bookmarks.update(state.tabs[4].bookmarkId, { url: "https://remote-private/" });
  await sync.onMessage({ type: "foxy:reconcile" });
  await drain(ff, sync);
  assert.equal((await ff.browser.tabs.get(4)).url, "https://work/");
});


test("closing a formerly mapped tab in a private window cannot delete its shared bookmark", async () => {
  const ff = createFirefox({ ...localSetup, windows: [{ id: 1, focused: true }, { id: 2, incognito: true }],
    tabs: [...localSetup.tabs, { id: 6, windowId: 1, url: "https://work-extra/", groupId: 11 },
      { id: 8, windowId: 2, url: "about:home", active: true }] }), sync = wire(ff);
  await drain(ff, sync);
  const state = await loadState(ff.browser), before = await ff.browser.bookmarks.getTree();
  await ff.browser.tabGroups.move(11, { windowId: 2, index: -1 });
  await drain(ff, sync);
  await ff.browser.tabs.remove(4);
  await ff.settle();
  await delay(10); // Let the zero-delay removal timer run without another wake drain.
  await drain(ff, sync);
  assert.equal((await ff.browser.bookmarks.get(state.tabs[4].bookmarkId))[0].url, "https://work/");
  assert.deepEqual(await ff.browser.bookmarks.getTree(), before);
});
