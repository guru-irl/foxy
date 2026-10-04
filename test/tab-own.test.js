import { test } from "node:test";
import assert from "node:assert/strict";

test("Foxy tab ownership expires at thirty seconds and re-marking renews it", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const { markOwn, isOwn } = await import("../extension/src/tabs/own.js");
  assert.equal(isOwn(987654), false);
  markOwn(987654); assert.equal(isOwn(987654), true);
  t.mock.timers.tick(29999); assert.equal(isOwn(987654), true);
  t.mock.timers.tick(1); assert.equal(isOwn(987654), false);
  markOwn(987654); t.mock.timers.tick(20000); markOwn(987654);
  t.mock.timers.tick(10000); assert.equal(isOwn(987654), true);
  t.mock.timers.tick(20000); assert.equal(isOwn(987654), false);
});
