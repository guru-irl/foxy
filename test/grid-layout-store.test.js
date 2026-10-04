import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import * as store from "../extension/src/grid/store.js";
const rect = { x: 0, y: 0, w: 6, h: 4 };
const tile = { id: "clock", ...rect };

test("loadLayouts parses width keys, validates metadata and displays legacy without writing", async () => {
  assert.equal(typeof store.loadLayouts, "function");
  const ff = createFirefox();
  await ff.browser.storage.sync.set({ layouts: { 17: 123, 34: 4, bad: 1, 0: 5 },
    "tile:17:pinned": rect, "tile:34:clock": { ...rect, y: 9 }, "tile:clock": rect,
    "tile:34:foreign": rect, "tile:17:saved": { ...rect, x: -1 }, settings: {} });
  ff.calls.length = 0;
  const result = await store.loadLayouts(ff.browser);
  assert.deepEqual(result.layouts, { 6: { lastWriteMs: 0, tiles: [tile] },
    17: { lastWriteMs: 123, tiles: [{ id: "pinned", ...rect }] },
    34: { lastWriteMs: 4, tiles: [{ id: "clock", ...rect, y: 9 }] } });
  assert.equal(result.legacy.k, 6);
  assert.equal(ff.calls.some(c => c.api === "storage.sync.set"), false);
  assert.deepEqual(store.parseTileKey("tile:17:group:a"), { k: 17, id: "group:a" });
});
test("migrateLayouts makes exactly one set then one remove, overwrites, and migrates later legacy arrivals", async () => {
  assert.equal(typeof store.migrateLayouts, "function");
  const ff = createFirefox();
  await ff.browser.storage.sync.set({ "tile:clock": rect, "tile:6:clock": { ...rect, y: 8 }, layouts: { 6: 1, 17: 2 } });
  ff.calls.length = 0;
  await store.migrateLayouts(ff.browser, { now: 10, inUse: 6 });
  assert.deepEqual(ff.calls.filter(c => c.api !== "storage.sync.get"), [
    { api: "storage.sync.set", args: [{ "tile:6:clock": rect, layouts: { 6: 10, 17: 2 } }] },
    { api: "storage.sync.remove", args: [["tile:clock"]] },
  ]);
  await ff.browser.storage.sync.set({ "tile:pinned": { ...rect, x: 6 } });
  await store.migrateLayouts(ff.browser, { now: 11, inUse: 6 });
  assert.deepEqual((await ff.browser.storage.sync.get(null))["tile:12:pinned"], { ...rect, x: 6 });
  assert.equal((await ff.browser.storage.sync.get(null))["tile:pinned"], undefined);
});
test("saveTiles re-reads metadata, timestamps every nonempty write and leaves other layouts unchanged", async () => {
  const ff = createFirefox();
  await ff.browser.storage.sync.set({ layouts: { 34: 5 }, "tile:34:clock": rect });
  ff.calls.length = 0;
  await store.saveTiles(ff.browser, 17, [{ ...tile, y: 2 }], { now: 7, inUse: 34 });
  assert.deepEqual(await ff.browser.storage.sync.get(null), { layouts: { 17: 7, 34: 5 },
    "tile:34:clock": rect, "tile:17:clock": { ...rect, y: 2 } });
  await store.saveTiles(ff.browser, 17, [], { now: 8 });
  assert.equal(ff.calls.filter(c => c.api === "storage.sync.set").length, 1);
});
for (const [inUse, want] of [[10, 20], [40, 10]]) {
  test(`fifth layout removes all keys of oldest non-in-use layout ${want}, ties by width`, async () => {
    const ff = createFirefox();
    await ff.browser.storage.sync.set({ layouts: { 10: 1, 20: 1, 30: 2, 40: 3 },
      ...Object.fromEntries([10, 20, 30, 40].map(k => [`tile:${k}:clock`, rect])),
      [`tile:${want}:group:broken`]: null, settings: {} });
    ff.calls.length = 0;
    await store.saveTiles(ff.browser, 17, [tile], { now: 9, inUse });
    const calls = ff.calls.filter(c => c.api !== "storage.sync.get");
    assert.equal(calls[0].api, "storage.sync.remove");
    assert.deepEqual(calls[0].args[0], [`tile:${want}:clock`, `tile:${want}:group:broken`]);
    const stored = await ff.browser.storage.sync.get(null);
    assert.equal(Object.keys(stored.layouts).length, 4);
    assert.equal(stored.layouts[want], undefined);
    assert.ok(stored[`tile:${inUse}:clock`]);
  });
}
test("deleted saved group is removed from every layout, leaving unrelated keys", async () => {
  assert.equal(typeof store.removeGroupTiles, "function");
  const ff = createFirefox();
  await ff.browser.storage.sync.set({ "tile:17:group:a": rect, "tile:34:group:a": rect,
    "tile:group:a": rect, "tile:34:group:b": rect, layouts: { 17: 1, 34: 2 } });
  await store.removeGroupTiles(ff.browser, "a");
  assert.deepEqual(await ff.browser.storage.sync.get(null), { "tile:34:group:b": rect, layouts: { 17: 1, 34: 2 } });
});
