import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import * as store from "../extension/src/grid/store.js";
const rect = { x: 0, y: 0, w: 6, h: 4 };
const tile = { id: "clock", ...rect };
const entriesFor = times => Object.fromEntries(Object.entries(times).flatMap(([k, t]) =>
  [[`layout:${k}`, { t }], [`tile:${k}:clock`, rect]]));
const widths = entries => Object.keys(entries).filter(key => key.startsWith("layout:")).sort();

test("loadLayouts reads independent metadata, uses zero for missing or invalid times and ignores legacy beside width layouts", async () => {
  const ff = createFirefox();
  await ff.browser.storage.sync.set({ "layout:17": { t: 123 }, "layout:34": { t: -1 }, "layout:0": { t: 5 },
    "layout:bad": { t: 1 }, "tile:17:pinned": rect, "tile:34:clock": { ...rect, y: 9 }, "tile:clock": rect,
    "tile:20:saved": rect, "tile:34:foreign": rect, "tile:17:saved": { ...rect, x: -1 }, settings: {} });
  ff.calls.length = 0;
  assert.deepEqual(await store.loadLayouts(ff.browser), { legacy: null, layouts: {
    17: { lastWriteMs: 123, tiles: [{ id: "pinned", ...rect }] },
    20: { lastWriteMs: 0, tiles: [{ id: "saved", ...rect }] },
    34: { lastWriteMs: 0, tiles: [{ id: "clock", ...rect, y: 9 }] },
  } });
  assert.equal(ff.calls.some(c => c.api === "storage.sync.set"), false);
  assert.deepEqual(store.parseTileKey("tile:17:group:a"), { k: 17, id: "group:a" });
});
test("legacy-only load displays without writing; migration copies once and retains legacy", async () => {
  const ff = createFirefox();
  await ff.browser.storage.sync.set({ "tile:clock": rect }); ff.calls.length = 0;
  const loaded = await store.loadLayouts(ff.browser);
  assert.deepEqual(loaded.layouts, { 6: { lastWriteMs: 0, tiles: [tile] } });
  assert.equal(loaded.legacy.k, 6);
  await store.migrateLayouts(ff.browser, { now: 10, inUse: 6 });
  assert.deepEqual(ff.calls.filter(c => c.api.startsWith("storage.sync.") && c.api !== "storage.sync.get"), [
    { api: "storage.sync.set", args: [{ "tile:6:clock": rect, "layout:6": { t: 10 } }] },
  ]);
  await ff.browser.storage.sync.set({ "tile:clock": { ...rect, y: 30 } });
  ff.calls.length = 0; await store.migrateLayouts(ff.browser, { now: 11, inUse: 6 });
  assert.equal(ff.calls.some(c => /\.(set|remove)$/.test(c.api)), false);
  assert.deepEqual((await ff.browser.storage.sync.get(null))["tile:6:clock"], rect);
});
for (const existing of [{ "tile:17:pinned": rect }, { "layout:17": { t: 1 } }]) {
  test(`migration re-read refuses to copy legacy after ${Object.keys(existing)[0]} arrives`, async () => {
    const ff = createFirefox(); await ff.browser.storage.sync.set({ "tile:clock": rect });
    assert.equal((await store.loadLayouts(ff.browser)).legacy.k, 6);
    await ff.browser.storage.sync.set(existing); ff.calls.length = 0;
    await store.migrateLayouts(ff.browser, { now: 10, inUse: 6 });
    assert.equal(ff.calls.some(c => /\.(set|remove)$/.test(c.api)), false);
    assert.equal((await store.loadLayouts(ff.browser)).legacy, null);
  });
}
test("saveTiles sets only target tiles and its meta key together, leaving other timestamps unchanged", async () => {
  const ff = createFirefox(); await ff.browser.storage.sync.set(entriesFor({ 34: 5 })); ff.calls.length = 0;
  await store.saveTiles(ff.browser, 17, [{ ...tile, y: 2 }], { now: 7, inUse: 34 });
  assert.deepEqual(await ff.browser.storage.sync.get(null), { ...entriesFor({ 34: 5 }),
    "layout:17": { t: 7 }, "tile:17:clock": { ...rect, y: 2 } });
  assert.deepEqual(ff.calls.find(c => c.api === "storage.sync.set").args[0],
    { "tile:17:clock": { ...rect, y: 2 }, "layout:17": { t: 7 } });
  await store.saveTiles(ff.browser, 17, [], { now: 8 });
  assert.equal(ff.calls.filter(c => c.api === "storage.sync.set").length, 1);
});
for (const [inUse, want] of [[10, 20], [40, 10]]) {
  test(`fifth layout sets before evicting all keys of ${want}, protects source and breaks ties by width`, async () => {
    const ff = createFirefox(); await ff.browser.storage.sync.set({ ...entriesFor({ 10: 1, 20: 1, 30: 2, 40: 3 }),
      [`tile:${want}:group:broken`]: null, [`tile:${want}:foreign`]: rect, settings: {} }); ff.calls.length = 0;
    await store.saveTiles(ff.browser, 17, [tile], { now: 9, inUse });
    const calls = ff.calls.filter(c => /storage.sync\.(set|remove)$/.test(c.api));
    assert.equal(calls[0].api, "storage.sync.set");
    assert.deepEqual(calls[1].args[0].sort(), [`layout:${want}`, `tile:${want}:clock`, `tile:${want}:group:broken`, `tile:${want}:foreign`].sort());
    const stored = await ff.browser.storage.sync.get(null);
    assert.equal(widths(stored).length, 4); assert.equal(stored[`layout:${want}`], undefined);
    assert.ok(stored[`tile:${inUse}:clock`]);
  });
}
test("failed set never evicts an existing layout", async () => {
  const ff = createFirefox(), initial = entriesFor({ 10: 1, 20: 2, 30: 3, 40: 4 });
  await ff.browser.storage.sync.set(initial);
  ff.browser.storage.sync.set = async () => { throw new Error("quota"); };
  await assert.rejects(store.saveTiles(ff.browser, 17, [tile], { now: 9, inUse: 40 }), /quota/);
  assert.deepEqual(await ff.browser.storage.sync.get(null), initial);
});
test("a write evicts repeatedly after sync merged more than four layouts, using local last shown", async () => {
  const ff = createFirefox(); await ff.browser.storage.sync.set(entriesFor({ 10: 1, 20: 2, 30: 3, 40: 4, 50: 5, 60: 6 }));
  await ff.browser.storage.local.set({ layoutsShown: { 10: 100, 20: 200 } });
  await store.saveTiles(ff.browser, 17, [tile], { now: 300, inUse: 60 });
  assert.deepEqual(widths(await ff.browser.storage.sync.get(null)), ["layout:10", "layout:17", "layout:20", "layout:60"]);
});
test("sync-merge eviction counts tile-only layouts at zero and meta-only layouts", async () => {
  const ff = createFirefox(); await ff.browser.storage.sync.set({ ...entriesFor({ 10: 1, 20: 2, 30: 3 }),
    "tile:17:clock": rect, "layout:40": { t: 4 }, "layout:50": { t: 5 } });
  await store.evictLayouts(ff.browser, 10);
  const stored = await ff.browser.storage.sync.get(null);
  assert.equal(stored["tile:17:clock"], undefined); assert.equal(stored["layout:20"], undefined);
  assert.deepEqual(widths(stored), ["layout:10", "layout:30", "layout:40", "layout:50"]);
});
test("last shown is device-local, per layout and throttled to once a minute across callers", async () => {
  const ff = createFirefox();
  await Promise.all([store.markLayoutShown(ff.browser, 34, 100000), store.markLayoutShown(ff.browser, 17, 100001)]);
  await store.markLayoutShown(ff.browser, 34, 110000);
  await store.markLayoutShown(ff.browser, 34, 159999);
  assert.deepEqual((await ff.browser.storage.local.get("layoutsShown")).layoutsShown, { 17: 100001, 34: 100000 });
  await store.markLayoutShown(ff.browser, 34, 160000);
  assert.equal(ff.calls.filter(c => c.api === "storage.local.set").length, 3);
  assert.deepEqual((await ff.browser.storage.local.get("layoutsShown")).layoutsShown, { 17: 100001, 34: 160000 });
  assert.deepEqual(await ff.browser.storage.sync.get(null), {});
});
test("layout metadata storage changes trigger a refresh, last shown alone does not", async () => {
  const ff = createFirefox(), changes = []; store.watchStorage(ff.browser, keys => changes.push(keys));
  await ff.browser.storage.sync.set({ "layout:17": { t: 1 } });
  await ff.browser.storage.local.set({ layoutsShown: { 17: 2 } }); await ff.settle();
  assert.deepEqual(changes, [["layout:17"]]);
});
test("deleted saved group is removed from every layout and legacy, leaving metadata", async () => {
  const ff = createFirefox(); await ff.browser.storage.sync.set({ "tile:17:group:a": rect, "tile:34:group:a": rect,
    "tile:group:a": rect, "tile:34:group:b": rect, "layout:17": { t: 1 }, "layout:34": { t: 2 } });
  await store.removeGroupTiles(ff.browser, "a");
  assert.deepEqual(await ff.browser.storage.sync.get(null), { "tile:34:group:b": rect, "layout:17": { t: 1 }, "layout:34": { t: 2 } });
});

test("showing the same source within a minute performs no repeated storage read", async () => {
  const ff = createFirefox(); await store.markLayoutShown(ff.browser, 34, 100000);
  ff.calls.length = 0; await store.markLayoutShown(ff.browser, 34, 100001);
  assert.deepEqual(ff.calls, []);
});

test("concurrent edits at different widths preserve both independent metadata keys", async () => {
  const ff = createFirefox();
  await Promise.all([store.saveTiles(ff.browser, 17, [tile], { now: 1 }),
    store.saveTiles(ff.browser, 34, [{ ...tile, y: 9 }], { now: 2 })]);
  assert.deepEqual(await ff.browser.storage.sync.get(null), {
    "tile:17:clock": rect, "layout:17": { t: 1 }, "tile:34:clock": { ...rect, y: 9 }, "layout:34": { t: 2 },
  });
});
test("loadLayouts keeps a saved weather tile", async () => {
  const ff = createFirefox();
  await ff.browser.storage.sync.set({ "layout:17": { t: 1 }, "tile:17:weather": { x: 2, y: 0, w: 1, h: 1 } });
  assert.deepEqual((await store.loadLayouts(ff.browser)).layouts[17].tiles, [{ id: "weather", x: 2, y: 0, w: 1, h: 1 }]);
});
