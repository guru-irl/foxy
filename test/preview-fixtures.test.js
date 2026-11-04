import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSettings } from "../extension/src/settings/store.js";
import { buildBoard } from "../extension/src/board/model.js";

// fake-browser.js only needs the page URL and the scheme target at import time.
async function preview(t, name) {
  const previous = Object.fromEntries(["location", "document", "browser"].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  globalThis.location = new URL(`file:///preview.html?scenario=${name}`);
  globalThis.document = { documentElement: { dataset: {}, style: {} } };
  await import(`../preview/fake-browser.js?test=${name}`);
  const api = globalThis.browser;
  const reply = await api.runtime.sendMessage({ type: "foxy:saved" });
  assert.ok(reply, "preview must answer foxy:saved without starting bookmark sync");
  const board = buildBoard({
    windows: await api.windows.getAll(), tabs: await api.tabs.query({}),
    groups: await api.tabGroups.query({}), currentWindowId: 1, selfTabId: 999,
    ...reply,
  });
  return { api, board, reply };
}

const saved = [
  { folderId: "saved-reading", title: "READING", color: "blue", count: 4, cantReopen: [] },
  { folderId: "saved-local", title: "LOCAL PAGES", color: "grey", count: 2, cantReopen: ["about:config"] },
  { folderId: "saved-unnamed", title: "", color: "orange", count: 3, cantReopen: [] },
];

test("saved preview keeps the one-window board and adds three saved groups", async t => {
  const { api, board, reply } = await preview(t, "saved");
  assert.deepEqual(reply, { saved, missing: [] });
  assert.deepEqual(board.saved, saved);
  assert.deepEqual(board.columns.map(column => column.id), [101, 102, 103]);
  assert.equal(board.pinned[0].rows.length, 6);
  assert.equal(board.tabs[0].rows.length, 3);
  assert.equal(await api.runtime.sendMessage({ type: "foxy:reconcile" }), undefined);
  assert.deepEqual(await api.bookmarks.getChildren("unfiled_____"), []);
});

test("banner preview exposes two missing groups also present in SAVED", async t => {
  const { board, reply } = await preview(t, "banner");
  assert.deepEqual(reply.saved, saved);
  assert.deepEqual(reply.missing, [
    { folderId: "saved-reading", title: "READING", color: "blue" },
    { folderId: "saved-local", title: "LOCAL PAGES", color: "grey" },
  ]);
  assert.deepEqual(board.missing.map(group => group.folderId), ["saved-reading", "saved-local"]);
});

test("older preview scenarios answer with no saved groups or banner", async t => {
  const { board, reply } = await preview(t, "one-window");
  assert.deepEqual(reply, { saved: [], missing: [] });
  assert.equal(board.columns.length, 3);
});


test('v40 preview uses generic groups with remote groups, every widget and fake memory data',async t=>{
 const {api,board,reply}=await preview(t,'v40');
 assert.deepEqual(board.columns.filter(g=>g.current).map(g=>g.title),['READING','WORK','TRAVEL','RECIPES','RESEARCH','SIDE PROJECT']);
 assert.deepEqual(board.columns.filter(g=>g.current).slice(0,4).map(g=>g.rows[0].title),
   ['Reading list', 'Project notes', 'City guide', 'Dinner ideas']);
 assert.equal(board.columns.filter(g=>!g.current).length,2);assert.equal(board.saved.length,3);
 const settings=await loadSettings(api);assert.equal(settings.synced.otherWindows,true);
 for(const kind of ['Clock','Pinned','Saved','Memory','Weather'])assert.equal(settings.synced[`show${kind}`],true);
 assert.equal(Object.keys(reply.folders).length,8);
 assert.equal(new Set(Object.values(reply.folders)).size, 8, 'groups in different windows need distinct bookmark folders');
 assert.equal((await api.runtime.sendMessage({type:'foxy:memory'})).firefox,3650722202);
});
