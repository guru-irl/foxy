import { test } from "node:test";
import assert from "node:assert/strict";
import { buildView } from "../extension/src/grid/view.js";
import { buildBoard } from "../extension/src/board/model.js";
import { DEFAULT_SETTINGS as DEFAULTS, DEFAULT_DEVICE } from "../extension/src/settings/store.js";

// These tests pin the other tile kinds; the weather tile has its own test below.
const DEFAULT_SETTINGS = { ...DEFAULTS, showWeather: false };

const group = (id, current = true) => ({ id, current, windowId: current ? 1 : 2, rows: [] });
const board = { columns: [group(1), group(2)], saved: [], pinned: [], tabs: [] };
const options = (overrides = {}) => {
  const { layout = [], ...rest } = overrides;
  const k = Math.max(7, ...layout.map(t => t.x + t.w));
  return { layouts: layout.length ? { [k]: { lastWriteMs: 0, tiles: layout } } : {},
    synced: { ...DEFAULT_SETTINGS, showClock: false, showPinned: false },
    device: DEFAULT_DEVICE, contentWidth: 944, folders: { 1: "a", 2: "b" }, ...rest };
};

test("new tiles use clock, pinned, current tab-strip groups, remote groups, saved order", () => {
  const ordered = buildBoard({ windows: [{ id: 2, type: "normal" }, { id: 1, type: "normal" }],
    currentWindowId: 1, groups: [{ id: 3, windowId: 2 }, { id: 2, windowId: 1 }, { id: 1, windowId: 1 }],
    tabs: [{ id: 30, windowId: 2, groupId: 3, index: 0 }, { id: 20, windowId: 1, groupId: 2, index: 5 },
      { id: 10, windowId: 1, groupId: 1, index: 1 }], saved: [{ folderId: "closed" }] });
  const view = buildView(ordered, options({ synced: DEFAULT_SETTINGS, contentWidth: 1232, folders: { 1: "a", 2: "b", 3: "c" } }));
  assert.deepEqual(view.newTiles, [
    { id: "clock", x: 0, y: 0, w: 5, h: 2 }, { id: "pinned", x: 5, y: 0, w: 3, h: 4 },
    { id: "group:a", x: 0, y: 2, w: 3, h: 4 }, { id: "group:b", x: 3, y: 4, w: 3, h: 4 },
    { id: "group:c", x: 6, y: 4, w: 3, h: 4 }, { id: "saved", x: 0, y: 6, w: 3, h: 4 },
  ]);
});

test("new group tiles get first-free defaults and are returned for saving", () => {
  const view = buildView(board, options());
  assert.deepEqual([view.cell, view.total, view.cols, view.railCells], [80, 10, 7, 3]);
  assert.deepEqual(view.newTiles, [{ id: "group:a", x: 0, y: 0, w: 3, h: 4 }, { id: "group:b", x: 3, y: 0, w: 3, h: 4 }]);
  assert.equal(view.tiles[0].group, board.columns[0]);
  assert.equal(view.tiles[0].kind, "group");
});

test("hidden kinds and closed groups keep saved keys but reserve no space", () => {
  const layout = [{ id: "clock", x: 0, y: 0, w: 5, h: 2 }, { id: "pinned", x: 0, y: 2, w: 3, h: 4 },
    { id: "saved", x: 3, y: 2, w: 3, h: 4 }, { id: "group:closed", x: 0, y: 6, w: 3, h: 4 }];
  const view = buildView(board, options({ layout }));
  assert.deepEqual(view.tiles.map(t => t.id), ["group:a", "group:b"]);
  assert.deepEqual(view.newTiles.map(t => [t.x, t.y]), [[0, 0], [3, 0]]);
  assert.deepEqual(view.saved, layout);
});

test("enabled clock and pinned show even when empty; saved needs entries", () => {
  const view = buildView({ ...board, columns: [], saved: [{ folderId: "c" }] }, options({ synced: DEFAULT_SETTINGS }));
  assert.deepEqual(view.tiles.map(t => t.id), ["clock", "pinned", "saved"]);
  assert.deepEqual(buildView({ ...board, columns: [] }, options({ synced: DEFAULT_SETTINGS })).tiles.map(t => t.id), ["clock", "pinned"]);
});

test("otherWindows false excludes remote group tiles", () => {
  const view = buildView({ ...board, columns: [group(1), group(2, false)] }, options({ synced: { ...DEFAULT_SETTINGS, showClock: false, showPinned: false, otherWindows: false } }));
  assert.deepEqual(view.tiles.map(t => t.id), ["group:a"]);
});

test("unmapped groups get display-only local ids", () => {
  const view = buildView(board, options({ folders: { 1: "a" } }));
  assert.deepEqual(view.tiles.map(t => t.id), ["group:a", "local:2"]);
  assert.deepEqual(view.newTiles.map(t => t.id), ["group:a"]);
});


test("narrow fit is display-only and retains the raw saved layout", () => {
  const layout = [{ id: "group:a", x: 8, y: 0, w: 4, h: 4 }, { id: "group:b", x: 0, y: 0, w: 3, h: 4 }];
  const original = structuredClone(layout);
  const view = buildView(board, options({ layout, contentWidth: 560 }));
  assert.deepEqual([view.total, view.cols, view.railCells], [6, 3, 3]);
  assert.deepEqual(view.tiles.map(t => [t.id, t.x, t.y, t.w]), [["group:a", 0, 4, 3], ["group:b", 0, 0, 3]]);
  assert.deepEqual(view.newTiles, []);
  assert.deepEqual(view.saved, original);
  assert.deepEqual(layout, original);
});

test("fractional cells fill the page and narrow fit leaves saved rectangles unchanged", () => {
  const layout = [{ id: "group:a", x: 7, y: 0, w: 3, h: 4 }, { id: "group:b", x: 0, y: 0, w: 3, h: 4 }];
  const view = buildView(board, options({ layout, contentWidth: 701, synced: { ...DEFAULT_SETTINGS, showClock: false, showPinned: false, railCells: 2 } }));
  assert.deepEqual([view.total, view.cols, view.railCells], [7, 5, 2]);
  assert.equal(view.cell, 717 / 7 - 16);
  assert.deepEqual(view.tiles.map(t => [t.x, t.y, t.w]), [[0, 4, 3], [0, 0, 3]]);
  assert.deepEqual(view.saved, layout);
  assert.deepEqual(view.newTiles, []);
});

test("new defaults use the cell setting and save their full size before display fit", () => {
  const view = buildView(board, options({ contentWidth: 252, synced: DEFAULT_SETTINGS }));
  assert.equal(view.cell, 118);
  assert.deepEqual(view.newTiles.map(({ id, x, y, w, h }) => [id, x, y, w, h]), [
    ["clock", 0, 0, 5, 2], ["pinned", 0, 2, 3, 4], ["group:a", 0, 6, 3, 4], ["group:b", 0, 10, 3, 4],
  ]);
  assert.ok(view.tiles.every(t => t.w === 1));
});

// Stretching cells must affect display geometry, not a new tile's stored size.
for (const [device, expected] of [
  [{ ...DEFAULT_DEVICE, cellSize: "XL" }, [["clock", 3, 2], ["pinned", 2, 3], ["group:a", 2, 3], ["saved", 2, 3]]],
  [{ ...DEFAULT_DEVICE, cellSize: "custom", customCell: 90 }, [["clock", 5, 2], ["pinned", 3, 4], ["group:a", 3, 4], ["saved", 3, 4]]],
]) {
  for (const contentWidth of [1600, 1000]) {
    test(`${device.cellSize} defaults at width ${contentWidth} use the setting for every kind`, () => {
      const model = { ...board, columns: [group(1)], saved: [{ folderId: "closed" }] };
      const view = buildView(model, options({ contentWidth, synced: DEFAULT_SETTINGS, device }));
      assert.deepEqual(view.newTiles.map(({ id, w, h }) => [id, w, h]), expected);
      assert.ok(view.cell > (device.cellSize === "XL" ? 144 : 90), "the real cell is stretched");
    });
  }
}

for (const [contentWidth, cols] of [[272, 1], [400, 2]]) {
  test(`new tiles at width ${contentWidth} save full default sizes at the shown x/y`, () => {
    const model = { ...board, columns: [group(1)], saved: [{ folderId: "closed" }] };
    const view = buildView(model, options({ contentWidth, synced: DEFAULT_SETTINGS }));
    assert.equal(view.cols, cols);
    assert.deepEqual(view.newTiles, [
      { id: "clock", x: 0, y: 0, w: 5, h: 2 },
      { id: "pinned", x: 0, y: 2, w: 3, h: 4 },
      { id: "group:a", x: 0, y: 6, w: 3, h: 4 },
      { id: "saved", x: 0, y: 10, w: 3, h: 4 },
    ]);
    assert.deepEqual(view.tiles.map(({ x, y, w, h }) => [x, y, w, h]),
      [[0, 0, cols, 2], [0, 2, cols, 4], [0, 6, cols, 4], [0, 10, cols, 4]]);
    const widened = buildView(model, options({ layout: view.newTiles, synced: DEFAULT_SETTINGS, contentWidth: 1600 }));
    assert.deepEqual(widened.tiles.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })), view.newTiles);
    assert.deepEqual(widened.newTiles, []);
  });
}


test("overlapping saved tiles are fitted without becoming new writes", () => {
  const layout = [{ id: "group:a", x: 0, y: 0, w: 3, h: 4 }, { id: "group:b", x: 0, y: 0, w: 3, h: 4 }];
  const view = buildView(board, options({ layout }));
  assert.deepEqual(view.tiles.map(t => [t.x, t.y]), [[0, 0], [3, 0]]);
  assert.deepEqual(view.newTiles, []);
  assert.deepEqual(view.saved, layout);
});

for (const [width, railCells, expected] of [[30, 100, [1, 2, 1]], [944, 100, [10, 5, 5]], [944, 2, [10, 2, 8]]]) {
  test(`rail clamps to limits at content width ${width} and requested cells ${railCells}`, () => {
    const view = buildView(board, options({ contentWidth: width, synced: { ...DEFAULT_SETTINGS, railCells } }));
    assert.deepEqual([view.total, view.railCells, view.cols], expected);
  });
}

test("device cell size changes the geometry and default target in cells", () => {
  const view = buildView(board, options({ device: { ...DEFAULT_DEVICE, cellSize: "S" } }));
  assert.deepEqual([view.cell, view.total, view.cols], [48, 15, 12]);
  assert.deepEqual(view.newTiles[0], { id: "group:a", x: 0, y: 0, w: 5, h: 6 });
});

test("board otherWindows false filters pins, groups and loose tabs to this window", () => {
  const view = buildBoard({ windows: [{ id: 1, type: "normal" }, { id: 2, type: "normal" }], currentWindowId: 1,
    groups: [{ id: 1, windowId: 1 }, { id: 2, windowId: 2 }],
    tabs: [1, 2].flatMap(windowId => [{ id: windowId * 10, windowId, pinned: true },
      { id: windowId * 10 + 1, windowId, groupId: windowId }, { id: windowId * 10 + 2, windowId, groupId: -1 }]), otherWindows: false });
  assert.deepEqual(view.windowOrder, [1]);
  assert.deepEqual(view.columns.map(g => g.id), [1]);
  assert.deepEqual(view.pinned.flatMap(s => s.rows).map(t => t.id), [10]);
  assert.deepEqual(view.tabs.flatMap(s => s.rows).map(t => t.id), [12]);
});


test("source layout geometry places new groups at the source width before deriving", () => {
  const layout = [{ id: "group:a", x: 0, y: 0, w: 20, h: 9 }];
  const view = buildView(board, options({ layouts: { 34: { lastWriteMs: 1, tiles: layout } },
    contentWidth: 1392, device: { ...DEFAULT_DEVICE, cellSize: "S" },
    synced: { ...DEFAULT_SETTINGS, showClock: false, showPinned: false, railCells: 5 } }));
  assert.equal(view.cols, 17); assert.equal(view.k, 34);
  assert.deepEqual(view.newTiles, [{ id: "group:b", x: 20, y: 0, w: 5, h: 6 }]);
  assert.deepEqual(view.saved, layout);
});

test("source qualification ignores closed groups and hidden kinds, not just total saved bounds", () => {
  const wide = [{ id: "group:a", x: 0, y: 0, w: 20, h: 9 }, { id: "group:closed", x: 20, y: 0, w: 14, h: 9 }];
  const view = buildView({ ...board, columns: [group(1)] }, options({
    layouts: { 17: { tiles: [{ id: "group:a", x: 0, y: 0, w: 5, h: 6 }] }, 34: { tiles: wide } },
    contentWidth: 1456, device: { ...DEFAULT_DEVICE, cellSize: "S" },
    synced: { ...DEFAULT_SETTINGS, showClock: false, showPinned: false, railCells: 5 },
  }));
  assert.equal(view.k, 34, "visible wide group can keep its arrangement when capped; closed group must not force packing");
  assert.deepEqual(view.tiles.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })),
    [{ id: "group:a", x: 0, y: 0, w: 18, h: 9 }]);
});

test("showWeather adds a weather tile after the others; off reserves no space", () => {
  const on = buildView({ ...board, columns: [], saved: [{ folderId: "c" }] },
    options({ synced: { ...DEFAULTS, showWeather: true }, device: { ...DEFAULT_DEVICE, cellSize: "S" }, contentWidth: 1232 }));
  assert.deepEqual(on.tiles.map(t => t.id), ["clock", "pinned", "saved", "weather"]);
  assert.equal(on.tiles.at(-1).kind, "weather");
  assert.deepEqual(on.newTiles.at(-1), { id: "weather", x: 5, y: 6, w: 5, h: 5 });
  const off = buildView({ ...board, columns: [] }, options({ synced: { ...DEFAULTS, showWeather: false } }));
  assert.equal(off.tiles.some(t => t.id === "weather"), false);
});
