import { test, assert, fixture, nextFrame } from "./harness.js";
import { createBoardFirefox } from "./controller.js";
import { createController } from "../../extension/src/main.js";

let css;
async function frames() {
  if (document.querySelector(".grid.settling")) await new Promise(resolve => setTimeout(resolve, 330));
  for (let i = 0; i < 5; i++) await nextFrame();
}
async function flush(ff) { await frames(); for (let i = 0; i < 5; i++) { await ff.settle(); await nextFrame(); } }
const tile = node => node.querySelector('[data-tile-id="clock"]');
const rect = node => ({ x: Number(node.style.getPropertyValue("--x")), y: Number(node.style.getPropertyValue("--y")),
  w: Number(node.style.getPropertyValue("--w")), h: Number(node.style.getPropertyValue("--h")) });
const writes = ff => ff.calls.filter(call => call.api === "storage.sync.set").map(call => call.args[0]);
function pointer(type, target, coords) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1,
    pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, ...coords }));
}
function drag(node, resize = false, dx = 0, dy = 300) {
  const source = tile(node).querySelector(resize ? ".tile-resize" : ".tile-header");
  const box = source.getBoundingClientRect();
  const start = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
  const end = { clientX: start.clientX + dx, clientY: start.clientY + dy };
  pointer("pointerdown", source, start); pointer("pointermove", document, end); pointer("pointerup", document, end);
}
async function setup() {
  css ??= new Promise(resolve => {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/extension/newtab.css";
    link.onload = resolve; document.head.append(link);
  });
  await css;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ff = createBoardFirefox({ windows: [{ id: 1, focused: true }], selfTabId: 99,
    groups: [{ id: 1, windowId: 1, title: "A" }],
    tabs: [{ id: 10, windowId: 1, groupId: 1 }, { id: 99, windowId: 1 }] },
    message => message.type === "foxy:reconcile" ? { ok: true }
      : message.type === "foxy:saved" ? gate.then(() => ({ saved: [], missing: [], folders: { 1: "a" } })) : undefined);
  await ff.browser.storage.sync.set({ "tile:clock": { x: 0, y: 0, w: 5, h: 2 } });
  const host = document.createElement("div"), node = document.createElement("div"), pane = document.createElement("aside");
  host.className = "page"; host.style.cssText = "width:1232px;height:600px";
  node.className = "board";
  pane.className = "settings-pane"; pane.hidden = true; host.append(node, pane); fixture().append(host);
  createController(node, ff.browser).refresh();
  const deadline = performance.now() + 2000;
  while (!tile(node) && performance.now() < deadline) await nextFrame();
  assert.ok(tile(node), "clock paints after the 500 ms first-reply wait");
  ff.calls.length = 0;
  return { ff, node, pane, release };
}

// Based on the final reviewer's delayed-reply probe. Missing held writes lets
// the first reply's new-tile save trigger a re-read that reverts the clock.
test("a clock move before the first valid saved reply is shown and persisted with new tiles", async () => {
  const { ff, node, release } = await setup();
  try {
    drag(node); await frames();
    assert.deepEqual(rect(tile(node)), { x: 0, y: 3, w: 5, h: 2 });
    assert.deepEqual(writes(ff), [], "automatic and user tile writes wait for the reply");
    release(); await flush(ff);
    assert.deepEqual((await ff.browser.storage.sync.get("tile:clock"))["tile:clock"], { x: 0, y: 3, w: 5, h: 2 });
    assert.equal(writes(ff).length, 1, "held and new tiles share one save");
    assert.ok(writes(ff)[0]["tile:pinned"]); assert.ok(writes(ff)[0]["tile:group:a"]);
    await ff.browser.storage.sync.set({ settings: { showDate: false } }); await flush(ff);
    assert.deepEqual(rect(tile(node)), { x: 0, y: 3, w: 5, h: 2 });
  } finally { release(); }
});

test("a held clock resize is saved at its committed size when the reply arrives", async () => {
  const { ff, node, release } = await setup();
  try {
    drag(node, true, 96, 96); await frames();
    assert.deepEqual(rect(tile(node)), { x: 0, y: 0, w: 6, h: 3 });
    assert.deepEqual(writes(ff), []);
    release(); await flush(ff);
    assert.deepEqual((await ff.browser.storage.sync.get("tile:clock"))["tile:clock"], { x: 0, y: 0, w: 6, h: 3 });
    assert.deepEqual(rect(tile(node)), { x: 0, y: 0, w: 6, h: 3 });
  } finally { release(); }
});

test("the last held move wins and remains shown over a remote change before the reply", async () => {
  const { ff, node, release } = await setup();
  try {
    drag(node); await frames();
    drag(node, false, 0, 96); await frames();
    assert.deepEqual(rect(tile(node)), { x: 0, y: 4, w: 5, h: 2 });
    await ff.browser.storage.sync.set({ "tile:clock": { x: 0, y: 8, w: 5, h: 2 } });
    ff.settle(); await frames();
    assert.deepEqual(rect(tile(node)), { x: 0, y: 4, w: 5, h: 2 }, "held move stays shown during the remote re-read");
    ff.calls.length = 0;
    release(); await flush(ff);
    assert.deepEqual((await ff.browser.storage.sync.get("tile:clock"))["tile:clock"], { x: 0, y: 4, w: 5, h: 2 });
    assert.equal(writes(ff).length, 1);
    await ff.browser.storage.sync.set({ settings: { showDate: false } }); await flush(ff);
    assert.deepEqual(rect(tile(node)), { x: 0, y: 4, w: 5, h: 2 });
  } finally { release(); }
});

test("reset before the reply clears held moves and saves fresh default placements", async () => {
  const { ff, node, pane, release } = await setup();
  try {
    drag(node); await frames();
    node.querySelector(".settings-cell").click();
    const reset = pane.querySelector(".settings-reset"); reset.click();
    await new Promise(resolve => setTimeout(resolve, 410)); reset.click(); await frames();
    assert.deepEqual(await ff.browser.storage.sync.get("tile:clock"), {});
    assert.deepEqual(writes(ff), []);
    release(); await flush(ff);
    assert.deepEqual((await ff.browser.storage.sync.get("tile:clock"))["tile:clock"], { x: 0, y: 0, w: 5, h: 2 });
    assert.deepEqual(rect(tile(node)), { x: 0, y: 0, w: 5, h: 2 });
  } finally { release(); }
});
