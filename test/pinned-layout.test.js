import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMissing, clampRect, place } from '../extension/src/grid/layout.js';

for (const cell of [48, 73, 240]) {
  test(`new pinned tile occupies six by two cells at target ${cell}`, () => {
    assert.deepEqual(addMissing([], ['pinned'], 10, cell), [{ id: 'pinned', x: 0, y: 0, w: 6, h: 2 }]);
    assert.deepEqual(addMissing([], ['pinned'], 4, cell), [{ id: 'pinned', x: 0, y: 0, w: 4, h: 2 }]);
  });
}
test('pinned placement accepts one cell and pushes its neighbour without enlarging the pin tile', () => {
  assert.deepEqual(clampRect('pinned', { x: 1, y: 1, w: 0, h: 0 }, 5), { id: 'pinned', x: 1, y: 1, w: 1, h: 1 });
  assert.deepEqual(place([{ id: 'pinned', x: 0, y: 0, w: 6, h: 2 },
    { id: 'saved', x: 1, y: 1, w: 2, h: 2 }], 'pinned', { x: 1, y: 1, w: 1, h: 1 }, 10),
  [{ id: 'pinned', x: 1, y: 1, w: 1, h: 1 }, { id: 'saved', x: 1, y: 2, w: 2, h: 2 }]);
});
