import { test } from "node:test";
import assert from "node:assert/strict";
import { buildView } from "../extension/src/grid/view.js";
import { loadSettings } from "../extension/src/settings/store.js";
import { loadLayouts } from "../extension/src/grid/store.js";
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

for (const [name, cell, width] of [["grid-custom-80", 1616 / 16 - 16, 1600], ["grid-custom-144", 1616 / 10 - 16, 1600],
  ["grid-narrow", 716 / 7 - 16, 700], ["settings-open", 1616 / 16 - 16, 1600]]) {
  test(`${name} preview supplies saved geometry, settings and mapped group tiles`, async t => {
    const { api, board, reply } = await preview(t, name);
    assert.deepEqual(reply.folders, { 101: "preview-101", 102: "preview-102", 103: "preview-103" });
    assert.equal(board.saved.length, 3);
    const stored = await loadLayouts(api), layout = stored.layouts[9].tiles;
    const settings = await loadSettings(api);
    const view = buildView(board, { layouts: stored.layouts, ...settings, contentWidth: width,
      folders: reply.folders });
    assert.equal(view.cell, cell);
    assert.equal(view.tiles.length, 6);
    assert.equal(view.newTiles.length, 0, "fixture has saved positions for every tile");
    for (const tile of view.tiles) assert.ok(tile.x + tile.w <= view.cols);
    if (name === "grid-narrow") {
      assert.ok(view.tiles.some(tile => tile.y !== layout.find(saved => saved.id === tile.id).y),
        "narrow fixture must exercise display fit");
      assert.deepEqual(await loadLayouts(api), stored, "display fit must not save positions");
    }
  });
}
