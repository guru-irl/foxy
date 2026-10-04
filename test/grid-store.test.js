import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { tileKey, loadLayouts, saveTiles, pruneTiles, watchStorage } from "../extension/src/grid/store.js";

const rect = { x: 0, y: 2, w: 3, h: 4 };

test("loadLayouts derives tile ids from keys and ignores unrelated data and foreign ids", async () => {
  const ff = createFirefox();
  await ff.browser.storage.sync.set({
    "tile:17:group:folder-a": { ...rect, id: "wrong", extra: true },
    "tile:17:pinned": { x: 1, y: 0, w: 1, h: 1 },
    "tile:17:saved": { x: 10000, y: 10000, w: 10000, h: 10000 },
    "tile:17:clock": { x: 0, y: 0, w: 5, h: 2 },
    settings: rect, unrelated: rect, "tile:17:": rect, "tile:17:group:": rect, "tile:17:foreign": rect,
  });
  assert.equal(tileKey(17, "group:folder-a"), "tile:17:group:folder-a");
  assert.deepEqual((await loadLayouts(ff.browser)).layouts[17]?.tiles ?? [], [
    { id: "group:folder-a", x: 0, y: 2, w: 3, h: 4 },
    { id: "pinned", x: 1, y: 0, w: 1, h: 1 },
    { id: "saved", x: 10000, y: 10000, w: 10000, h: 10000 },
    { id: "clock", x: 0, y: 0, w: 5, h: 2 },
  ]);
});

for (const [name, value] of [
  ["negative x", { ...rect, x: -1 }], ["negative y", { ...rect, y: -1 }],
  ["fractional x", { ...rect, x: 1.5 }], ["fractional y", { ...rect, y: 1.5 }],
  ["fractional width", { ...rect, w: 2.5 }], ["fractional height", { ...rect, h: 2.5 }],
  ["zero width", { ...rect, w: 0 }], ["negative height", { ...rect, h: -1 }],
  ["huge x", { ...rect, x: 1e9 }], ["huge y", { ...rect, y: 10001 }],
  ["huge width", { ...rect, w: 10001 }], ["huge height", { ...rect, h: 10001 }],
  ["numeric string", { ...rect, x: "0" }], ["boolean", { ...rect, h: true }],
  ["missing height", { x: 0, y: 0, w: 3 }], ["string", "str"], ["null", null],
  ["array", [0, 0, 3, 4]], ["number", 42],
]) {
  test(`loadLayouts ignores ${name} without dropping a valid neighbour`, async () => {
    const ff = createFirefox();
    await ff.browser.storage.sync.set({ "tile:17:group:bad": value, "tile:17:pinned": rect });
    assert.deepEqual((await loadLayouts(ff.browser)).layouts[17]?.tiles ?? [], [{ id: "pinned", x: 0, y: 2, w: 3, h: 4 }]);
  });
}

test("saveTiles writes only the given rectangles in one set and does nothing for an empty list", async () => {
  const ff = createFirefox();
  await ff.browser.storage.sync.set({ settings: { showClock: false }, "tile:17:saved": rect });
  ff.calls.length = 0;
  await saveTiles(ff.browser, 17, [
    { id: "group:a", x: 0, y: 2, w: 3, h: 4, extra: true },
    { id: "clock", x: 3, y: 0, w: 5, h: 2 },
  ], { now: 123 });
  await saveTiles(ff.browser, 17, []);
  assert.deepEqual(ff.calls.filter(c => c.api === "storage.sync.set"), [{ api: "storage.sync.set", args: [{
    "tile:17:group:a": { x: 0, y: 2, w: 3, h: 4 }, "tile:17:clock": { x: 3, y: 0, w: 5, h: 2 }, "layout:17": { t: 123 },
  }] }]);
  assert.deepEqual(await ff.browser.storage.sync.get(), {
    settings: { showClock: false }, "tile:17:saved": rect, "layout:17": { t: 123 },
    "tile:17:group:a": { x: 0, y: 2, w: 3, h: 4 }, "tile:17:clock": { x: 3, y: 0, w: 5, h: 2 },
  });
});

for (const count of [400, 401]) {
  test(`pruneTiles ${count === 400 ? "preserves unknown folders at" : "prunes unknown folders past"} 400 tile keys`, async () => {
    const ff = createFirefox();
    const entries = Object.fromEntries(Array.from({ length: count - 1 }, (_, i) => [`tile:17:foreign-${i}`, "bad"]));
    entries["tile:17:group:unknown"] = rect;
    await ff.browser.storage.sync.set({ ...entries, settings: {}, unrelated: 1 });
    ff.calls.length = 0;
    assert.deepEqual(await pruneTiles(ff.browser, new Set()), count === 400 ? [] : ["group:unknown"]);
    assert.equal((await ff.browser.storage.sync.get())["tile:17:group:unknown"] === undefined, count > 400);
    assert.equal(ff.calls.filter(c => c.api === "storage.sync.remove").length, count > 400 ? 1 : 0);
  });
}

test("pruneTiles past 400 keys removes only unknown group tiles and returns their tile ids", async () => {
  const ff = createFirefox();
  const extras = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`tile:17:foreign-${i}`, "bad"]));
  const kept = { ...extras, "tile:17:group:open": rect, "tile:17:group:closed": rect, "tile:17:group:missing": rect,
    "tile:17:pinned": rect, "tile:17:saved": rect, "tile:17:clock": rect, settings: {}, unrelated: 1 };
  await ff.browser.storage.sync.set({ ...kept, "tile:17:group:gone": rect, "tile:17:group:corrupt": "bad" });
  ff.calls.length = 0;
  const keep = new Set(["open", "closed", "missing"]);
  assert.deepEqual(await pruneTiles(ff.browser, keep), ["group:gone", "group:corrupt"]);
  assert.deepEqual(ff.calls.filter(c => c.api === "storage.sync.remove"), [
    { api: "storage.sync.remove", args: [["tile:17:group:gone", "tile:17:group:corrupt"]] },
  ]);
  assert.deepEqual(await ff.browser.storage.sync.get(), kept);
  ff.calls.length = 0;
  assert.deepEqual(await pruneTiles(ff.browser, keep), []);
  assert.equal(ff.calls.some(c => c.api === "storage.sync.remove"), false);
  assert.deepEqual([...keep], ["open", "closed", "missing"]);
});

test("different tile edits survive and the same tile is last writer wins with sync events", async () => {
  // Sequential writes model two devices delivering edits to one sync area.
  const ff = createFirefox(), changes = [];
  const off = watchStorage(ff.browser, keys => changes.push(keys));
  await saveTiles(ff.browser, 17, [{ id: "group:a", x: 1, y: 2, w: 3, h: 4 }]);
  await saveTiles(ff.browser, 17, [{ id: "group:b", x: 4, y: 2, w: 3, h: 4 }]);
  await saveTiles(ff.browser, 17, [{ id: "group:a", x: 2, y: 6, w: 4, h: 4 }]);
  await ff.settle();
  assert.deepEqual((await loadLayouts(ff.browser)).layouts[17]?.tiles ?? [], [
    { id: "group:a", x: 2, y: 6, w: 4, h: 4 }, { id: "group:b", x: 4, y: 2, w: 3, h: 4 },
  ]);
  assert.deepEqual(changes, [["tile:17:group:a", "layout:17"], ["tile:17:group:b", "layout:17"], ["tile:17:group:a", "layout:17"]]);
  off();
});

test("watchStorage filters keys by area, observes removals, and detaches", async () => {
  const ff = createFirefox(), changes = [];
  const off = watchStorage(ff.browser, keys => changes.push(keys));
  await ff.browser.storage.sync.set({ "tile:17:clock": rect, settings: {}, deviceSettings: {}, other: 1 });
  await ff.browser.storage.local.set({ deviceSettings: {}, "tile:17:clock": rect, settings: {}, other: 1 });
  await ff.browser.storage.session.set({ deviceSettings: {}, "tile:17:clock": rect, settings: {} });
  await ff.browser.storage.sync.set({ other: 2 });
  await ff.browser.storage.sync.remove("tile:17:clock");
  await ff.browser.storage.local.remove("deviceSettings");
  await ff.settle();
  assert.deepEqual(changes, [["tile:17:clock", "settings"], ["deviceSettings"], ["tile:17:clock"], ["deviceSettings"]]);
  off();
  off();
  await ff.browser.storage.sync.set({ settings: { showClock: false } });
  await ff.settle();
  assert.equal(changes.length, 4);
});

test("failed layout reads log once and use an empty layout without pruning", async t => {
  const ff = createFirefox(), error = new Error("storage unavailable");
  const get = t.mock.method(ff.browser.storage.sync, "get", async () => { throw error; });
  const warn = t.mock.method(console, "warn", () => {});
  assert.deepEqual((await loadLayouts(ff.browser)).layouts[17]?.tiles ?? [], []);
  assert.deepEqual(await pruneTiles(ff.browser, new Set()), []);
  assert.equal(get.mock.calls.length, 2);
  assert.equal(warn.mock.calls.length, 2);
  assert.ok(warn.mock.calls.every(call => call.arguments[0].startsWith("Foxy:")));
  assert.equal(ff.calls.some(c => c.api === "storage.sync.remove"), false);
});

for (const operation of ["set", "remove"]) {
  test(`failed layout ${operation} logs once and rejects without retrying`, async t => {
    const ff = createFirefox(), error = new Error("storage unavailable");
    const extras = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`tile:17:foreign-${i}`, "bad"]));
    await ff.browser.storage.sync.set({ ...extras, "tile:17:group:gone": rect });
    const write = t.mock.method(ff.browser.storage.sync, operation, async () => { throw error; });
    const warn = t.mock.method(console, "warn", () => {});
    await assert.rejects(operation === "set"
      ? saveTiles(ff.browser, 17, [{ id: "clock", ...rect }]) : pruneTiles(ff.browser, new Set()), error);
    assert.equal(write.mock.calls.length, 1);
    assert.equal(warn.mock.calls.length, 1);
    assert.match(warn.mock.calls[0].arguments[0], /^Foxy:/);
    assert.deepEqual(await ff.browser.storage.sync.get(), { ...extras, "tile:17:group:gone": rect });
  });
}
