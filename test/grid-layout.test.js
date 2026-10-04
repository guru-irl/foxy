import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GAP, CELL_PRESETS, kindOf, totalColumns, railLimits, minSize, defaultSize,
  overlaps, clampRect, place, fit, firstFree, addMissing, changedTiles,
} from "../extension/src/grid/layout.js";

import * as geometry from "../extension/src/grid/layout.js";

for (const [width, target, want] of [
  [2560, 80, { total: 26, cell: 2576 / 26 - 16 }],
  [30, 80, { total: 1, cell: 30 }],
  [0, 80, { total: 1, cell: 0 }],
  [176, 80, { total: 2, cell: 80 }],
  [1237.5, 80, { total: 13, cell: 1253.5 / 13 - 16 }],
]) {
  test(`fitCell(${width}, ${target}) fills the width with whole columns`, () => {
    assert.equal(typeof geometry.fitCell, "function");
    assert.deepEqual(geometry.fitCell(width, target), want);
  });
}

test("stretched cells never shrink below the target with multiple columns", () => {
  assert.equal(typeof geometry.fitCell, "function");
  for (const target of [40, 48, 80, 112, 144, 240]) {
    for (const width of [400, 700, 1237.5, 2560]) {
      const { total, cell } = geometry.fitCell(width, target);
      if (total > 1) assert.ok(cell >= target);
      assert.ok(Math.abs(total * (cell + 16) - 16 - width) < 1e-9);
    }
  }
});

function assertNoOverlaps(tiles) {
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      assert.equal(overlaps(tiles[i], tiles[j]), false, `${tiles[i].id} overlaps ${tiles[j].id}`);
    }
  }
}

function freezeTiles(tiles) {
  return Object.freeze(tiles.map(tile => Object.freeze(tile)));
}

for (const [width, cell, want] of [
  [2560 - 2 * 48, 80, 25],
  [30, 80, 1],
  [0, CELL_PRESETS.S, 1],
  [175, 80, 1],
  [176, 80, 2],
  [240, CELL_PRESETS.S, 4],
  [240, 112, 2],
  [304, 144, 2],
]) {
  test(`totalColumns(${width}, ${cell}) counts cells including ${GAP}px gaps`, () => {
    assert.equal(totalColumns(width, cell), want);
  });
}

for (const [total, want] of [[25, { min: 2, max: 12 }], [3, { min: 2, max: 2 }], [1, { min: 2, max: 2 }]]) {
  test(`railLimits(${total}) reserves at least two cells and at most half the columns`, () => {
    assert.deepEqual(railLimits(total), want);
  });
}

for (const [id, kind, size] of [
  ["group:a", "group", { w: 2, h: 2 }],
  ["pinned", "pinned", { w: 1, h: 1 }],
  ["saved", "saved", { w: 2, h: 2 }],
  ["clock", "clock", { w: 3, h: 2 }],
  ["weather", "weather", { w: 1, h: 1 }],
]) {
  test(`${id} has the ${kind} minimum size`, () => {
    assert.equal(kindOf(id), kind);
    assert.deepEqual(minSize(kind), size);
  });
}

for (const [kind, cell, cols, want] of [
  ["group", 80, 25, { w: 3, h: 4 }],
  ["pinned", 80, 25, { w: 6, h: 2 }],
  ["saved", 80, 25, { w: 3, h: 4 }],
  ["clock", 80, 25, { w: 5, h: 2 }],
  ["group", 48, 25, { w: 5, h: 6 }],
  ["clock", 144, 25, { w: 3, h: 2 }],
  ["group", 80, 2, { w: 2, h: 4 }],
  ["clock", 80, 1, { w: 1, h: 2 }],
  ["saved", 240, 25, { w: 2, h: 2 }],
  ["weather", 48, 25, { w: 5, h: 5 }],
  ["weather", 80, 25, { w: 3, h: 3 }],
]) {
  test(`defaultSize(${kind}, ${cell}, ${cols}) converts pixel targets and caps width`, () => {
    assert.deepEqual(defaultSize(kind, cell, cols), want);
  });
}

for (const [rect, want] of [
  [{ x: 2, y: 2, w: 2, h: 2 }, true],
  [{ x: 3, y: 0, w: 2, h: 2 }, false],
  [{ x: 0, y: 3, w: 2, h: 2 }, false],
  [{ x: 5, y: 5, w: 2, h: 2 }, false],
]) {
  test(`overlaps treats ${JSON.stringify(rect)} as ${want ? "intersecting" : "separate"}`, () => {
    const origin = { x: 0, y: 0, w: 3, h: 3 };
    assert.equal(overlaps(origin, rect), want);
    assert.equal(overlaps(rect, origin), want);
  });
}

for (const [id, rect, cols, want] of [
  ["group:a", { x: 23, y: 0, w: 5, h: 4 }, 25, { id: "group:a", x: 20, y: 0, w: 5, h: 4 }],
  ["group:a", { x: -3, y: -2, w: 1, h: 1 }, 25, { id: "group:a", x: 0, y: 0, w: 2, h: 2 }],
  ["clock", { x: 2, y: 1, w: 1, h: 1 }, 25, { id: "clock", x: 2, y: 1, w: 3, h: 2 }],
  ["clock", { x: 8, y: 1, w: 14, h: 4 }, 1, { id: "clock", x: 0, y: 1, w: 1, h: 4 }],
  ["saved", { x: 1.6, y: 2.4, w: 3.6, h: 4.4 }, 10, { id: "saved", x: 2, y: 2, w: 4, h: 4 }],
]) {
  test(`clampRect normalizes ${id} to ${JSON.stringify(want)}`, () => {
    assert.deepEqual(clampRect(id, Object.freeze(rect), cols), want);
  });
}

const chain = [
  { id: "group:a", x: 0, y: 0, w: 3, h: 4 },
  { id: "group:b", x: 0, y: 4, w: 3, h: 4 },
  { id: "group:c", x: 0, y: 8, w: 3, h: 2 },
];

test("place pushes overlapped tiles below and repeats without mutating its input", () => {
  const before = freezeTiles(structuredClone(chain));
  const after = place(before, "group:a", Object.freeze({ x: 0, y: 2, w: 3, h: 4 }), 25);
  assert.deepEqual(after, [
    { id: "group:a", x: 0, y: 2, w: 3, h: 4 },
    { id: "group:b", x: 0, y: 6, w: 3, h: 4 },
    { id: "group:c", x: 0, y: 10, w: 3, h: 2 },
  ]);
  assert.deepEqual(before, chain);
  assert.notEqual(after, before);
  assertNoOverlaps(after);
});

test("place keeps gaps when a tile moves away", () => {
  assert.deepEqual(place(chain, "group:a", { x: 5, y: 0, w: 3, h: 4 }, 25), [
    { id: "group:a", x: 5, y: 0, w: 3, h: 4 },
    chain[1], chain[2],
  ]);
});

test("place scans collisions in reading order rather than input order", () => {
  const tiles = [
    { id: "group:a", x: 4, y: 0, w: 2, h: 4 },
    { id: "group:c", x: 0, y: 4, w: 2, h: 2 },
    { id: "group:b", x: 0, y: 2, w: 2, h: 2 },
  ];
  const after = place(tiles, "group:a", { x: 0, y: 1, w: 2, h: 4 }, 6);
  assert.deepEqual(after, [
    { id: "group:a", x: 0, y: 1, w: 2, h: 4 },
    { id: "group:c", x: 0, y: 7, w: 2, h: 2 },
    { id: "group:b", x: 0, y: 5, w: 2, h: 2 },
  ]);
  assertNoOverlaps(after);
});

test("place resolves a long push chain even when input is reversed", () => {
  const before = freezeTiles(Array.from({ length: 200 }, (_, i) => ({
    id: `group:${i}`, x: 0, y: i * 2, w: 2, h: 2,
  })).reverse());
  const after = place(before, "group:0", { x: 0, y: 1, w: 2, h: 2 }, 2);
  for (const tile of after) {
    assert.equal(tile.y, Number(tile.id.slice(6)) * 2 + 1);
  }
  assertNoOverlaps(after);
});

test("place adds a new tile and clamps it to the minimum and column count", () => {
  assert.deepEqual(place([], "clock", { x: 23, y: -1, w: 5, h: 1 }, 25), [
    { id: "clock", x: 20, y: 0, w: 5, h: 2 },
  ]);
  assert.deepEqual(place([], "pinned", { x: 5, y: 0, w: 1, h: 1 }, 1), [
    { id: "pinned", x: 0, y: 0, w: 1, h: 1 },
  ]);
});

test("fit caps widths and moves overflow left only as far as needed", () => {
  const original = [
    { id: "pinned", x: 0, y: 0, w: 3, h: 4 },
    { id: "group:a", x: 8, y: 0, w: 4, h: 2 },
    { id: "saved", x: 0, y: 6, w: 14, h: 2 },
  ];
  const before = freezeTiles(structuredClone(original));
  const after = fit(before, 10);
  assert.deepEqual(after, [
    original[0],
    { id: "group:a", x: 6, y: 0, w: 4, h: 2 },
    { id: "saved", x: 0, y: 6, w: 10, h: 2 },
  ]);
  assert.deepEqual(before, original);
  assert.notEqual(after, before);
  assertNoOverlaps(after);
});

test("fit reserves fitting tiles before placing overflow in reading order", () => {
  const before = freezeTiles([
    { id: "group:c", x: 8, y: 0, w: 2, h: 2 },
    { id: "group:b", x: 6, y: 0, w: 2, h: 2 },
    { id: "pinned", x: 0, y: 0, w: 4, h: 2 },
    { id: "saved", x: 0, y: 3, w: 4, h: 2 },
  ]);
  const after = fit(before, 4);
  assert.deepEqual(after, [
    { id: "group:c", x: 2, y: 5, w: 2, h: 2 },
    { id: "group:b", x: 0, y: 5, w: 2, h: 2 },
    before[2], before[3],
  ]);
  assertNoOverlaps(after);
});

test("fit caps wide tiles and resolves a long narrow-screen overflow chain", () => {
  const before = freezeTiles(Array.from({ length: 100 }, (_, i) => ({
    id: `group:${i}`, x: 10 + i * 3, y: 0, w: 3, h: 2,
  })).reverse());
  const after = fit(before, 1);
  for (const tile of after) {
    assert.deepEqual(tile, { id: tile.id, x: 0, y: Number(tile.id.slice(6)) * 2, w: 1, h: 2 });
  }
  assertNoOverlaps(after);
  assert.deepEqual(fit([], 1), []);
});

const userLayout = [
  { id: "clock", x: 0, y: 0, w: 4, h: 2 },
  { id: "pinned", x: 0, y: 2, w: 4, h: 6 },
  { id: "group:dev-server", x: 10, y: 0, w: 5, h: 3 },
  { id: "group:coverage", x: 15, y: 0, w: 5, h: 3 },
  { id: "group:oce", x: 10, y: 3, w: 5, h: 3 },
  { id: "group:to-be-reviewed", x: 15, y: 3, w: 5, h: 3 },
  { id: "group:left-bottom", x: 10, y: 6, w: 5, h: 3 },
  { id: "group:harness", x: 15, y: 6, w: 5, h: 3 },
];

// Old first-free wrapping swaps neighbours even when an empty column can close.
for (const lost of [1, 5]) {
  test(`fit closes the user's gap at ${lost} fewer columns without swapping neighbours`, () => {
    const before = freezeTiles(structuredClone(userLayout));
    const after = fit(before, 20 - lost);
    assert.deepEqual(after, userLayout.map(tile => ({ ...tile, x: tile.x >= 10 ? tile.x - lost : tile.x })));
    assert.deepEqual(before, userLayout);
    assertNoOverlaps(after);
  });
}

test("fit removes only the needed empty columns, rightmost gap first", () => {
  const before = freezeTiles([
    { id: "left", x: 0, y: 0, w: 2, h: 2 },
    { id: "middle", x: 4, y: 0, w: 2, h: 2 },
    { id: "right", x: 9, y: 0, w: 2, h: 2 },
  ]);
  assert.deepEqual(fit(before, 10), [before[0], before[1], { ...before[2], x: 8 }]);
  assert.deepEqual(fit(before, 7), [before[0], { ...before[1], x: 3 }, { ...before[2], x: 5 }]);
  assert.deepEqual(fit(before, 11), before, "a fitting layout keeps every gap");
});

test("fit pushes only tiles in the way left by the minimum when no column is empty", () => {
  const before = freezeTiles([
    { id: "short", x: 0, y: 0, w: 2, h: 2 },
    { id: "middle", x: 3, y: 0, w: 3, h: 2 },
    { id: "right", x: 7, y: 0, w: 3, h: 2 },
    { id: "full-other-row", x: 0, y: 3, w: 10, h: 2 },
  ]);
  assert.deepEqual(fit(before, 8), [before[0], { ...before[1], x: 2 }, { ...before[2], x: 5 },
    { ...before[3], w: 8 }]);
});

test("fit wraps the trailing tile, not the left tiles, when a row cannot fit", () => {
  const before = freezeTiles([
    { id: "right", x: 5, y: 0, w: 3, h: 2 },
    { id: "left", x: 0, y: 0, w: 3, h: 2 },
    { id: "middle", x: 3, y: 0, w: 2, h: 2 },
  ]);
  assert.deepEqual(fit(before, 6), [{ ...before[0], x: 0, y: 2 }, before[1], before[2]]);
  const staggered = freezeTiles([
    { id: "right-tall", x: 6, y: 0, w: 3, h: 4 },
    { id: "left-lower", x: 3, y: 2, w: 3, h: 2 },
  ]);
  assert.deepEqual(fit(staggered, 5), [
    { ...staggered[0], x: 0, y: 4 }, { ...staggered[1], x: 0 },
  ], "the rightmost tile wraps even when it starts above its left neighbour");
});

test("fit drops an impossible tile's constraints before considering tiles further right", () => {
  const before = freezeTiles([
    { id: "left", x: 0, y: 0, w: 4, h: 2 },
    { id: "tall", x: 4, y: 0, w: 3, h: 4 },
    { id: "lower-right", x: 7, y: 2, w: 2, h: 2 },
  ]);
  assert.deepEqual(fit(before, 6), [before[0], { ...before[1], x: 0, y: 2 }, { ...before[2], x: 4 }]);
});

test("fit separates saved overlaps before capping widths, even outside the columns", () => {
  const before = freezeTiles([
    { id: "later", x: 9, y: 0, w: 1, h: 2 },
    { id: "earlier", x: 8, y: 0, w: 4, h: 2 },
  ]);
  assert.deepEqual(fit(before, 10), [{ ...before[0], x: 0 }, { ...before[1], x: 6 }]);
  assert.deepEqual(fit(before, 3), [{ ...before[0], x: 0, y: 2 }, { ...before[1], x: 0, w: 3 }]);
});

test("fit keeps random layouts inside the columns and non-overlapping without mutation", () => {
  let seed = 0x311f17;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let sample = 0; sample < 500; sample++) {
    const cols = 1 + random(20);
    const input = Array.from({ length: random(20) }, (_, i) => ({
      id: `tile:${i}`, x: random(40), y: random(20), w: 1 + random(24), h: 1 + random(6),
    }));
    const before = freezeTiles(structuredClone(input)), after = fit(before, cols);
    assert.deepEqual(before, input);
    assert.deepEqual(after.map(tile => tile.id), input.map(tile => tile.id));
    assertNoOverlaps(after);
    for (const tile of after) {
      assert.ok(tile.x >= 0 && tile.x + tile.w <= cols, `sample ${sample}, cols ${cols}: ${JSON.stringify(tile)}`);
      assert.equal(tile.h, input.find(original => original.id === tile.id).h);
    }
    assert.deepEqual(fit(before, cols), after, "fit is deterministic");
  }
});

test("firstFree scans rows then columns and respects its starting row", () => {
  const tiles = freezeTiles([{ id: "pinned", x: 0, y: 0, w: 2, h: 2 }]);
  assert.deepEqual(firstFree(tiles, { w: 2, h: 2 }, 5), { x: 2, y: 0 });
  assert.deepEqual(firstFree(tiles, { w: 4, h: 2 }, 5), { x: 0, y: 2 });
  assert.deepEqual(firstFree(tiles, { w: 2, h: 2 }, 5, 4), { x: 0, y: 4 });
  assert.deepEqual(firstFree([], { w: 5, h: 2 }, 1), { x: 0, y: 0 });
});

test("addMissing places only new ids without moving existing tiles or duplicating ids", () => {
  const tiles = freezeTiles([{ id: "pinned", x: 0, y: 4, w: 3, h: 4 }]);
  assert.deepEqual(addMissing(tiles, ["pinned", "group:a", "group:a", "saved"], 25, 80), [
    tiles[0],
    { id: "group:a", x: 0, y: 0, w: 3, h: 4 },
    { id: "saved", x: 3, y: 0, w: 3, h: 4 },
  ]);
});

for (const key of ["x", "y", "w", "h"]) {
  test(`changedTiles detects a changed ${key} regardless of array order`, () => {
    const before = freezeTiles(structuredClone(chain));
    const changed = { ...before[0], [key]: before[0][key] + 1 };
    const after = freezeTiles([before[2], changed, before[1]]);
    assert.deepEqual(changedTiles(before, after), [changed]);
  });
}

test("changedTiles includes new tiles but not removed or unchanged tiles", () => {
  const added = { id: "clock", x: 5, y: 0, w: 5, h: 2 };
  assert.deepEqual(changedTiles(chain, [chain[1], added]), [added]);
  assert.deepEqual(changedTiles(chain, structuredClone(chain)), []);
});

test("fit shows overlapping saved tiles apart: the earlier tile in reading order stays", () => {
  // Two devices commit at once: A moved x and pushed y; B moved z onto y's new rows.
  const merged = freezeTiles([
    { id: "group:x", x: 0, y: 2, w: 3, h: 4 },
    { id: "group:y", x: 0, y: 6, w: 3, h: 4 },
    { id: "group:z", x: 0, y: 8, w: 3, h: 4 },
  ]);
  const after = fit(merged, 25);
  assertNoOverlaps(after);
  assert.deepEqual(after, [
    { id: "group:x", x: 0, y: 2, w: 3, h: 4 },
    { id: "group:y", x: 0, y: 6, w: 3, h: 4 },
    { id: "group:z", x: 3, y: 8, w: 3, h: 4 },
  ]);
});

test("fit breaks ties at the same cell by id, whatever the input order", () => {
  const a = { id: "group:a", x: 0, y: 0, w: 3, h: 4 };
  const b = { id: "group:b", x: 0, y: 0, w: 3, h: 4 };
  for (const input of [[a, b], [b, a]]) {
    const after = fit(freezeTiles(structuredClone(input)), 25);
    assert.deepEqual(after.find(tile => tile.id === "group:a"), a);
    assert.deepEqual(after.find(tile => tile.id === "group:b"), { ...b, x: 3 });
  }
});

test("a column count that is not a positive integer is treated as one column", () => {
  assert.deepEqual(addMissing([], ["group:a"], NaN, 80), [{ id: "group:a", x: 0, y: 0, w: 1, h: 4 }]);
  assert.deepEqual(firstFree([], { w: 3, h: 2 }, 0), { x: 0, y: 0 });
  assert.deepEqual(clampRect("group:a", { x: 4, y: 0, w: 3, h: 2 }, undefined), { id: "group:a", x: 0, y: 0, w: 1, h: 2 });
});

test("clampRect maps non-finite fields to the minimum", () => {
  assert.deepEqual(
    clampRect("group:a", { x: NaN, y: Infinity, w: NaN, h: -Infinity }, 10),
    { id: "group:a", x: 0, y: 0, w: 2, h: 2 },
  );
});

test("firstFree normalises a NaN width, height and starting row", () => {
  assert.deepEqual(firstFree([], { w: NaN, h: NaN }, 5, NaN), { x: 0, y: 0 });
  assert.deepEqual(firstFree([{ id: "a", x: 0, y: 0, w: 5, h: 2 }], { w: NaN, h: 1 }, 5), { x: 0, y: 2 });
});
