import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { wire, unwire, drain, localSetup, sharedTree, mutations } from "./fakes/sync.js";
import { loadState, saveState } from "../extension/src/sync/state.js";
import { readTree } from "../extension/src/sync/tree.js";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const home = localSetup.tabs[0];
async function returning(ff, urls, title = "  Work  ", color = "red") {
  const tabs = [];
  for (const url of urls) tabs.push(await ff.browser.tabs.create({ windowId: 1, url, active: false }));
  const groupId = await ff.browser.tabs.group({ tabIds: tabs.map(tab => tab.id) });
  await ff.browser.tabGroups.update(groupId, { title, color });
  return { groupId, tabs };
}
async function stable(ff, sync) {
  const count = mutations(ff).length;
  await sync.onMessage({ type: "foxy:reconcile" });
  await drain(ff, sync);
  assert.equal(mutations(ff).length, count, "second round must not write or move tabs");
}
for (const [name, urls, title, color, reuse] of [
  ["exact URL set", ["https://work/"], "  Work  ", "red", true],
  ["exact two-tab URL set", ["https://work/", "https://extra/"], "  Work  ", "red", true],
  ["different URL set", ["https://other/"], "Work", "red", false],
  ["strict subset", ["https://work/"], "Work", "red", false],
  ["strict superset", ["https://work/", "https://other/"], "Work", "red", false],
  ["different name", ["https://work/"], "Different", "red", false],
  ["different colour", ["https://work/"], "Work", "blue", false],
]) test(`closed saved group reopened with ${name} ${reuse ? "reuses" : "does not reuse"} its folder`, async () => {
  const tabs = [home, localSetup.tabs[3]];
  if (name === "strict subset" || name === "exact two-tab URL set") tabs.push({ id: 6, windowId: 1, groupId: 11, url: "https://extra/" });
  const ff = createFirefox({ groups: [localSetup.groups[0]], tabs }), sync = wire(ff);
  await drain(ff, sync);
  const before = await loadState(ff.browser), oldTree = await ff.browser.bookmarks.getTree();
  await ff.browser.tabs.remove(tabs.filter(t => t.groupId === 11).map(t => t.id));
  await drain(ff, sync);
  const result = await returning(ff, urls, title, color);
  await drain(ff, sync);
  await delay(5);
  await drain(ff, sync);
  const after = await loadState(ff.browser), tree = await readTree(ff.browser, after.rootId);
  assert.equal(after.groups[result.groupId].folderId === before.groups[11].folderId, reuse);
  assert.equal(tree.folders.length, reuse ? 1 : 2);
  assert.deepEqual((await ff.browser.tabs.query({ groupId: result.groupId })).map(t => t.url), urls);
  if (reuse) assert.deepEqual(await ff.browser.bookmarks.getTree(), oldTree);
  await stable(ff, sync);
});

for (const [name, original, reopened, reuse] of [
  ["different duplicate counts", ["https://work/", "https://work/", "https://extra/"], ["https://work/", "https://extra/", "https://extra/"], false],
  ["missing duplicate", ["https://work/", "https://work/"], ["https://work/"], false],
  ["same counts in different order", ["https://work/", "https://work/", "https://extra/"], ["https://extra/", "https://work/", "https://work/"], true],
]) test(`closed saved URL multiset with ${name} ${reuse ? "reuses" : "does not reuse"} its folder`, async () => {
  const ff = createFirefox({ groups: [localSetup.groups[0]], tabs: [home,
    ...original.map((url, i) => ({ id: i + 2, windowId: 1, groupId: 11, url }))] });
  const sync = wire(ff); await drain(ff, sync);
  const before = await loadState(ff.browser);
  await ff.browser.tabs.remove(original.map((_, i) => i + 2)); await drain(ff, sync);
  const result = await returning(ff, reopened); await drain(ff, sync); await delay(5); await drain(ff, sync);
  const after = await loadState(ff.browser);
  assert.equal(after.groups[result.groupId].folderId === before.groups[11].folderId, reuse);
  assert.equal((await readTree(ff.browser, after.rootId)).folders.length, reuse ? 1 : 2);
  assert.deepEqual((await ff.browser.tabs.query({ groupId: result.groupId })).map(t => t.url), reopened);
  await stable(ff, sync);
});

test("returning missing group waits for quiet and rematches late tabs without duplicates", async () => {
  const ff = createFirefox({ groups: [localSetup.groups[0]], tabs: [home, localSetup.tabs[3],
    { id: 6, windowId: 1, groupId: 11, url: "https://extra/" }] });
  let sync = wire(ff, { quietMs: 40 });
  await drain(ff, sync);
  const before = await loadState(ff.browser), tree = await ff.browser.bookmarks.getTree();
  ff.restart(); sync = wire(ff, { quietMs: 40 });
  await drain(ff, sync);
  const result = await returning(ff, ["https://work/"]);
  await drain(ff, sync); // First tab's events drain before the second restore tab arrives.
  assert.deepEqual((await ff.browser.tabs.query({ groupId: result.groupId })).map(t => t.url), ["https://work/"], "do not open missing tabs before quiet");
  const extra = await ff.browser.tabs.create({ windowId: 1, url: "https://extra/", active: false });
  await ff.browser.tabs.group({ groupId: result.groupId, tabIds: [extra.id] });
  await drain(ff, sync);
  await delay(60); await drain(ff, sync);
  const after = await loadState(ff.browser);
  assert.equal(after.groups[result.groupId].folderId, before.groups[11].folderId);
  assert.equal(after.tabs[extra.id].bookmarkId, before.tabs[6].bookmarkId);
  assert.deepEqual((await ff.browser.tabs.query({ groupId: result.groupId })).map(t => t.url), ["https://work/", "https://extra/"]);
  assert.deepEqual(await ff.browser.bookmarks.getTree(), tree);
  await stable(ff, sync);
});

test("return quiet deadline ignores continuous title updates and persists a bind-time cap", async () => {
  const ff = createFirefox({ groups: [localSetup.groups[0]], tabs: [home, localSetup.tabs[3],
    { id: 6, windowId: 1, groupId: 11, url: "https://extra/" }] });
  const options = { quietMs: 25, maxWaitMs: 70 };
  let sync = wire(ff, options);
  await drain(ff, sync); ff.restart(); sync = wire(ff, options); await drain(ff, sync);
  const result = await returning(ff, ["https://work/"]); await drain(ff, sync);
  const bound = (await loadState(ff.browser)).groups[result.groupId];
  const initialDeadline = bound.rebindUntil;
  for (let n = 0; n < 12; n++) {
    await delay(8);
    ff.fire("tabs.onUpdated", result.tabs[0].id, { title: `tick ${n}` }, await ff.browser.tabs.get(result.tabs[0].id));
    await drain(ff, sync);
    const entry = (await loadState(ff.browser)).groups[result.groupId];
    if (Number.isFinite(entry.rebindUntil)) assert.equal(entry.rebindUntil, initialDeadline, "title updates are not membership changes");
  }
  assert.ok(Number.isFinite(bound.rebindMaxUntil), "bind-time cap is durable");
  assert.ok(initialDeadline <= bound.rebindMaxUntil);
  assert.deepEqual((await ff.browser.tabs.query({ groupId: result.groupId })).map(t => t.url), ["https://work/", "https://extra/"]);
  assert.equal((await loadState(ff.browser)).groups[result.groupId].rebindUntil, undefined);
  await stable(ff, sync);
});

test("late membership extends return quiet only up to the original cap", async t => {
  let clock = 1000;
  const ff = createFirefox({ groups: [localSetup.groups[0]], tabs: [home, localSetup.tabs[3],
    { id: 6, windowId: 1, groupId: 11, url: "https://extra/" }] });
  const options = { quietMs: 20, maxWaitMs: 60, now: () => clock };
  let sync = wire(ff, options);
  t.after(async () => { clock = 99999; await delay(30); await drain(ff, sync); });
  await drain(ff, sync); ff.restart(); sync = wire(ff, options); await drain(ff, sync);
  const result = await returning(ff, ["https://work/"]); await drain(ff, sync);
  for (const [at, url, deadline] of [[1015, "https://extra/", 1035], [1045, "https://new/", 1060]]) {
    clock = at;
    const tab = await ff.browser.tabs.create({ windowId: 1, url, active: false });
    await ff.browser.tabs.group({ groupId: result.groupId, tabIds: [tab.id] }); await drain(ff, sync);
    const entry = (await loadState(ff.browser)).groups[result.groupId];
    assert.equal(entry.rebindUntil, deadline);
    assert.equal(entry.rebindMaxUntil, 1060);
  }
  clock = 1060; await delay(25); await drain(ff, sync);
  assert.equal((await loadState(ff.browser)).groups[result.groupId].rebindUntil, undefined);
  await stable(ff, sync);
});

test("title updates of an already-seen unmapped return tab do not extend quiet", async t => {
  let clock = 1000;
  const ff = createFirefox({ groups: [localSetup.groups[0]], tabs: [home, localSetup.tabs[3],
    { id: 6, windowId: 1, groupId: 11, url: "https://extra/" }] });
  const options = { quietMs: 30, maxWaitMs: 60, now: () => clock };
  let sync = wire(ff, options);
  t.after(async () => { clock = 99999; await delay(40); await drain(ff, sync); });
  await drain(ff, sync); ff.restart(); sync = wire(ff, options); await drain(ff, sync);
  const result = await returning(ff, ["https://work/"]); await drain(ff, sync);
  const create = ff.browser.bookmarks.create;
  t.mock.method(console, "warn", () => {});
  t.mock.method(ff.browser.bookmarks, "create", props => {
    if (props.url === "https://failed/") throw new Error("create failed");
    return create(props);
  });
  clock = 1010;
  const tab = await ff.browser.tabs.create({ windowId: 1, url: "https://failed/", active: false });
  await ff.browser.tabs.group({ groupId: result.groupId, tabIds: [tab.id] }); await drain(ff, sync);
  assert.equal((await loadState(ff.browser)).groups[result.groupId].rebindUntil, 1040);
  clock = 1020;
  ff.fire("tabs.onUpdated", tab.id, { title: "tick" }, await ff.browser.tabs.get(tab.id)); await drain(ff, sync);
  assert.equal((await loadState(ff.browser)).groups[result.groupId].rebindUntil, 1040, "only the new member, not its title events, extends quiet");
});

for (const source of ["remote move", "deferred retry", "shown remote move"]) test(`return quiet preserves ${source} and applies bookmark order before publishing tabs`, async () => {
  const ff = createFirefox({ groups: [localSetup.groups[0]], tabs: [home, localSetup.tabs[3],
    { id: 6, windowId: 1, groupId: 11, url: "https://extra/" }] });
  let sync = wire(ff, { quietMs: 30, maxWaitMs: 80 });
  await drain(ff, sync); ff.restart(); sync = wire(ff, { quietMs: 30, maxWaitMs: 80 }); await drain(ff, sync);
  if (source === "deferred retry") {
    const saved = await loadState(ff.browser), folderId = saved.missing[0];
    unwire(ff);
    saved.deferred = [folderId]; await saveState(ff.browser, saved);
    sync = wire(ff, { quietMs: 30, maxWaitMs: 80 }); await drain(ff, sync);
  }
  const result = await returning(ff, ["https://work/", "https://extra/"]); await drain(ff, sync);
  const state = await loadState(ff.browser), folderId = state.groups[result.groupId].folderId;
  if (source === "shown remote move") {
    await ff.browser.tabs.update(result.tabs[0].id, { active: true }); await drain(ff, sync);
  }
  if (source === "deferred retry") {
    unwire(ff);
    await ff.browser.bookmarks.move(state.tabs[result.tabs[1].id].bookmarkId, { index: 0 });
    await ff.settle();
    await sync.handlers["tabs.onActivated"]({ tabId: 1, windowId: 1 });
  } else {
    await ff.browser.bookmarks.move(state.tabs[result.tabs[1].id].bookmarkId, { index: 0 });
    await drain(ff, sync);
  }
  const pendingOrder = (await loadState(ff.browser)).groups[result.groupId].pendingOrder;
  await delay(45); await drain(ff, sync);
  const bookmarkUrls = () => ff.browser.bookmarks.getChildren(folderId).then(nodes => nodes.map(n => n.url));
  assert.deepEqual(await bookmarkUrls(), ["https://extra/", "https://work/"], "outbound must not revert remote order");
  assert.equal(pendingOrder, true, "suppressed order is durable");
  if (source === "shown remote move") {
    assert.deepEqual((await ff.browser.tabs.query({ groupId: result.groupId })).map(t => t.url), ["https://work/", "https://extra/"]);
    assert.ok((await loadState(ff.browser)).deferred.includes(folderId));
    await ff.browser.tabs.update((await ff.browser.tabs.query({})).find(t => t.url === "about:home").id, { active: true }); await drain(ff, sync);
  }
  assert.deepEqual((await ff.browser.tabs.query({ groupId: result.groupId })).map(t => t.url), ["https://extra/", "https://work/"]);
  await stable(ff, sync);
});

test("mapped tab joining an unsyncable-only new group removes its old bookmark", async () => {
  const ff = createFirefox({ groups: [localSetup.groups[0]], tabs: [home, localSetup.tabs[3],
    { id: 6, windowId: 1, groupId: 11, url: "https://keep/" }] }), sync = wire(ff);
  await drain(ff, sync);
  const before = await loadState(ff.browser);
  const blank = await ff.browser.tabs.create({ windowId: 1, url: "about:blank", active: false });
  const newGroup = await ff.browser.tabs.group({ tabIds: [blank.id] });
  await ff.browser.tabs.update(4, { url: "about:blank" });
  await ff.browser.tabs.group({ groupId: newGroup, tabIds: [4] });
  await drain(ff, sync); await delay(5); await drain(ff, sync);
  assert.deepEqual((await ff.browser.bookmarks.getChildren(before.groups[11].folderId)).map(b => b.url), ["https://keep/"]);
  const after = await loadState(ff.browser);
  assert.equal(after.tabs[4], undefined);
  assert.equal(after.groups[newGroup], undefined, "don't create a folder without syncable tabs");
  await stable(ff, sync);
});

test("open-saved falls back from a closed window id", async () => {
  const ff = createFirefox({ bookmarks: sharedTree, tabs: [home], windows: [{ id: 1, focused: true }, { id: 2 }] }), sync = wire(ff);
  await drain(ff, sync); await ff.closeWindow(2); await drain(ff, sync);
  const folder = (await sync.onMessage({ type: "foxy:saved" })).saved[0];
  const result = await sync.onMessage({ type: "foxy:open-saved", folderId: folder.folderId, windowId: 2 });
  assert.equal(result.ok, true);
  assert.equal((await ff.browser.tabGroups.get(result.groupId)).windowId, 1);
  await drain(ff, sync); await stable(ff, sync);
});

test("syncGroup catches and logs a disappearing window and keeps draining", async t => {
  const ff = createFirefox(localSetup), sync = wire(ff);
  await drain(ff, sync);
  const get = ff.browser.windows.get;
  t.mock.method(ff.browser.windows, "get", async () => { throw new Error("window disappeared"); });
  const warn = t.mock.method(console, "warn", () => {});
  await assert.doesNotReject(sync.handlers["tabGroups.onUpdated"](await ff.browser.tabGroups.get(11)));
  assert.ok(warn.mock.calls.some(c => /^Foxy:/.test(c.arguments[0]) && c.arguments[1]?.message === "window disappeared"));
  ff.browser.windows.get = get;
  assert.equal((await sync.onMessage({ type: "foxy:saved" })).saved.length, 0);
  await stable(ff, sync);
});

for (const focus of ["private", "none"]) for (const action of ["navigate", "close", "move"]) test(`${action} protects last focused normal shown tab while ${focus} is focused, including event-page wake`, async t => {
  t.mock.method(console, "warn", () => {}); // Missing GUID is expected after remote removal.
  const ff = createFirefox({ windows: [{ id: 1, focused: true }, { id: 2 }, { id: 3, incognito: true }],
    groups: [{ id: 11, windowId: 2, title: "Work", color: "red" }],
    tabs: [home, { id: 2, windowId: 2, groupId: 11, url: "https://work/", active: true },
      { id: 4, windowId: 2, groupId: 11, url: "https://other/" },
      { id: 5, windowId: 2, url: "about:home" }, { id: 3, windowId: 3, url: "https://private/", active: true }] });
  let sync = wire(ff);
  await drain(ff, sync);
  await ff.browser.windows.update(2, { focused: true }); await drain(ff, sync);
  await ff.browser.windows.update(3, { focused: true }); await drain(ff, sync);
  if (focus === "none") { ff.fire("windows.onFocusChanged", -1); await drain(ff, sync); }
  sync = wire(ff); await drain(ff, sync); // Focus fallback must survive suspension.
  const state = await loadState(ff.browser), bid = state.tabs[2].bookmarkId;
  if (action === "navigate") await ff.browser.bookmarks.update(bid, { url: "https://remote/" });
  if (action === "close") await ff.browser.bookmarks.remove(bid);
  if (action === "move") await ff.browser.bookmarks.move(state.tabs[4].bookmarkId, { index: 0 });
  await drain(ff, sync);
  assert.equal((await ff.browser.tabs.get(2)).url, "https://work/");
  assert.deepEqual((await ff.browser.tabs.query({ groupId: 11 })).map(t => t.id), [2, 4], "no indirect move of the shown tab");
  assert.ok((await loadState(ff.browser)).deferred.includes(state.groups[11].folderId));
  await ff.browser.tabs.update(5, { active: true }); await drain(ff, sync);
  if (action === "navigate") assert.equal((await ff.browser.tabs.get(2)).url, "https://remote/");
  if (action === "close") await assert.rejects(ff.browser.tabs.get(2));
  if (action === "move") assert.deepEqual((await ff.browser.tabs.query({ groupId: 11 })).map(t => t.id), [4, 2]);
  await stable(ff, sync);
});


test("new browser session clears old normal focus before shown-tab decisions", async () => {
  const ff = createFirefox({ windows: [{ id: 1, focused: true }, { id: 2 }, { id: 3, incognito: true }],
    groups: [localSetup.groups[0]], tabs: [{ ...localSetup.tabs[3], active: true }, home,
      { id: 2, windowId: 2, url: "about:home", active: true },
      { id: 3, windowId: 3, url: "https://private/", active: true }] });
  let sync = wire(ff); await drain(ff, sync);
  await ff.browser.windows.update(2, { focused: true }); await drain(ff, sync);
  await ff.browser.windows.update(3, { focused: true }); await drain(ff, sync);
  assert.equal((await loadState(ff.browser)).lastFocusedNormalWindowId, 2);
  // Start a new session with the same numeric IDs and no observed normal focus.
  // Retain the strip to exercise a real rebuild, not merely a state-field check.
  await ff.browser.storage.session.clear(); await drain(ff, sync);
  sync = wire(ff); await drain(ff, sync);
  const state = await loadState(ff.browser);
  await ff.browser.bookmarks.update(state.tabs[4].bookmarkId, { url: "https://remote/" }); await drain(ff, sync);
  assert.equal((await ff.browser.tabs.get(4)).url, "https://work/", "fallback normal window's shown tab is protected");
  assert.equal((await loadState(ff.browser)).lastFocusedNormalWindowId, 1);
  assert.ok((await loadState(ff.browser)).deferred.includes(state.groups[11].folderId));
  await ff.browser.tabs.update(1, { active: true }); await drain(ff, sync);
  assert.equal((await ff.browser.tabs.get(4)).url, "https://remote/");
  await stable(ff, sync);
});

test("persisted return quiet deadline opens only still-unmatched bookmarks after wake", async () => {
  const ff = createFirefox({ groups: [localSetup.groups[0]], tabs: [home, localSetup.tabs[3]] });
  let sync = wire(ff, { quietMs: 30 });
  await drain(ff, sync);
  const state = await loadState(ff.browser);
  unwire(ff);
  await ff.browser.bookmarks.create({ parentId: state.groups[11].folderId, url: "https://late/" });
  state.groups[11].rebindUntil = Date.now() + 30;
  await saveState(ff.browser, state); await ff.settle();
  sync = wire(ff, { quietMs: 30 }); await drain(ff, sync);
  assert.deepEqual((await ff.browser.tabs.query({ groupId: 11 })).map(t => t.url), ["https://work/"]);
  await delay(50); await drain(ff, sync);
  assert.deepEqual((await ff.browser.tabs.query({ groupId: 11 })).map(t => [t.url, t.discarded]), [["https://work/", false], ["https://late/", true]]);
  assert.equal((await loadState(ff.browser)).groups[11].rebindUntil, undefined);
  await stable(ff, sync);
});

for (const destination of ["private", "outside root"]) test(`return quiet completion does not write after group moves ${destination}`, async t => {
  t.mock.method(console, "warn", () => {});
  const ff = createFirefox({ groups: [localSetup.groups[0]], tabs: [home, localSetup.tabs[3],
    { id: 6, windowId: 1, groupId: 11, url: "https://extra/" }] });
  let sync = wire(ff, { quietMs: 40 });
  await drain(ff, sync); ff.restart(); sync = wire(ff, { quietMs: 40 }); await drain(ff, sync);
  const result = await returning(ff, ["https://work/"]); await drain(ff, sync);
  const state = await loadState(ff.browser), folderId = state.groups[result.groupId].folderId;
  if (destination === "private") {
    const win = await ff.browser.windows.create({ incognito: true, focused: false });
    await ff.browser.tabGroups.move(result.groupId, { windowId: win.id, index: -1 });
  } else {
    await ff.browser.tabs.update(result.tabs[0].id, { active: true }); await drain(ff, sync);
    const folder = await ff.browser.bookmarks.create({ title: "Outside" });
    await ff.browser.bookmarks.move(folderId, { parentId: folder.id });
  }
  await drain(ff, sync);
  const before = await ff.browser.bookmarks.getTree();
  await ff.browser.tabs.update(result.tabs[0].id, { url: "https://must-stay-local/" });
  await drain(ff, sync); await delay(60); await drain(ff, sync);
  assert.deepEqual(await ff.browser.bookmarks.getTree(), before);
  assert.equal((await ff.browser.tabs.get(result.tabs[0].id)).url, "https://must-stay-local/");
});
