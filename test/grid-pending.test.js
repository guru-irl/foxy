import { test } from "node:test";
import assert from "node:assert/strict";
import { PendingLayoutWrites } from "../extension/src/grid/pending.js";
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
