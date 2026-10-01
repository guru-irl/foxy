import { test, assert, fixture, dispatchDrag, nextFrame } from "./harness.js";
import { createFirefox } from "../fakes/firefox.js";

test("Firefox fake moves a tab in a browser page", async () => {
  const ff = createFirefox({ tabs: [{ id: 1, windowId: 1 }, { id: 2, windowId: 1 }] });
  await ff.browser.tabs.move(1, { index: 1 });
  assert.deepEqual((await ff.browser.tabs.query({ windowId: 1 })).map(tab => tab.id), [2, 1]);
  assert.equal((await ff.browser.tabs.get(1)).index, 1);
  await assert.rejects(ff.browser.tabs.get(99), /Invalid tab ID/);
  const element = fixture();
  assert.equal(element.id, "fixture");
  assert.equal(element.childElementCount, 0);
  element.append(document.createElement("span"));
  await nextFrame();
});

test("dragstart carries DataTransfer data to a listener", () => {
  const root = fixture();
  assert.equal(root.childElementCount, 0);
  const element = document.createElement("div");
  element.draggable = true;
  root.append(element);
  const dataTransfer = new DataTransfer();
  dataTransfer.setData("text/plain", "foxy-tab:1");
  let received;
  root.addEventListener("dragstart", event => {
    received = event.dataTransfer.getData("text/plain");
    event.preventDefault();
  });
  const event = dispatchDrag("dragstart", element, { clientX: 12, clientY: 34, dataTransfer });
  assert.ok(event instanceof DragEvent);
  assert.equal(event.target, element);
  assert.equal(event.clientX, 12);
  assert.equal(event.clientY, 34);
  assert.equal(event.bubbles, true);
  assert.equal(event.cancelable, true);
  assert.equal(event.defaultPrevented, true);
  assert.equal(received, "foxy-tab:1");
});
