import { test } from "node:test";
import assert from "node:assert/strict";
import * as layouts from "../extension/src/grid/layouts.js";
import { overlaps } from "../extension/src/grid/layout.js";

export const realLayout = [
  { id: "clock", x: 0, y: 0, w: 6, h: 4 }, { id: "pinned", x: 0, y: 4, w: 6, h: 3 },
  ...["tbr", "dev", "cov", "oce"].map((id, i) => ({ id: `group:${id}`, x: 6 + i * 7, y: 0, w: 7, h: 9 })),
  { id: "group:harness", x: 20, y: 9, w: 7, h: 8 }, { id: "group:telemetry", x: 27, y: 9, w: 7, h: 8 },
];
const xy = tiles => tiles.map(({ x, y }) => [x, y]);

test("derive keeps the real columns together at 17 and packs in left-edge order", () => {
  assert.equal(typeof layouts.derive, "function");
  assert.deepEqual(xy(layouts.derive(realLayout, 34, 17)),
    [[0, 0], [0, 4], [6, 0], [0, 9], [7, 9], [0, 18], [7, 18], [0, 27]]);
});
test("derive packs the real layout at 33, but keeps a fitting arrangement without packing", () => {
  assert.equal(typeof layouts.derive, "function");
  assert.deepEqual(xy(layouts.derive(realLayout, 34, 33)),
    [[0, 0], [0, 4], [6, 0], [13, 0], [20, 0], [0, 9], [20, 9], [0, 18]]);
  const gaps = [{ id: "a", x: 0, y: 3, w: 3, h: 2 }, { id: "b", x: 7, y: 3, w: 3, h: 2 }];
  assert.deepEqual(xy(layouts.derive(gaps, 10, 9)), [[0, 3], [6, 3]]);
});
test("derive repairs overlaps and fits a transitive stack wider than the window", () => {
  assert.equal(typeof layouts.derive, "function");
  const tiles = [{ id: "a", x: 0, y: 0, w: 5, h: 2 }, { id: "b", x: 4, y: 0, w: 5, h: 2 },
    { id: "c", x: 8, y: 2, w: 5, h: 2 }, { id: "d", x: 0, y: 6, w: 5, h: 2 }];
  const result = layouts.derive(tiles, 13, 4);
  assert.equal(result.length, 4);
  assert.ok(result.every(t => t.x >= 0 && t.x + t.w <= 4));
  assert.ok(result.every((t, i) => result.slice(i + 1).every(u => !overlaps(t, u))));
});
test("derive seeded property: all inputs once, bounded, clear, deterministic, immutable", () => {
  assert.equal(typeof layouts.derive, "function");
  let seed = 32004;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let trial = 0; trial < 500; trial++) {
    const c = 1 + random(30), k = c + 1 + random(40);
    const input = Array.from({ length: 1 + random(30) }, (_, i) =>
      ({ id: `group:${i}`, x: random(k), y: random(25), w: 1 + random(k), h: 1 + random(10) }));
    const original = structuredClone(input), result = layouts.derive(input, k, c);
    assert.deepEqual(input, original);
    assert.deepEqual(result, layouts.derive(input, k, c));
    assert.deepEqual(result.map(t => t.id).sort(), input.map(t => t.id).sort());
    assert.ok(result.every(t => t.x >= 0 && t.y >= 0 && t.x + t.w <= c), `bounds trial ${trial}`);
    assert.ok(result.every((t, i) => result.slice(i + 1).every(u => !overlaps(t, u))), `overlap trial ${trial}`);
  }
});
test("sourceLayout prefers exact, then largest narrower, then smallest wider", () => {
  assert.equal(typeof layouts.sourceLayout, "function");
  for (const [available, c, want] of [[{}, 17, 17], [{ 17: 1, 34: 2 }, 17, 17],
    [{ 10: 1, 17: 2, 34: 3 }, 33, 17], [{ 20: 1, 34: 2 }, 17, 20]]) {
    assert.equal(layouts.sourceLayout(available, c), want);
  }
});
test("targetLayout updates the source only when placed tiles fit its width, with no-op release ignored", () => {
  assert.equal(typeof layouts.targetLayout, "function");
  const saved = [{ id: "clock", x: 0, y: 0, w: 6, h: 4 }];
  const placed = [{ ...saved[0], y: 2 }];
  for (const [k, c, want] of [[34, 34, 34], [34, 35, 34], [34, 17, 17]]) {
    assert.deepEqual(layouts.targetLayout(saved, saved, placed, k, c), { k: want, writes: placed });
  }
  const edge = [{ ...saved[0], x: 29 }];
  assert.deepEqual(layouts.targetLayout(saved, saved, edge, 34, 35), { k: 35, writes: edge });
  assert.deepEqual(layouts.targetLayout(saved, saved, saved, 34, 17), { k: 34, writes: [] });
});
test("new target layouts hold every visible tile, not hidden saved tiles", () => {
  assert.equal(typeof layouts.targetLayout, "function");
  const shown = [{ id: "clock", x: 0, y: 0, w: 6, h: 4 }, { id: "pinned", x: 0, y: 4, w: 6, h: 3 }];
  const saved = [...shown, { id: "saved", x: 20, y: 0, w: 7, h: 8 }];
  const placed = [shown[0], { ...shown[1], y: 5 }];
  assert.deepEqual(layouts.targetLayout(shown, saved, placed, 34, 17), { k: 17, writes: placed });
});
test("migrateLegacy uses max right edge, excludes width keys and malformed tiles, without mutating", () => {
  assert.equal(typeof layouts.migrateLegacy, "function");
  const entries = { "tile:clock": { x: 0, y: 0, w: 6, h: 4 },
    "tile:group:a": { x: 27, y: 0, w: 7, h: 9 }, "tile:17:pinned": { x: 0, y: 4, w: 6, h: 3 },
    "tile:saved": { x: -1, y: 0, w: 3, h: 4 }, unrelated: 1 };
  const original = structuredClone(entries);
  assert.deepEqual(layouts.migrateLegacy(entries), { k: 34, keys: ["tile:clock", "tile:group:a"], tiles: [
    { id: "clock", x: 0, y: 0, w: 6, h: 4 }, { id: "group:a", x: 27, y: 0, w: 7, h: 9 },
  ] });
  assert.deepEqual(layouts.migrateLegacy({}), null);
  assert.deepEqual(entries, original);
});
