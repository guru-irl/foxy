import { test, assert, fixture, nextFrame, dispatchDrag } from "./harness.js";
import { createBoardFirefox } from "./controller.js";
import { createController } from "../../extension/src/main.js";
import { narrowGroups, narrowFolders, narrowLayout } from "./fixtures/narrow-layout.js";

let css;
async function flush(ff) {
  await ff.settle();
  if (document.querySelector(".grid.settling")) await new Promise(resolve => setTimeout(resolve, 330));
  for (let i = 0; i < 5; i++) { await ff.settle(); await nextFrame(); }
}
async function setup(width, settings = {}) {
  css ??= new Promise(resolve => {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/extension/newtab.css";
    link.onload = resolve; document.head.append(link);
  });
  await css;
  const folders = { ...narrowFolders };
  const ff = createBoardFirefox({ windows: [{ id: 1 }], selfTabId: 99, groups: narrowGroups,
    tabs: [...narrowGroups.map(group => ({ id: group.id + 30, windowId: 1, groupId: group.id })),
      { id: 15, windowId: 1 }, { id: 99, windowId: 1 }] },
    message => message.type === "foxy:reconcile" ? { ok: true }
      : message.type === "foxy:saved" ? { saved: [], missing: [], folders } : undefined);
  const layout = { ...narrowLayout,
    "tile:20:saved": { x: 14, y: 0, w: 5, h: 10 },
    "tile:20:group:closed": { x: 15, y: 0, w: 5, h: 10 } };
  await ff.browser.storage.sync.set({ ...layout, settings }); await ff.settle();
  const root = document.createElement("div"); root.className = "board";
  root.style.cssText = `width:${width}px;height:600px`;
  fixture().append(root);
  const control = createController(root, ff.browser);
  await control.refresh(); await flush(ff); ff.calls.length = 0;
  return { ff, root, control, folders, layout };
}
const tile = (root, id) => [...root.querySelectorAll(".tile")].find(node => node.dataset.tileId === id);
const rect = node => Object.fromEntries(["x", "y", "w", "h"].map(key => [key, Number(node.style.getPropertyValue(`--${key}`))]));
const shown = root => Object.fromEntries([...root.querySelectorAll(".tile")].map(node => [node.dataset.tileId, rect(node)]));
const writes = ff => ff.calls.filter(call => call.api === "storage.sync.set").map(call => Object.fromEntries(Object.entries(call.args[0]).filter(([key]) => key !== "layouts")));
function pointer(type, target, coords) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1,
    pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, ...coords }));
}

// Comparing writes to display instead of saved rectangles makes HARNESS land at x=4.
for (const kind of ["move", "resize"]) {
  test(`19-column HARNESS one-row ${kind} lands in layout 19 and restores layout 20 after widening`, async () => {
    const { ff, root, layout } = await setup(2096);
    assert.equal(root.querySelector(".grid").style.getPropertyValue("--cols"), "19");
    const node = tile(root, "group:f");
    assert.deepEqual(rect(node), { x: 14, y: 6, w: 5, h: 3 });
    const source = node.querySelector(kind === "move" ? ".column-header" : ".tile-resize");
    const bounds = source.getBoundingClientRect();
    const start = { clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 };
    const target = { clientX: start.clientX, clientY: start.clientY + 96 };
    try {
      pointer("pointerdown", source, start); pointer("pointermove", document, target);
      const outline = rect(root.querySelector(".drop-outline")), preview = shown(root);
      assert.deepEqual(outline, { x: 14, y: kind === "move" ? 7 : 6, w: 5, h: kind === "move" ? 3 : 4 });
      assert.deepEqual(writes(ff), [], "preview writes nothing");
      pointer("pointerup", document, target); await flush(ff);
      assert.deepEqual(rect(tile(root, "group:f")), outline, "HARNESS lands in its outline");
      assert.deepEqual(shown(root), preview, "every previewed tile lands where shown");
      const expected = Object.fromEntries(Object.entries(preview).map(([id, r]) => [`tile:19:${id}`, r]));
      assert.deepEqual(writes(ff), [expected], "a new target holds every visible rectangle");
      const stored = await ff.browser.storage.sync.get(null);
      for (const id of ["saved", "group:closed", "clock", "pinned"]) {
        assert.deepEqual(stored[`tile:20:${id}`], layout[`tile:20:${id}`], "hidden, closed and unchanged tiles keep their keys");
      }
      ff.calls.length = 0;
      root.style.width = "2192px"; window.dispatchEvent(new Event("resize")); await flush(ff);
      assert.equal(root.querySelector(".grid").style.getPropertyValue("--cols"), "20");
      assert.deepEqual(rect(tile(root, "group:f")), layout["tile:20:group:f"]);
      const group = rect(tile(root, "group:e"));
      assert.ok(rect(tile(root, "group:f")).x >= group.x + group.w, "HARNESS remains right of GROUP");
      assert.deepEqual(writes(ff), [], "widening alone writes nothing");
    } finally {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await flush(ff);
    }
  });
}

// A release in place used to save the whole fitted arrangement (§12: only real changes save it).
for (const [name, cls, moves] of [
  ["move out one row and back", ".column-header", [[0, 96], [0, 0]]],
  ["resize out one row and back", ".tile-resize", [[0, 96], [0, 0]]],
  ["6 px jiggle on the header", ".column-header", [[6, 0]]],
]) {
  test(`19-column ${name} releases in place and writes nothing`, async () => {
    const { ff, root } = await setup(2096);
    const before = shown(root);
    const source = tile(root, "group:f").querySelector(cls), bounds = source.getBoundingClientRect();
    const start = { clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 };
    let at = start;
    pointer("pointerdown", source, start);
    for (const [dx, dy] of moves) {
      at = { clientX: start.clientX + dx, clientY: start.clientY + dy };
      pointer("pointermove", document, at);
    }
    pointer("pointerup", document, at); await flush(ff);
    assert.deepEqual(writes(ff), []);
    assert.deepEqual(shown(root), before);
  });
}

test("12-column header jiggle then widening shows the saved wide layout again", async () => {
  const { ff, root } = await setup(2192);
  const wide = shown(root);
  root.style.width = "1424px"; window.dispatchEvent(new Event("resize")); await flush(ff);
  assert.equal(root.querySelector(".grid").style.getPropertyValue("--cols"), "12");
  const source = tile(root, "group:f").querySelector(".column-header"), bounds = source.getBoundingClientRect();
  const start = { clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 };
  const at = { clientX: start.clientX + 6, clientY: start.clientY };
  pointer("pointerdown", source, start); pointer("pointermove", document, at);
  pointer("pointerup", document, at); await flush(ff);
  root.style.width = "2192px"; window.dispatchEvent(new Event("resize")); await flush(ff);
  assert.deepEqual(writes(ff), []);
  assert.deepEqual(shown(root), wide);
});

// A drop at x=14/10 used to shift to x=13/5 when its bookmark mapping arrived.
for (const [cols, width, x] of [[19, 2096, 14], [15, 1712, 10]]) {
  test(`${cols}-column tab drop at (${x},9) keeps its shown place after folder mapping`, async () => {
    const { ff, root, control, folders, layout } = await setup(width);
    assert.equal(root.querySelector(".grid").style.getPropertyValue("--cols"), String(cols));
    const source = root.querySelector('[data-tab-id="15"]'), grid = root.querySelector(".grid");
    const dataTransfer = dispatchDrag("dragstart", source).dataTransfer, bounds = grid.getBoundingClientRect();
    const coords = { clientX: bounds.left + x * 96 + 20, clientY: bounds.top + 9 * 96 + 20 };
    try {
      dispatchDrag("dragover", grid, { dataTransfer, ...coords });
      const preview = root.querySelector(".cell-preview").getBoundingClientRect();
      assert.equal(preview.left, bounds.left + x * 96);
      assert.equal(preview.top, bounds.top + 9 * 96);
      assert.equal(preview.width, 272); assert.equal(preview.height, 368);
      dispatchDrag("drop", grid, { dataTransfer, ...coords });
      dispatchDrag("dragend", source, { dataTransfer }); await flush(ff); await flush(ff);
      const groupId = (await ff.browser.tabs.get(15)).groupId;
      assert.deepEqual(rect(tile(root, `local:${groupId}`)), { x, y: 9, w: 3, h: 4 });
      assert.deepEqual(writes(ff), [], "unmapped drop remains display-only");
      const pending = shown(root);
      folders[groupId] = "new";
      ff.fire("bookmarks.onCreated", "new", { id: "new", type: "folder" }); await flush(ff);
      root.querySelector(".name-editor").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flush(ff); await flush(ff);
      assert.deepEqual(rect(tile(root, "group:new")), { x, y: 9, w: 3, h: 4 }, "mapped drop stays at its shown cell");
      const mapped = shown(root); delete pending[`local:${groupId}`]; delete mapped["group:new"];
      assert.deepEqual(mapped, pending, "neighbours do not jump on mapping");
      const stored = await ff.browser.storage.sync.get(null);
      for (const id of ["saved", "group:closed"]) {
        assert.deepEqual(stored[`tile:20:${id}`], layout[`tile:20:${id}`]);
        assert.ok(writes(ff).every(write => !(`tile:${cols}:${id}` in write)), "hidden and closed tiles are not written");
      }
      assert.equal(writes(ff).length, 1, "mapping saves once");
      await control.refresh(); await flush(ff);
      assert.equal(writes(ff).length, 1, "pending placement is consumed");
    } finally {
      dispatchDrag("dragend", source, { dataTransfer });
      root.querySelector(".name-editor")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
  });
}
