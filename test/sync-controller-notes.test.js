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
