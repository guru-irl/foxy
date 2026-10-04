import { test } from "node:test";
import assert from "node:assert/strict";
import { PendingLayoutWrites, showPending } from "../extension/src/grid/pending.js";
const clock = { id: "clock", x: 0, y: 1, w: 6, h: 4 };
const local = { id: "local:2", x: 0, y: 8, w: 5, h: 6 };

test("pending mapping writes a captured full visible batch at its release width", () => {
  const pending = new PendingLayoutWrites();
  pending.capture({ k: 17, writes: [clock, local] });
  assert.deepEqual([...pending.resolve({}).batches], []);
  const ready = pending.resolve({ 2: "oce" });
  assert.deepEqual([...ready.batches], [[17, [clock, { ...local, id: "group:oce" }]]]);
  assert.deepEqual([...ready.groups], [2]);
  assert.deepEqual([...pending.resolve({ 2: "oce" }).batches], []);
});
test("a later gesture updates the captured batch and partial mappings never write local ids", () => {
  const pending = new PendingLayoutWrites(), another = { ...local, id: "local:3", y: 14 };
  pending.capture({ k: 17, writes: [clock, local, another] });
  pending.capture({ k: 17, writes: [{ ...clock, y: 2 }] });
  assert.deepEqual([...pending.resolve({ 2: "oce" }).batches], [[17, [{ ...clock, y: 2 }, { ...local, id: "group:oce" }]]]);
  assert.deepEqual([...pending.resolve({ 2: "oce", 3: "new" }).batches], [[17, [
    { ...clock, y: 2 }, { ...local, id: "group:oce" }, { ...another, id: "group:new" },
  ]]]);
});
test("eviction, Reset and group removal discard pending writes before mappings arrive", () => {
  const pending = new PendingLayoutWrites();
  pending.capture({ k: 17, writes: [clock, local] }); pending.discard(17);
  assert.deepEqual([...pending.resolve({ 2: "oce" }).batches], []);
  pending.capture({ k: 17, writes: [clock, local] }); pending.clear();
  assert.deepEqual([...pending.resolve({ 2: "oce" }).batches], []);
  pending.capture({ k: 17, writes: [clock, local] }); pending.removeGroup(2);
  assert.deepEqual([...pending.resolve({ 2: "oce" }).batches], []);
});

test("a target awaiting an authoritative removal check keeps its snapshot without resolving it", () => {
  const pending = new PendingLayoutWrites(); pending.capture({ k: 17, writes: [clock, local] });
  assert.deepEqual([...pending.resolve({ 2: "oce" }, new Set([17])).batches], []);
  assert.deepEqual([...pending.resolve({ 2: "oce" }).batches], [[17, [clock, { ...local, id: "group:oce" }]]]);
});

// DOM (and so keyboard) order follows the board's reading order; an unknown kind would sort first.
test("displayed tiles are ordered clock, pinned, groups, saved, memory, weather", () => {
  const rect = (id, x) => ({ id, x, y: 0, w: 1, h: 1 });
  const board = { columns: [{ id: 2 }] };
  const next = { cols: 20, tiles: [rect("weather", 0), rect("memory", 1), rect("saved", 2), rect("group:oce", 3), rect("pinned", 4), rect("clock", 5)] };
  showPending(board, { 2: "oce" }, next, new Map());
  assert.deepEqual(next.tiles.map(t => t.id), ["clock", "pinned", "group:oce", "saved", "memory", "weather"]);
});
