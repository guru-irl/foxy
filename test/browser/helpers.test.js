import { test, assert, fixture, dispatchDrag } from "./harness.js";

test("dispatchDrag supplies writable DataTransfer by default", () => {
  fixture().addEventListener("dragstart", event => {
    assert.ok(event.dataTransfer instanceof DataTransfer);
    event.dataTransfer.setData("text/plain", "default drag");
  });
  const event = dispatchDrag("dragstart", fixture());
  assert.ok(event.dataTransfer instanceof DataTransfer);
  assert.equal(event.dataTransfer.getData("text/plain"), "default drag");
});

test("dispatchDrag forwards remaining DragEvent options", () => {
  const relatedTarget = document.createElement("span");
  fixture().append(relatedTarget);
  const event = dispatchDrag("dragover", fixture(), {
    relatedTarget, buttons: 1, button: 0,
    ctrlKey: true, altKey: true, shiftKey: true, metaKey: true,
    clientX: 23, clientY: 45,
  });
  assert.equal(event.relatedTarget, relatedTarget);
  assert.equal(event.buttons, 1);
  for (const key of ["ctrlKey", "altKey", "shiftKey", "metaKey"]) assert.equal(event[key], true);
  assert.equal(event.clientX, 23);
  assert.equal(event.clientY, 45);
  assert.equal(event.bubbles, true);
  assert.equal(event.cancelable, true);
});
