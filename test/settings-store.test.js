import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { DEFAULT_SETTINGS, DEFAULT_DEVICE, loadSettings, saveSetting, cellPx, cardAlpha } from "../extension/src/settings/store.js";

const syncedDefaults = { railCells: 3, showClock: true, showPinned: true, showSaved: true,
  timeFormat: "24", showDate: true, transparency: "medium", otherWindows: true, pinsMoveHere: true, switchToOpenTab: true,
  showWeather: true, tempUnit: "C" };
const deviceDefaults = { cellSize: "M", customCell: 80, density: "normal", weatherPlace: "auto" };

test("loadSettings returns detached defaults when storage is empty", async () => {
  const ff = createFirefox();
  const loaded = await loadSettings(ff.browser);
  assert.deepEqual(loaded, { synced: syncedDefaults, device: deviceDefaults });
  loaded.synced.showClock = false;
  loaded.device.cellSize = "S";
  assert.deepEqual(await loadSettings(ff.browser), { synced: syncedDefaults, device: deviceDefaults });
  assert.deepEqual(DEFAULT_SETTINGS, syncedDefaults);
  assert.deepEqual(DEFAULT_DEVICE, deviceDefaults);
});

test("loadSettings falls back per key, keeps valid values and ignores unknown keys", async () => {
  const ff = createFirefox();
  await ff.browser.storage.sync.set({ settings: { railCells: "x", showClock: 1, transparency: "max",
    showPinned: false, timeFormat: "12", showDate: false, extra: true } });
  await ff.browser.storage.local.set({ deviceSettings: { cellSize: "custom", customCell: 500,
    density: "compact", extra: true } });
  assert.deepEqual(await loadSettings(ff.browser), {
    synced: { railCells: 3, showClock: true, showPinned: false, showSaved: true,
      timeFormat: "12", showDate: false, transparency: "medium", otherWindows: true, pinsMoveHere: true, switchToOpenTab: true,
      showWeather: true, tempUnit: "C" },
    device: { cellSize: "custom", customCell: 80, density: "compact", weatherPlace: "auto" },
  });
});

for (const value of [null, "bad", 42, [], [false]]) {
  test(`loadSettings ignores wrong-shaped objects: ${JSON.stringify(value)}`, async () => {
    const ff = createFirefox();
    await ff.browser.storage.sync.set({ settings: value });
    await ff.browser.storage.local.set({ deviceSettings: value });
    assert.deepEqual(await loadSettings(ff.browser), { synced: syncedDefaults, device: deviceDefaults });
  });
}

const invalid = [
  ["synced", "railCells", 1], ["synced", "railCells", -1], ["synced", "railCells", 2.5],
  ["synced", "railCells", 1e9], ["synced", "railCells", "3"],
  ...["showClock", "showPinned", "showSaved", "showDate", "otherWindows", "pinsMoveHere", "switchToOpenTab"]
    .map(key => ["synced", key, 1]),
  ["synced", "timeFormat", "24-hour"], ["synced", "timeFormat", 12],
  ["synced", "transparency", "max"],
  ["device", "cellSize", "XXL"], ["device", "customCell", 500], ["device", "customCell", 39],
  ["device", "customCell", 40.5], ["device", "customCell", "80"], ["device", "density", "dense"],
  ["synced", "showWeather", 1], ["synced", "tempUnit", "K"], ["synced", "tempUnit", "c"],
  ["device", "weatherPlace", "home"], ["device", "weatherPlace", { name: "X", lat: 95, lon: 0 }],
  ["device", "weatherPlace", { lat: 1, lon: 1 }],
];
for (const [scope, key, value] of invalid) {
  test(`invalid ${scope}.${key}=${JSON.stringify(value)} falls back on load and rejects on save without writing`, async () => {
    const ff = createFirefox();
    const area = scope === "synced" ? "sync" : "local", storageKey = scope === "synced" ? "settings" : "deviceSettings";
    await ff.browser.storage[area].set({ [storageKey]: { [key]: value } });
    assert.deepEqual(await loadSettings(ff.browser), { synced: syncedDefaults, device: deviceDefaults });
    ff.calls.length = 0;
    await assert.rejects(saveSetting(ff.browser, scope, key, value));
    assert.equal(ff.calls.some(c => c.api.endsWith(".set")), false);
    assert.deepEqual(await ff.browser.storage[area].get(storageKey), { [storageKey]: { [key]: value } });
  });
}

for (const [scope, key] of [["synced", "unknown"], ["device", "showClock"], ["synced", "cellSize"],
  ["local", "density"], ["synced", "toString"], ["device", "__proto__"]]) {
  test(`saveSetting rejects unknown scope or key ${scope}.${key} without storage access`, async () => {
    const ff = createFirefox();
    await assert.rejects(saveSetting(ff.browser, scope, key, true));
    assert.deepEqual(ff.calls, []);
  });
}

const valid = [
  ["synced", "railCells", 2], ["synced", "railCells", 10000],
  ...["showClock", "showPinned", "showSaved", "showDate", "otherWindows", "pinsMoveHere", "switchToOpenTab"]
    .map(key => ["synced", key, false]),
  ["synced", "timeFormat", "12"], ["synced", "timeFormat", "24"],
  ...["low", "medium", "high"].map(value => ["synced", "transparency", value]),
  ...["S", "M", "L", "XL", "custom"].map(value => ["device", "cellSize", value]),
  ["device", "customCell", 40], ["device", "customCell", 240],
  ["device", "density", "normal"], ["device", "density", "compact"],
  ["synced", "showWeather", false], ["synced", "tempUnit", "F"], ["synced", "tempUnit", "C"],
  ["device", "weatherPlace", { name: "Dublin", lat: 53.33, lon: -6.25 }], ["device", "weatherPlace", "auto"],
];
for (const [scope, key, value] of valid) {
  test(`saveSetting accepts ${scope}.${key}=${JSON.stringify(value)} in the correct area`, async () => {
    const ff = createFirefox();
    const want = { synced: { ...syncedDefaults }, device: { ...deviceDefaults } };
    want[scope][key] = value;
    assert.deepEqual(await saveSetting(ff.browser, scope, key, value), want);
    const area = scope === "synced" ? "sync" : "local", storageKey = scope === "synced" ? "settings" : "deviceSettings";
    assert.deepEqual(ff.calls.filter(c => c.api.endsWith(".set")), [
      { api: `storage.${area}.set`, args: [{ [storageKey]: { [key]: value } }] },
    ]);
    assert.deepEqual(await loadSettings(ff.browser), want);
  });
}

test("saveSetting preserves other valid settings and writes only the selected scope", async () => {
  const ff = createFirefox();
  await ff.browser.storage.sync.set({ settings: { showClock: false, railCells: 4, transparency: "high", extra: 1 },
    "tile:17:clock": { x: 0, y: 0, w: 5, h: 2 } });
  await ff.browser.storage.local.set({ deviceSettings: { cellSize: "S", customCell: 120, density: "compact" }, unrelated: 1 });
  ff.calls.length = 0;
  const loaded = await saveSetting(ff.browser, "synced", "showPinned", false);
  assert.deepEqual(loaded, {
    synced: { railCells: 4, showClock: false, showPinned: false, showSaved: true, timeFormat: "24",
      showDate: true, transparency: "high", otherWindows: true, pinsMoveHere: true, switchToOpenTab: true,
      showWeather: true, tempUnit: "C" },
    device: { cellSize: "S", customCell: 120, density: "compact", weatherPlace: "auto" },
  });
  assert.deepEqual(ff.calls.filter(c => c.api.endsWith(".set")), [
    { api: "storage.sync.set", args: [{ settings: { showClock: false, railCells: 4, transparency: "high", extra: 1,
      showPinned: false } }] },
  ]);
  assert.deepEqual(await ff.browser.storage.sync.get("tile:17:clock"), { "tile:17:clock": { x: 0, y: 0, w: 5, h: 2 } });
  assert.deepEqual(await ff.browser.storage.local.get(), {
    deviceSettings: { cellSize: "S", customCell: 120, density: "compact" }, unrelated: 1,
  });
});

for (const [device, px] of [
  [{ cellSize: "S" }, 48], [{ cellSize: "M" }, 80], [{ cellSize: "L" }, 112], [{ cellSize: "XL" }, 144],
  [{ cellSize: "custom", customCell: 39 }, 40], [{ cellSize: "custom", customCell: 40 }, 40],
  [{ cellSize: "custom", customCell: 120 }, 120], [{ cellSize: "custom", customCell: 240 }, 240],
  [{ cellSize: "custom", customCell: 241 }, 240], [{ cellSize: "XXL" }, 80],
  [{ cellSize: "custom", customCell: "80" }, 80], [null, 80],
]) {
  test(`cellPx derives ${px} for ${JSON.stringify(device)}`, () => assert.equal(cellPx(device), px));
}
for (const [level, scheme, alpha] of [
  ["low", "dark", 0.75], ["low", "light", 0.85], ["medium", "dark", 0.6], ["medium", "light", 0.7],
  ["high", "dark", 0.45], ["high", "light", 0.55], ["invalid", "dark", 0.6],
]) {
  test(`cardAlpha derives ${alpha} for ${level} ${scheme}`, () => assert.equal(cardAlpha(level, scheme), alpha));
}

for (const area of ["sync", "local"]) {
  test(`failed ${area} settings read logs once and defaults only that scope`, async t => {
    const ff = createFirefox();
    await ff.browser.storage.sync.set({ settings: { showClock: false } });
    await ff.browser.storage.local.set({ deviceSettings: { cellSize: "S" } });
    const get = t.mock.method(ff.browser.storage[area], "get", async () => { throw new Error("unavailable"); });
    const warn = t.mock.method(console, "warn", () => {});
    assert.deepEqual(await loadSettings(ff.browser), {
      synced: { ...syncedDefaults, showClock: area === "sync" },
      device: { ...deviceDefaults, cellSize: area === "local" ? "M" : "S" },
    });
    assert.equal(get.mock.calls.length, 1);
    assert.equal(warn.mock.calls.length, 1);
    assert.match(warn.mock.calls[0].arguments[0], /^Foxy:/);
  });
  test(`failed ${area} settings write logs and rejects once without changing stored data`, async t => {
    const ff = createFirefox(), error = new Error("unavailable");
    const write = t.mock.method(ff.browser.storage[area], "set", async () => { throw error; });
    const warn = t.mock.method(console, "warn", () => {});
    await assert.rejects(saveSetting(ff.browser, area === "sync" ? "synced" : "device",
      area === "sync" ? "showClock" : "cellSize", area === "sync" ? false : "S"), error);
    assert.equal(write.mock.calls.length, 1);
    assert.equal(warn.mock.calls.length, 1);
    assert.match(warn.mock.calls[0].arguments[0], /^Foxy:/);
    assert.deepEqual(await ff.browser.storage[area].get(), {});
  });
}

test("saveSetting rejects and writes nothing when the stored settings cannot be read", async t => {
  const ff = createFirefox();
  const stored = { showClock: false, railCells: 5, transparency: "high" };
  await ff.browser.storage.sync.set({ settings: stored });
  const realGet = ff.browser.storage.sync.get;
  t.mock.method(ff.browser.storage.sync, "get", async () => { throw new Error("transient"); });
  t.mock.method(console, "warn", () => {});
  ff.calls.length = 0;
  await assert.rejects(saveSetting(ff.browser, "synced", "showDate", false), /transient/);
  assert.deepEqual(ff.calls.filter(c => c.api.endsWith(".set")), []);
  assert.deepEqual((await realGet("settings")).settings, stored);
});

test("concurrent saveSetting calls in one page both persist", async () => {
  const ff = createFirefox();
  await Promise.all([
    saveSetting(ff.browser, "synced", "showClock", false),
    saveSetting(ff.browser, "synced", "showDate", false),
    saveSetting(ff.browser, "device", "density", "compact"),
  ]);
  const { synced, device } = await loadSettings(ff.browser);
  assert.equal(synced.showClock, false);
  assert.equal(synced.showDate, false);
  assert.equal(device.density, "compact");
});

test("saveSetting reports the value it wrote even if reading back fails", async t => {
  const ff = createFirefox();
  await ff.browser.storage.sync.set({ settings: { showClock: false } });
  const realGet = ff.browser.storage.sync.get;
  let reads = 0;
  t.mock.method(ff.browser.storage.sync, "get", async (...args) => {
    if (++reads > 1) throw new Error("transient");
    return realGet(...args);
  });
  t.mock.method(console, "warn", () => {});
  const result = await saveSetting(ff.browser, "synced", "showDate", false);
  assert.equal(result.synced.showDate, false);
  assert.equal(result.synced.showClock, false);
  assert.deepEqual(result.device, deviceDefaults);
});
