import { test } from "node:test";
import assert from "node:assert/strict";
import { buildView } from "../extension/src/grid/view.js";
import { buildBoard } from "../extension/src/board/model.js";
import { DEFAULT_SETTINGS, DEFAULT_DEVICE } from "../extension/src/settings/store.js";

const group = (id, current = true) => ({ id, current, windowId: current ? 1 : 2, rows: [] });
const board = { columns: [group(1), group(2)], saved: [], pinned: [], tabs: [] };
const options = (overrides = {}) => ({ layout: [], synced: { ...DEFAULT_SETTINGS, showClock: false, showPinned: false },
  device: DEFAULT_DEVICE, contentWidth: 944, folders: { 1: "a", 2: "b" }, pending: new Map(), ...overrides });

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

test("an unmapped pending group uses its remembered rectangle without a write", () => {
  const view = buildView({ ...board, columns: [group(2)] }, options({ folders: {}, pending: new Map([[2, { x: 2, y: 7, w: 3, h: 4 }]]) }));
  assert.deepEqual(view.tiles.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })), [{ id: "local:2", x: 2, y: 7, w: 3, h: 4 }]);
  assert.deepEqual(view.newTiles, []);
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
