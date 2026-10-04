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
test("derive squeezes the real layout at 33 without moving rows or separating stacks", () => {
  assert.deepEqual(layouts.derive(realLayout, 34, 33), [
    { id: "clock", x: 0, y: 0, w: 6, h: 4 }, { id: "pinned", x: 0, y: 4, w: 6, h: 3 },
    { id: "group:tbr", x: 6, y: 0, w: 7, h: 9 }, { id: "group:dev", x: 13, y: 0, w: 6, h: 9 },
    { id: "group:cov", x: 19, y: 0, w: 7, h: 9 }, { id: "group:oce", x: 26, y: 0, w: 7, h: 9 },
    { id: "group:harness", x: 19, y: 9, w: 7, h: 8 }, { id: "group:telemetry", x: 26, y: 9, w: 7, h: 8 },
  ]);
});
test("derive squeezes the real layout at 28 with every width at least five", () => {
  const result = layouts.derive(realLayout, 34, 28);
  assert.deepEqual(result, [
    { id: "clock", x: 0, y: 0, w: 5, h: 4 }, { id: "pinned", x: 0, y: 4, w: 5, h: 3 },
    { id: "group:tbr", x: 5, y: 0, w: 6, h: 9 }, { id: "group:dev", x: 11, y: 0, w: 5, h: 9 },
    { id: "group:cov", x: 16, y: 0, w: 6, h: 9 }, { id: "group:oce", x: 22, y: 0, w: 6, h: 9 },
    { id: "group:harness", x: 16, y: 9, w: 6, h: 8 }, { id: "group:telemetry", x: 22, y: 9, w: 6, h: 8 },
  ]);
  assert.ok(result.every(t => t.w >= 5));
});
test("derive keeps a fitting arrangement before trying squeeze", () => {
  const gaps = [{ id: "a", x: 0, y: 3, w: 3, h: 2 }, { id: "b", x: 7, y: 3, w: 3, h: 2 }];
  assert.deepEqual(layouts.derive(gaps, 10, 9), [gaps[0], { ...gaps[1], x: 6 }]);
});
test("derive squeezes using the normalized right edge, not the saved column count", () => {
  const tiles = [{ id: "group:a", x: 0, y: 3, w: 5, h: 2 }, { id: "group:b", x: 5, y: 3, w: 5, h: 2 }];
  assert.deepEqual(layouts.derive(tiles, 20, 8), [
    { id: "group:a", x: 0, y: 3, w: 4, h: 2 }, { id: "group:b", x: 4, y: 3, w: 4, h: 2 },
  ]);
});
test("derive rejects squeeze below the clock minimum even when the 70 percent limit passes", () => {
  const tiles = [{ id: "clock", x: 0, y: 0, w: 3, h: 2 }, { id: "group:a", x: 3, y: 0, w: 5, h: 2 }];
  assert.deepEqual(layouts.derive(tiles, 8, 6), [tiles[0], { ...tiles[1], x: 0, y: 2 }]);
  assert.deepEqual(layouts.derive(tiles, 8, 7), [tiles[0], { ...tiles[1], w: 4 }]);
});
test("derive rejects all of squeeze if any tile misses its rounded 70 percent width", () => {
  const tiles = [{ id: "group:a", x: 0, y: 0, w: 8, h: 2 }, { id: "group:b", x: 8, y: 0, w: 8, h: 2 }];
  for (const c of [10, 11]) {
    assert.deepEqual(layouts.derive(tiles, 16, c), [tiles[0], { ...tiles[1], x: 0, y: 2 }]);
  }
  assert.deepEqual(layouts.derive(tiles, 16, 12), [
    { id: "group:a", x: 0, y: 0, w: 6, h: 2 }, { id: "group:b", x: 6, y: 0, w: 6, h: 2 },
  ]);
});
test("derive accepts widths equal to rounded 70 percent even when the exact ratio is smaller", () => {
  const tiles = [{ id: "group:a", x: 0, y: 0, w: 7, h: 2 }, { id: "group:b", x: 7, y: 0, w: 7, h: 2 }];
  assert.deepEqual(layouts.derive(tiles, 14, 10), [
    { id: "group:a", x: 0, y: 0, w: 5, h: 2 }, { id: "group:b", x: 5, y: 0, w: 5, h: 2 },
  ]);
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
  for (let trial = 0; trial < 600; trial++) {
    let c, k, input;
    if (trial < 500) {
      c = 1 + random(30); k = c + 1 + random(40);
      input = Array.from({ length: 1 + random(30) }, (_, i) =>
        ({ id: `group:${i}`, x: random(k), y: random(25), w: 1 + random(k), h: 1 + random(10) }));
    } else {
      // Adjacent full rows force squeeze; these widths survive losing one column.
      const widths = Array.from({ length: 2 + random(5) }, () => 6 + random(5));
      k = widths.reduce((sum, w) => sum + w, 0); c = k - 1;
      let x = 0;
      input = widths.flatMap((w, i) => {
        const pair = [{ id: `group:${i}:top`, x, y: 0, w, h: 3 },
          { id: `group:${i}:bottom`, x, y: 3, w, h: 2 }];
        x += w; return pair;
      });
    }
    const original = structuredClone(input), result = layouts.derive(input, k, c);
    assert.deepEqual(input, original);
    assert.deepEqual(result, layouts.derive(input, k, c));
    assert.deepEqual(result.map(t => t.id).sort(), input.map(t => t.id).sort());
    assert.ok(result.every(t => t.x >= 0 && t.y >= 0 && t.x + t.w <= c), `bounds trial ${trial}`);
    assert.ok(result.every((t, i) => result.slice(i + 1).every(u => !overlaps(t, u))), `overlap trial ${trial}`);
    if (trial >= 500) {
      assert.deepEqual(result.map(t => [t.y, t.h]), input.map(t => [t.y, t.h]), `squeeze rows trial ${trial}`);
      assert.ok(result.every((t, i) => t.w >= Math.round(0.7 * input[i].w)), `squeeze width trial ${trial}`);
    }
  }
});
test("source choice fills width from the smallest keepable/squeezable wider layout before narrower fallbacks", () => {
  const narrow = [{ id: "clock", x: 0, y: 0, w: 6, h: 4 }];
  const available = { 17: { tiles: narrow }, 34: { tiles: realLayout } };
  for (let c = 18; c <= 33; c++) assert.equal(layouts.sourceLayout(available, c), c >= 24 ? 34 : 17, `columns ${c}`);
  assert.equal(layouts.sourceLayout(available, 17), 17);
  assert.equal(layouts.sourceLayout(available, 34), 34);
  assert.equal(layouts.sourceLayout(available, 35), 34);
  assert.equal(layouts.sourceLayout({}, 17), 17);
  assert.equal(layouts.sourceLayout({ 34: { tiles: realLayout } }, 17), 34);
  // Exact wins over a wider fit; otherwise the smallest qualifying wider wins,
  // even across equal distances to the narrower and wider widths.
  const ties = { 30: { tiles: narrow }, 34: { tiles: realLayout }, 35: { tiles: realLayout } };
  assert.equal(layouts.sourceLayout(ties, 30), 30);
  assert.equal(layouts.sourceLayout(ties, 32), 34);
  assert.equal(layouts.sourceLayout(ties, 33), 34);
  assert.equal(layouts.sourceLayout({ 17: { tiles: narrow }, 20: { tiles: narrow }, 34: { tiles: realLayout } }, 23), 20);
});
test("real layout now squeezes at 25 columns with rounded 70 percent widths", () => {
  assert.deepEqual(layouts.derive(realLayout, 34, 25), [
    { id: "clock", x: 0, y: 0, w: 4, h: 4 }, { id: "pinned", x: 0, y: 4, w: 4, h: 3 },
    { id: "group:tbr", x: 4, y: 0, w: 6, h: 9 }, { id: "group:dev", x: 10, y: 0, w: 5, h: 9 },
    { id: "group:cov", x: 15, y: 0, w: 5, h: 9 }, { id: "group:oce", x: 20, y: 0, w: 5, h: 9 },
    { id: "group:harness", x: 15, y: 9, w: 5, h: 8 }, { id: "group:telemetry", x: 20, y: 9, w: 5, h: 8 },
  ]);
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
