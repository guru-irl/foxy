import { test, assert, fixture, nextFrame, dispatchDrag } from "./harness.js";
import { createBoardFirefox } from "./controller.js";
import { createController } from "../../extension/src/main.js";
import { resetLayout } from "../../extension/src/settings/pane.js";
import { realLayout, realGroups, realFolders, widthEntries } from "./fixtures/real-layout.js";

let css;
async function flush(ff) {
  if (document.querySelector(".grid.settling")) await new Promise(resolve => setTimeout(resolve, 330));
  for (let i = 0; i < 8; i++) { await ff.settle(); await nextFrame(); }
}
async function setup(c = 34, entries = { layouts: { 34: 1 }, ...widthEntries(34) }, replyGate) {
  css ??= new Promise(resolve => {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/extension/newtab.css";
    link.onload = resolve; document.head.append(link);
  }); await css;
  const folders = { ...realFolders };
  const ff = createBoardFirefox({ windows: [{ id: 1 }], selfTabId: 99, groups: realGroups,
    tabs: [...realGroups.map(g => ({ id: 10 + g.id, windowId: 1, groupId: g.id })),
      { id: 30, windowId: 1 }, { id: 99, windowId: 1 }] },
  message => message.type === "foxy:reconcile" ? { ok: true } : message.type === "foxy:saved"
    ? replyGate ? replyGate.then(() => ({ saved: [], missing: [], folders })) : { saved: [], missing: [], folders } : undefined);
  await ff.browser.storage.sync.set({ settings: { railCells: 5 }, ...entries });
  await ff.browser.storage.local.set({ deviceSettings: { cellSize: "S" } }); await ff.settle();
  const root = document.createElement("div"); root.className = "board";
  root.style.cssText = `width:${(c + 5) * 64 - 16}px;height:800px`; fixture().append(root);
  const control = createController(root, ff.browser, undefined, { newGroupDelay: 10 });
  await control.refresh();
  if (replyGate) {
    const deadline = performance.now() + 2000;
    while (!root.querySelector(".tile") && performance.now() < deadline) await nextFrame();
    assert.ok(root.querySelector(".tile"), "first paint falls back while saved reply waits");
  } else await flush(ff);
  ff.calls.length = 0;
  return { root, ff, control, folders };
}
const node = (root, id) => [...root.querySelectorAll(".tile")].find(t => t.dataset.tileId === id);
const rect = node => Object.fromEntries(["x", "y", "w", "h"].map(k => [k, Number(node.style.getPropertyValue(`--${k}`))]));
const shown = root => Object.fromEntries([...root.querySelectorAll(".tile")].map(t => [t.dataset.tileId, rect(t)]));
const writes = ff => ff.calls.filter(c => c.api === "storage.sync.set").map(c => c.args[0]);
function pointer(type, target, coords) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1,
    pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, ...coords }));
}
async function move(root, ff, id, dx, dy) {
  const source = node(root, id).querySelector(".column-header, .tile-header"), b = source.getBoundingClientRect();
  const start = { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 };
  const at = { clientX: start.clientX + dx * 64, clientY: start.clientY + dy * 64 };
  pointer("pointerdown", source, start); pointer("pointermove", document, at);
  pointer("pointerup", document, at); await flush(ff);
}
async function resize(root, ff, c) {
  root.style.width = `${(c + 5) * 64 - 16}px`; window.dispatchEvent(new Event("resize")); await flush(ff);
}
for (const [c, xy] of [[34, [[0,0],[0,4],[6,0],[13,0],[20,0],[27,0],[20,9],[27,9]]],
  [33, [[0,0],[0,4],[6,0],[13,0],[20,0],[0,9],[20,9],[0,18]]],
  [17, [[0,0],[0,4],[6,0],[0,9],[7,9],[0,18],[7,18],[0,27]]]]) {
  test(`real saved 34-column layout renders at ${c} without writes`, async () => {
    const { root, ff, control } = await setup(c);
    assert.equal(control.view.cols, c); assert.equal(control.view.k, 34);
    assert.deepEqual(Object.values(shown(root)).map(r => [r.x, r.y]), xy);
    assert.deepEqual(writes(ff), []);
  });
}
test("17-column move creates layout 17, preserves 34, and widening restores saved 34", async () => {
  const { root, ff } = await setup(17);
  await move(root, ff, "group:tbr", 0, 1);
  const stored = await ff.browser.storage.sync.get(null), current = shown(root);
  assert.deepEqual(Object.fromEntries(Object.entries(stored).filter(([key]) => key.startsWith("tile:34:"))), widthEntries(34));
  assert.equal(writes(ff).length, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(writes(ff)[0]).filter(([key]) => key.startsWith("tile:17:"))), widthEntries(17, current));
  ff.calls.length = 0; await resize(root, ff, 34);
  assert.deepEqual(shown(root), realLayout); assert.deepEqual(writes(ff), []);
  await resize(root, ff, 17); assert.deepEqual(shown(root), current);
});
for (const [dx, target] of [[-1, 34], [1, 35]]) {
  test(`35-column move ${target === 34 ? "inside source" : "using column 35"} writes layout ${target}`, async () => {
    const { root, ff } = await setup(35);
    await move(root, ff, "group:oce", dx, 0);
    assert.equal(writes(ff).length, 1);
    const keys = Object.keys(writes(ff)[0]).filter(k => k.startsWith("tile:"));
    assert.ok(keys.every(key => key.startsWith(`tile:${target}:`)));
    assert.equal(keys.length, target === 35 ? 8 : 3);
    if (target === 35) assert.deepEqual(Object.fromEntries(Object.entries(await ff.browser.storage.sync.get(null))
      .filter(([key]) => key.startsWith("tile:34:"))), widthEntries(34));
  });
}
test("legacy migration is held for valid folders, then one set and one remove; late legacy migrates too", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const entries = Object.fromEntries(Object.entries(realLayout).map(([id, r]) => [`tile:${id}`, r]));
  const { root, ff } = await setup(34, entries, gate);
  try {
    assert.deepEqual(writes(ff), []); release(); await flush(ff);
    assert.equal(writes(ff).length, 1);
    assert.deepEqual(Object.fromEntries(Object.entries(writes(ff)[0]).filter(([k]) => k.startsWith("tile:"))), widthEntries(34));
    const removals = ff.calls.filter(c => c.api === "storage.sync.remove");
    assert.deepEqual(removals.map(c => c.args[0]), [Object.keys(entries)]);
    ff.calls.length = 0;
    await ff.browser.storage.sync.set({ "tile:clock": { ...realLayout.clock, y: 30 } }); await flush(ff);
    assert.equal((await ff.browser.storage.sync.get(null))["tile:clock"], undefined);
    assert.deepEqual((await ff.browser.storage.sync.get(null))["tile:6:clock"], { ...realLayout.clock, y: 30 });
    assert.ok(node(root, "clock"));
  } finally { release(); }
});
test("Reset removes every layout and metadata in one remove, then recreates only visible current-width tiles", async () => {
  const { ff, control } = await setup(17, { layouts: { 17: 2, 34: 1 }, ...widthEntries(34), ...widthEntries(17),
    "tile:34:group:closed": { x: 0, y: 50, w: 7, h: 9 }, keep: 7 });
  await resetLayout(ff.browser); await flush(ff);
  const removal = ff.calls.find(c => c.api === "storage.sync.remove").args[0];
  assert.ok(removal.includes("layouts"));
  const stored = await ff.browser.storage.sync.get(null);
  assert.equal(stored.keep, 7); assert.deepEqual(Object.keys(stored.layouts), ["17"]);
  assert.equal(stored["tile:34:group:closed"], undefined); assert.equal(control.view.k, 17);
});
test("fifth layout eviction protects the source in use even when oldest and breaks ties by width", async () => {
  const { root, ff } = await setup(17, { layouts: { 34: 0, 35: 1, 36: 1, 37: 2 },
    ...widthEntries(34), ...widthEntries(35), ...widthEntries(36), ...widthEntries(37) });
  await move(root, ff, "group:tbr", 0, 1);
  const stored = await ff.browser.storage.sync.get(null);
  assert.deepEqual(Object.keys(stored.layouts), ["17", "34", "36", "37"]);
  assert.ok(stored["tile:34:clock"]); assert.equal(stored["tile:35:clock"], undefined);
});
test("new group is automatically placed and written in the 34-column source from a 17-column window", async () => {
  const { ff, folders } = await setup(17);
  const g = await ff.browser.tabs.group({ tabIds: [30] }); folders[g] = "new";
  ff.fire("bookmarks.onCreated", "new", { id: "new", type: "folder" }); await flush(ff);
  const stored = await ff.browser.storage.sync.get(null);
  assert.deepEqual(stored["tile:34:group:new"], { x: 0, y: 7, w: 5, h: 6 });
  assert.equal(stored["tile:17:group:new"], undefined);
});
test("mapped tab drop at 17 creates layout 17 once, preserves 34 and lands where previewed", async () => {
  const { root, ff, folders } = await setup(17);
  const source = root.querySelector('[data-tab-id="30"]'), grid = root.querySelector(".grid"), b = grid.getBoundingClientRect();
  const dataTransfer = dispatchDrag("dragstart", source).dataTransfer;
  const coords = { clientX: b.left + 14 * 64 + 10, clientY: b.top + 10 };
  dispatchDrag("drop", grid, { dataTransfer, ...coords }); dispatchDrag("dragend", source, { dataTransfer }); await flush(ff);
  const g = (await ff.browser.tabs.get(30)).groupId;
  assert.deepEqual(writes(ff), []); folders[g] = "new";
  ff.fire("bookmarks.onCreated", "new", { id: "new", type: "folder" });
  root.querySelector(".name-editor")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await flush(ff);
  assert.equal(writes(ff).length, 1);
  assert.deepEqual(rect(node(root, "group:new")), { x: 12, y: 0, w: 5, h: 6 });
  const stored = await ff.browser.storage.sync.get(null);
  assert.deepEqual(Object.fromEntries(Object.entries(stored).filter(([key]) => key.startsWith("tile:34:"))), widthEntries(34));
  assert.deepEqual(stored["tile:17:group:new"], { x: 12, y: 0, w: 5, h: 6 });
});
