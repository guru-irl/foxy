import { test } from "node:test";
import assert from "node:assert/strict";
import { fit, place, gestureWrites, clampRect, overlaps } from "../extension/src/grid/layout.js";

test("gestureWrites: a release that changes nothing on screen writes nothing, even where the fit moved tiles", () => {
  const saved = [{ id: "clock", x: 0, y: 0, w: 4, h: 2 }, { id: "group:a", x: 10, y: 0, w: 5, h: 3 }];
  const shown = fit(saved, 12);
  assert.deepEqual(shown.find(t => t.id === "group:a"), { id: "group:a", x: 7, y: 0, w: 5, h: 3 }, "fit closed the gap");
  assert.deepEqual(gestureWrites(shown, saved, shown.map(t => ({ ...t }))), []);
});

test("gestureWrites: a real change writes every shown tile that differs from its saved place", () => {
  const saved = [{ id: "clock", x: 0, y: 0, w: 4, h: 2 }, { id: "group:a", x: 10, y: 0, w: 5, h: 3 },
    { id: "group:b", x: 10, y: 3, w: 5, h: 3 }];
  const shown = fit(saved, 12);
  const placed = place(shown, "clock", { x: 0, y: 6, w: 4, h: 2 }, 12);
  assert.deepEqual(gestureWrites(shown, saved, placed), [
    { id: "clock", x: 0, y: 6, w: 4, h: 2 },
    { id: "group:a", x: 7, y: 0, w: 5, h: 3 },
    { id: "group:b", x: 7, y: 3, w: 5, h: 3 },
  ]);
});

test("gestureWrites: shown tiles with no saved place count as saved where shown", () => {
  const shown = [{ id: "clock", x: 0, y: 0, w: 4, h: 2 }, { id: "group:new", x: 4, y: 0, w: 3, h: 4 }];
  const placed = place(shown, "clock", { x: 0, y: 4, w: 4, h: 2 }, 12);
  assert.deepEqual(gestureWrites(shown, [{ id: "clock", x: 0, y: 0, w: 4, h: 2 }], placed),
    [{ id: "clock", x: 0, y: 4, w: 4, h: 2 }]);
});

// Mixing unchanged saved rectangles with changed display rectangles violates this property.
test("gesture writes refit to the target without overlaps across seeded layouts", () => {
  let seed = 7;
  const rnd = max => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % max; };
  for (let sample = 0; sample < 5000; sample++) {
    const cols = 1 + rnd(30);
    const saved = Array.from({ length: 1 + rnd(20) }, (_, i) => ({
      id: i === 0 ? "clock" : `group:${i}`, x: rnd(60), y: rnd(25), w: 1 + rnd(40), h: 1 + rnd(15),
    }));
    const visible = fit(saved, cols), tile = visible[rnd(visible.length)];
    const target = { x: rnd(60), y: rnd(30), w: 1 + rnd(40), h: 1 + rnd(15) };
    const placed = place(visible, tile.id, target, cols);
    const writes = gestureWrites(visible, saved, placed);
    const layout = [...new Map([...saved, ...writes].map(t => [t.id, t])).values()];
    const released = fit(layout, cols);
    const context = `seed=7 sample=${sample} cols=${cols} id=${tile.id}`;
    assert.deepEqual(released.find(t => t.id === tile.id), clampRect(tile.id, target, cols), context);
    assert.deepEqual(released, placed, `${context}: preview equals release`);
    for (let i = 0; i < released.length; i++) for (let j = i + 1; j < released.length; j++) {
      assert.ok(!overlaps(released[i], released[j]), `${context}: ${released[i].id} overlaps ${released[j].id}`);
    }
  }
});
