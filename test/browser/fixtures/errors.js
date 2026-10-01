import { test, assert, fixture, dispatchDrag } from "../harness.js";

Promise.reject(new Error("import rejection exploded"));
await new Promise(resolve => setTimeout(resolve, 0));

test("throwing drag handler", () => {
  fixture().addEventListener("dragstart", () => { throw new Error("drag handler exploded"); });
  dispatchDrag("dragstart", fixture());
});

test("rejecting async handler", () => {
  fixture().addEventListener("dragover", async () => { throw new Error("async handler exploded"); });
  dispatchDrag("dragover", fixture());
});

test("tests continue after handler errors", () => {
  assert.equal(fixture().childElementCount, 0);
});
