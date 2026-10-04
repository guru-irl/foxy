import { test, assert, fixture, nextFrame, withPseudoState } from "./harness.js";
import { createBoardFirefox } from "./controller.js";
import { createController } from "../../extension/src/main.js";
import { narrowGroups, narrowFolders, narrowLayout } from "./fixtures/narrow-layout.js";

let css;
async function flush(ff) {
  await ff.settle();
  if (document.querySelector(".grid.settling")) await new Promise(resolve => setTimeout(resolve, 330));
  for (let i = 0; i < 5; i++) { await ff.settle(); await nextFrame(); }
}
const initial = {
  "tile:10:group:a": { x: 0, y: 0, w: 3, h: 4 },
  "tile:10:group:b": { x: 0, y: 4, w: 3, h: 4 },
  "tile:10:pinned": { x: 5, y: 0, w: 3, h: 4 },
  "tile:10:clock": { x: 5, y: 4, w: 5, h: 2 },
};
async function setup({ layout = initial, width = 1232, settings = {}, folders = { 1: "a", 2: "b" }, extraGroups = [], listener, withPane = false } = {}) {
  css ??= new Promise(resolve => {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/extension/newtab.css";
    link.onload = resolve; document.head.append(link);
  });
  await css;
  const ff = createBoardFirefox({ windows: [{ id: 1 }], selfTabId: 99,
    groups: [{ id: 1, windowId: 1, title: "A" }, { id: 2, windowId: 1, title: "B" }, ...extraGroups],
    tabs: [{ id: 10, windowId: 1, groupId: 1 }, { id: 20, windowId: 1, groupId: 2 },
      ...extraGroups.map(group => ({ id: group.id + 30, windowId: 1, groupId: group.id })), { id: 99, windowId: 1 }] },
    listener ?? (message => message.type === "foxy:reconcile" ? { ok: true }
      : message.type === "foxy:saved" ? { saved: [], missing: [], folders } : undefined));
  // These geometry fixtures use Custom 80, independent of the S default.
  await ff.browser.storage.local.set({ deviceSettings: { cellSize: "custom", customCell: 80 } });
  await ff.browser.storage.sync.set({ ...layout, settings: { railCells: 3, ...settings } }); await ff.settle();
  const root = document.createElement("div"); root.className = "board";
  root.style.cssText = `width:${width}px;height:600px`;
  let pane;
  if (withPane) {
    const host = document.createElement("div"); host.className = "page";
    host.style.cssText = `width:${width}px;height:600px`;
    pane = document.createElement("aside"); pane.className = "settings-pane"; pane.hidden = true;
    host.append(root, pane); fixture().append(host);
  } else fixture().append(root);
  const control = createController(root, ff.browser);
  await control.refresh(); await flush(ff); ff.calls.length = 0;
  return { ff, root, control, pane };
}
const tile = (root, id = "group:a") => [...root.querySelectorAll(".tile")].find(node => node.dataset.tileId === id);
const header = root => tile(root).querySelector(".column-header");
const rect = node => ({ x: Number(node.style.getPropertyValue("--x")), y: Number(node.style.getPropertyValue("--y")),
  w: Number(node.style.getPropertyValue("--w")), h: Number(node.style.getPropertyValue("--h")) });
const writes = ff => ff.calls.filter(call => call.api === "storage.sync.set").map(call => Object.fromEntries(Object.entries(call.args[0]).filter(([key]) => !key.startsWith("layout:"))));
function point(node, x = 0.5, y = 0.5) {
  const bounds = node.getBoundingClientRect();
  return { clientX: bounds.left + bounds.width * x, clientY: bounds.top + bounds.height * y };
}
function pointer(type, target, coords, options = {}) {
  assert.ok(target, `missing pointer target for ${type}`);
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1,
    pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, ...coords, ...options });
  target.dispatchEvent(event); return event;
}
function down(target, coords = point(target)) {
  pointer("pointerdown", target, coords); return coords;
}
const shifted = (start, x, y) => ({ clientX: start.clientX + x, clientY: start.clientY + y });
function escape() { document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); }

// Missing place preview, push commits, click suppression or pointer capture fails this test.
test("tile header move snaps with its pointer offset, pushes live and writes only changed tiles", async () => {
  const { ff, root } = await setup();
  const source = header(root).querySelector(".group-name"), node = tile(root), captures = [];
  const capture = source.setPointerCapture.bind(source);
  source.setPointerCapture = id => { captures.push(id); try { capture(id); } catch {} };
  const start = down(source, point(source, 0.8, 0.5));
  pointer("pointermove", document, shifted(start, 20, 192));
  assert.deepEqual(rect(node), { x: 0, y: 2, w: 3, h: 4 });
  assert.deepEqual(rect(tile(root, "group:b")), { x: 0, y: 6, w: 3, h: 4 });
  assert.equal(getComputedStyle(node).opacity, "1");
  assert.deepEqual(captures, [1], "the pointer source must request capture");
  assert.deepEqual(writes(ff), [], "preview must not write");
  pointer("pointerup", document, shifted(start, 20, 192)); source.click(); await flush(ff);
  assert.equal(root.querySelector(".name-editor"), null, "a post-drag click cannot rename");
  assert.deepEqual(writes(ff), [{ "tile:10:group:a": { x: 0, y: 2, w: 3, h: 4 }, "tile:10:group:b": { x: 0, y: 6, w: 3, h: 4 } }]);
  assert.equal(getComputedStyle(tile(root)).opacity, "1");
});

// The threshold is strictly past 4px; the name remains a click target, unlike action buttons.
test("header clicks through 4px still rename and the dot still recolours without moving", async () => {
  const { ff, root } = await setup();
  let source = header(root).querySelector(".group-name"), start = down(source);
  pointer("pointermove", document, shifted(start, 4, 0)); pointer("pointerup", document, shifted(start, 4, 0)); source.click();
  assert.ok(root.querySelector(".name-editor")); escape(); await flush(ff);
  source = header(root).querySelector(".dot"); start = down(source);
  pointer("pointermove", document, shifted(start, 100, 192)); pointer("pointerup", document, shifted(start, 100, 192)); source.click();
  assert.ok(root.querySelector(".color-picker")); escape(); await flush(ff);
  assert.deepEqual(rect(tile(root)), initial["tile:10:group:a"]); assert.deepEqual(writes(ff), []);
});

for (const kind of ["move", "resize", "rail"]) {
  for (const cancel of ["Escape", "pointercancel", "lostpointercapture"]) {
    test(`${cancel} cancels ${kind}, restores preview and writes nothing`, async () => {
      const { ff, root } = await setup();
      const source = kind === "move" ? header(root) : kind === "resize" ? tile(root).querySelector(".tile-resize") : root.querySelector(".rail-resize");
      assert.ok(source, `missing ${kind} handle`);
      const start = down(source); pointer("pointermove", document, shifted(start, kind === "rail" ? -192 : 192, 192));
      assert.ok(kind === "rail" ? root.querySelector(".rail").getBoundingClientRect().width > 272 : rect(tile(root)).y > 0 || rect(tile(root)).w > 3);
      if (cancel === "Escape") escape(); else pointer(cancel, source, start);
      await flush(ff);
      assert.deepEqual(rect(tile(root)), initial["tile:10:group:a"]);
      assert.deepEqual(rect(tile(root, "group:b")), initial["tile:10:group:b"]);
      assert.equal(root.querySelector(".rail").getBoundingClientRect().width, 272);
      assert.deepEqual(writes(ff), []);
      pointer("pointerup", document, shifted(start, 192, 192)); await flush(ff); assert.deepEqual(writes(ff), []);
    });
  }
}

// Missing cancellation on lost mouse release/focus must not leave updates held.
for (const kind of ["move", "resize", "rail", "before threshold"]) {
  for (const end of ["buttonless move", "blur", "hidden"]) {
    test(`${end} cancels ${kind}, resumes held renders and ignores a later click`, async () => {
      const { ff, root, control } = await setup();
      const source = kind === "rail" ? root.querySelector(".rail-resize") : kind === "resize"
        ? tile(root).querySelector(".tile-resize") : header(root);
      const start = down(source), target = shifted(start, kind === "rail" ? -192 : 0, 192);
      try {
        if (kind !== "before threshold") pointer("pointermove", document, target);
        const original = tile(root, "pinned");
        await ff.browser.storage.sync.set({ "tile:10:pinned": { x: 0, y: 20, w: 3, h: 4 } });
        await flush(ff);
        assert.equal(tile(root, "pinned"), original, "remote render stays held until cancellation");
        assert.equal(rect(original).y, 0);
        ff.calls.length = 0;
        if (end === "buttonless move") pointer("pointermove", document, target, { buttons: 0 });
        else if (end === "blur") window.dispatchEvent(new Event("blur"));
        else {
          Object.defineProperty(document, "hidden", { configurable: true, value: true });
          try { document.dispatchEvent(new Event("visibilitychange")); }
          finally { delete document.hidden; }
        }
        assert.equal(control.ui.gridDragging, kind !== "rail" && kind !== "before threshold", "tile cancellation holds updates through the return slide");
        assert.equal(root.hasAttribute("data-grid-dragging"), false);
        assert.deepEqual(rect(tile(root)), initial["tile:10:group:a"], "cancel restores the tile preview");
        assert.deepEqual(rect(tile(root, "group:b")), initial["tile:10:group:b"]);
        assert.equal(root.querySelector(".rail").getBoundingClientRect().width, 272);
        await flush(ff);
        assert.equal(rect(tile(root, "pinned")).y, 20, "held remote update applies after cancel");
        const elsewhere = root.querySelector(".rail");
        pointer("pointerdown", elsewhere, point(elsewhere)); pointer("pointerup", document, target);
        elsewhere.click(); await flush(ff);
        assert.deepEqual(writes(ff), [], "a later click cannot commit the cancelled gesture");
      } finally { escape(); await flush(ff); }
    });
  }
}

test("a second press during the closed-group check cannot start a gesture; a fresh drag still holds updates", async () => {
  const { ff, root, control } = await setup(), get = ff.browser.tabGroups.get;
  let release, began, checks = 0;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { began = resolve; });
  ff.browser.tabGroups.get = async id => {
    if (id === 1 && ++checks === 1) { began(); await gate; }
    return get(id);
  };
  try {
    const start = down(header(root)), target = shifted(start, 0, 192);
    pointer("pointermove", document, target); pointer("pointerup", document, target); await started;
    assert.equal(control.ui.gridDragging, true, "the closed-group check retains the hold");
    assert.equal(root.hasAttribute("data-grid-dragging"), false);
    const neighbour = tile(root, "group:b"), before = rect(neighbour);
    const second = down(neighbour.querySelector(".column-header"));
    pointer("pointermove", document, shifted(second, 0, 96));
    assert.equal(root.hasAttribute("data-grid-dragging"), false, "a press during ending must not start another gesture");
    assert.deepEqual(rect(neighbour), before); assert.deepEqual(writes(ff), []);
    release(); await flush(ff); assert.equal(control.ui.gridDragging, false);
    assert.deepEqual(writes(ff), [{ "tile:10:group:a": { x: 0, y: 2, w: 3, h: 4 }, "tile:10:group:b": { x: 0, y: 6, w: 3, h: 4 } }]);
    const fresh = down(header(root)), freshTarget = shifted(fresh, 0, 192);
    pointer("pointermove", document, freshTarget); assert.equal(control.ui.gridDragging, true);
    const pinned = tile(root, "pinned");
    await ff.browser.storage.sync.set({ "tile:10:pinned": { x: 0, y: 20, w: 3, h: 4 } }); await flush(ff);
    assert.equal(tile(root, "pinned"), pinned); assert.equal(rect(pinned).y, 0);
    pointer("pointerup", document, freshTarget); await flush(ff);
    assert.equal(control.ui.gridDragging, false); assert.equal(rect(tile(root)).y, 4);
    assert.equal(rect(tile(root, "pinned")).y, 20, "the fresh drag releases its own held update");
  } finally { release(); await nextFrame(); escape(); ff.browser.tabGroups.get = get; await flush(ff); }
});

test("visibilitychange while visible keeps the tile gesture and its held updates", async () => {
  const { ff, root, control } = await setup();
  const start = down(header(root)), target = shifted(start, 0, 192);
  try {
    pointer("pointermove", document, target);
    const moved = rect(tile(root)), pinned = tile(root, "pinned");
    await ff.browser.storage.sync.set({ "tile:10:pinned": { x: 0, y: 20, w: 3, h: 4 } }); await flush(ff);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(control.ui.gridDragging, true); assert.equal(root.hasAttribute("data-grid-dragging"), true);
    assert.deepEqual(rect(tile(root)), moved); assert.equal(tile(root, "pinned"), pinned); assert.equal(rect(pinned).y, 0);
    pointer("pointerup", document, target); await flush(ff);
    assert.equal(control.ui.gridDragging, false); assert.equal(rect(tile(root)).y, 2);
    assert.equal(rect(tile(root, "pinned")).y, 20);
  } finally { delete document.hidden; escape(); await flush(ff); }
});

for (const end of ["pointercancel", "lostpointercapture"]) {
  test(`keyboard rename works on the next task after ${end}`, async () => {
    const { ff, root } = await setup();
    const source = header(root).querySelector(".group-name"), start = down(source);
    pointer("pointermove", document, shifted(start, 0, 192));
    pointer(end, source, start);
    await flush(ff);
    const name = header(root).querySelector(".group-name");
    name.focus();
    // Enter activates a button with a click and no preceding pointerdown.
    name.click();
    assert.ok(root.querySelector(".name-editor"), "keyboard activation must open rename after cancel");
    escape(); await flush(ff); assert.deepEqual(writes(ff), []);
  });
}

test("resize corner snaps its bottom right, pushes live and respects minima and columns", async () => {
  const { ff, root } = await setup();
  let source = tile(root).querySelector(".tile-resize"); assert.ok(source);
  let start = down(source, point(source, 0.5, 0.5));
  pointer("pointermove", document, shifted(start, 192, 192));
  assert.deepEqual(rect(tile(root)), { x: 0, y: 0, w: 5, h: 6 });
  assert.deepEqual(rect(tile(root, "group:b")), { x: 0, y: 6, w: 3, h: 4 });
  pointer("pointerup", document, shifted(start, 192, 192)); await flush(ff);
  assert.deepEqual(writes(ff), [{ "tile:10:group:a": { x: 0, y: 0, w: 5, h: 6 }, "tile:10:group:b": { x: 0, y: 6, w: 3, h: 4 } }]);
  source = tile(root).querySelector(".tile-resize"); start = down(source);
  pointer("pointermove", document, shifted(start, -2000, -2000));
  assert.deepEqual(rect(tile(root)), { x: 0, y: 0, w: 2, h: 2 });
  pointer("pointermove", document, shifted(start, 2000, 0)); assert.equal(rect(tile(root)).w, 10); escape(); await flush(ff);
  source = tile(root, "clock").querySelector(".tile-resize"); start = down(source);
  pointer("pointermove", document, shifted(start, -2000, -2000));
  assert.equal(rect(tile(root, "clock")).w, 3); assert.equal(rect(tile(root, "clock")).h, 2); escape();
});

test("every tile has an invisible 16px resize corner, clock has a move header", async () => {
  const { root } = await setup();
  for (const node of root.querySelectorAll(".tile")) {
    const handle = node.querySelector(".tile-resize"); assert.ok(handle);
    const bounds = handle.getBoundingClientRect(), card = node.getBoundingClientRect(), style = getComputedStyle(handle);
    assert.equal(bounds.width, 16); assert.equal(bounds.height, 16);
    assert.equal(style.cursor, "nwse-resize"); assert.equal(style.opacity, "0");
    assert.ok(bounds.right <= card.right && bounds.bottom <= card.bottom);
    withPseudoState([node], "hover", () => assert.equal(getComputedStyle(handle).opacity, "0"));
    assert.equal(handle.tabIndex, -1, "pointer-only handles must not be tab stops");
    assert.equal(handle.getAttribute("aria-hidden"), "true");
    withPseudoState([node], "focus-within", () => assert.equal(getComputedStyle(handle).opacity, "0"));
    assert.equal(style.boxShadow, "none"); assert.equal(style.borderTopWidth, "0px"); assert.equal(style.outlineStyle, "none");
  }
  const clock = tile(root, "clock"), source = clock.querySelector(".tile-header"); assert.ok(source);
  const start = down(source); pointer("pointermove", document, shifted(start, -480, 480));
  assert.deepEqual(rect(clock), { x: 0, y: 9, w: 5, h: 2 }); escape();
});

test("rail edge previews whole cells and grid fit, clamps and saves only changed railCells", async () => {
  const { ff, root } = await setup();
  let source = root.querySelector(".rail-resize"); assert.ok(source);
  assert.equal(source.getBoundingClientRect().width, 8); assert.equal(getComputedStyle(source).cursor, "col-resize");
  let start = down(source); const right = root.querySelector(".rail").getBoundingClientRect().right;
  const target = { clientX: right - (5 * 96 - 16), clientY: start.clientY };
  pointer("pointermove", document, target);
  assert.equal(root.querySelector(".rail").getBoundingClientRect().width, 464);
  assert.equal(root.querySelector(".grid").style.getPropertyValue("--cols"), "8"); assert.deepEqual(writes(ff), []);
  pointer("pointerup", document, target); await flush(ff);
  assert.deepEqual(writes(ff), [{ settings: { railCells: 5 } }]);
  ff.calls.length = 0; source = root.querySelector(".rail-resize"); start = down(source);
  pointer("pointermove", document, shifted(start, -4000, 0)); assert.equal(root.querySelector(".rail").style.getPropertyValue("--rail-cells"), "6");
  pointer("pointermove", document, shifted(start, 4000, 0)); assert.equal(root.querySelector(".rail").style.getPropertyValue("--rail-cells"), "2");
  pointer("pointermove", document, start); pointer("pointerup", document, start); await flush(ff);
  assert.deepEqual(writes(ff), [], "returning to the starting width must not save");
});

for (const { offset, cells } of [{ offset: 4000, cells: 2 }, { offset: -4000, cells: 6 }]) {
  test(`rail release beyond the ${cells === 2 ? "minimum" : "maximum"} saves the clamped limit`, async () => {
    const { ff, root } = await setup();
    const start = down(root.querySelector(".rail-resize")), target = shifted(start, offset, 0);
    pointer("pointermove", document, target);
    assert.equal(root.querySelector(".rail").style.getPropertyValue("--rail-cells"), String(cells));
    pointer("pointerup", document, target); await flush(ff);
    assert.deepEqual(writes(ff), [{ settings: { railCells: cells } }]);
    assert.deepEqual((await ff.browser.storage.sync.get("settings")).settings, { railCells: cells });
  });
}

for (const kind of ["move", "resize", "rail"]) {
  for (const end of ["release", "cancel"]) {
    test(`remote storage updates during ${kind} are held and applied after ${end}`, async () => {
      const { ff, root } = await setup();
      const source = kind === "move" ? header(root) : kind === "resize" ? tile(root).querySelector(".tile-resize") : root.querySelector(".rail-resize");
      assert.ok(source); const start = down(source), original = tile(root, "pinned");
      pointer("pointermove", document, shifted(start, kind === "rail" ? -96 : 0, 96));
      await ff.browser.storage.sync.set({ "tile:10:pinned": { x: 0, y: 20, w: 3, h: 4 }, settings: { transparency: "high" } });
      await flush(ff);
      assert.equal(tile(root, "pinned"), original, "no DOM replacement while captured");
      assert.equal(rect(original).y, 0, "remote position is held during preview");
      if (end === "release") pointer("pointerup", document, shifted(start, kind === "rail" ? -96 : 0, 96)); else escape();
      await flush(ff);
      assert.equal(rect(tile(root, "pinned")).y, 20);
      assert.equal(root.style.getPropertyValue("--card-alpha-dark"), "0.45");
      const localWrites = writes(ff).slice(1);
      assert.ok(localWrites.every(entry => !("tile:10:pinned" in entry)), "an unrelated remote tile must not be written back");
      if (kind === "rail" && end === "release") assert.deepEqual(localWrites, [{ settings: { transparency: "high", railCells: 4 } }]);
      if (end === "cancel") assert.deepEqual(localWrites, []);
    });
  }
}

test("narrow fit writes nothing, a move saves shown rectangles including fitted neighbours", async () => {
  const layout = { "tile:13:group:a": { x: 7, y: 0, w: 3, h: 4 }, "tile:13:group:b": { x: 0, y: 4, w: 5, h: 4 },
    "tile:13:group:c": { x: 8, y: 10, w: 5, h: 4 } };
  const { ff, root } = await setup({ layout, folders: { 1: "a", 2: "b", 3: "c" }, settings: { showClock: false, showPinned: false },
    extraGroups: [{ id: 3, windowId: 1, title: "C" }] });
  root.style.width = "560px"; window.dispatchEvent(new Event("resize")); await flush(ff);
  assert.deepEqual(rect(tile(root)), { x: 0, y: 0, w: 3, h: 4 });
  assert.deepEqual(rect(tile(root, "group:c")), { x: 0, y: 10, w: 3, h: 4 }); assert.deepEqual(writes(ff), []);
  const source = header(root), start = down(source); pointer("pointermove", document, shifted(start, 0, 192));
  pointer("pointerup", document, shifted(start, 0, 192)); await flush(ff);
  assert.deepEqual(writes(ff), [{ "tile:3:group:a": { x: 0, y: 2, w: 3, h: 4 }, "tile:3:group:b": { x: 0, y: 6, w: 3, h: 4 },
    "tile:3:group:c": { x: 0, y: 10, w: 3, h: 4 } }]);
  assert.deepEqual((await ff.browser.storage.sync.get(null))["tile:3:group:c"], { x: 0, y: 10, w: 3, h: 4 });
  root.style.width = "1520px"; window.dispatchEvent(new Event("resize")); await flush(ff);
  assert.deepEqual(rect(tile(root)), layout["tile:13:group:a"], "widening returns to the unchanged source");
});

test("gap-closed narrow drag saves the shown arrangement and keeps preview equal to release", async () => {
  const { ff, root } = await setup({ width: 2096, layout: narrowLayout, folders: narrowFolders,
    extraGroups: narrowGroups.slice(2) });
  const shown = () => Object.fromEntries([...root.querySelectorAll(".tile")].map(node => [node.dataset.tileId, rect(node)]));
  assert.equal(root.querySelector(".grid").style.getPropertyValue("--cols"), "19");
  assert.deepEqual(rect(tile(root)), { x: 9, y: 0, w: 5, h: 3 });
  assert.deepEqual(rect(tile(root, "group:b")), { x: 14, y: 0, w: 5, h: 3 });
  const start = down(header(root)), target = shifted(start, 0, 288);
  try {
    pointer("pointermove", document, target);
    const preview = shown();
    assert.deepEqual(preview["group:a"], { x: 9, y: 3, w: 5, h: 3 });
    assert.deepEqual(preview["group:c"], { x: 9, y: 6, w: 5, h: 3 });
    assert.deepEqual(preview["group:e"], { x: 9, y: 9, w: 5, h: 3 });
    for (const id of ["b", "d", "f"]) {
      const saved = narrowLayout[`tile:20:group:${id}`];
      assert.deepEqual(preview[`group:${id}`], { ...saved, x: 14 });
    }
    assert.deepEqual(writes(ff), []);
    pointer("pointerup", document, target); await flush(ff);
    assert.deepEqual(shown(), preview);
    assert.deepEqual(writes(ff), [Object.fromEntries(Object.entries(preview).map(([id, r]) => [`tile:19:${id}`, r]))]);
    const stored = await ff.browser.storage.sync.get(null);
    for (const id of ["clock", "pinned"]) {
      assert.deepEqual(stored[`tile:20:${id}`], narrowLayout[`tile:20:${id}`]);
    }
  } finally { escape(); await flush(ff); }
});

test("four-column gesture saves fitted neighbours and keeps every previewed rectangle", async () => {
  const { ff, root } = await setup({ width: 656 });
  const ids = ["group:a", "group:b", "pinned", "clock"];
  const shown = () => Object.fromEntries(ids.map(id => [id, rect(tile(root, id))]));
  assert.equal(root.querySelector(".grid").style.getPropertyValue("--cols"), "4");
  assert.deepEqual(shown(), {
    "group:a": { x: 0, y: 0, w: 3, h: 4 }, "group:b": { x: 0, y: 4, w: 3, h: 4 },
    pinned: { x: 0, y: 8, w: 3, h: 4 }, clock: { x: 0, y: 12, w: 4, h: 2 },
  });
  const start = down(header(root)), target = shifted(start, 0, 96 * 14);
  try {
    pointer("pointermove", document, target);
    const preview = shown();
    assert.deepEqual(preview, {
      "group:a": { x: 0, y: 14, w: 3, h: 4 }, "group:b": { x: 0, y: 4, w: 3, h: 4 },
      pinned: { x: 0, y: 8, w: 3, h: 4 }, clock: { x: 0, y: 12, w: 4, h: 2 },
    }, "preview keeps the shown neighbours rather than refitting their old saved places");
    assert.deepEqual(writes(ff), []);
    pointer("pointerup", document, target); await flush(ff);
    assert.deepEqual(shown(), preview, "release must preserve every previewed rectangle");
    assert.deepEqual(writes(ff), [Object.fromEntries(Object.entries(preview).map(([id, r]) => [`tile:4:${id}`, r]))]);
    const stored = await ff.browser.storage.sync.get(null);
    assert.deepEqual(stored["tile:10:group:b"], initial["tile:10:group:b"]);
    for (const id of ["pinned", "clock"]) assert.deepEqual(stored[`tile:4:${id}`], preview[id]);
  } finally { escape(); await flush(ff); }
});

// Task 5 re-review cases: unsaved neighbours must be placed as new, and a
// dragged local tile's non-local pushes must follow the pending-placement path.
test("an unmapped neighbour previews where it lands when a mapped tile moves to row 12", async () => {
  const { ff, root } = await setup({ folders: { 1: "a" } });
  const ids = ["group:a", "local:2", "pinned", "clock"];
  const shown = () => Object.fromEntries(ids.map(id => [id, rect(tile(root, id))]));
  assert.deepEqual(rect(tile(root, "local:2")), { x: 0, y: 4, w: 3, h: 4 });
  const start = down(header(root)), target = shifted(start, 0, 96 * 12);
  try {
    pointer("pointermove", document, target);
    const preview = shown();
    assert.deepEqual(preview["local:2"], { x: 0, y: 0, w: 3, h: 4 });
    assert.deepEqual(preview["group:a"], { x: 0, y: 12, w: 3, h: 4 });
    assert.deepEqual(writes(ff), []);
    pointer("pointerup", document, target); await flush(ff);
    assert.deepEqual(shown(), preview);
    assert.deepEqual(writes(ff), [{ "tile:10:group:a": { x: 0, y: 12, w: 3, h: 4 } }]);
  } finally { escape(); await flush(ff); }
});

test("a mapped neighbour without a saved place previews its post-release first-free position", async () => {
  const folders = { 1: "a", 2: "b" }, { ff, root } = await setup({ folders });
  const tab = await ff.browser.tabs.create({ windowId: 1, url: "about:blank", active: false });
  const groupId = await ff.browser.tabs.group({ tabIds: [tab.id] }); folders[groupId] = "c";
  await flush(ff);
  assert.deepEqual(rect(tile(root, "group:c")), { x: 3, y: 6, w: 3, h: 4 });
  assert.equal((await ff.browser.storage.sync.get(null))["tile:10:group:c"], undefined);
  ff.calls.length = 0;
  const ids = ["group:a", "group:b", "group:c", "pinned", "clock"];
  const shown = () => Object.fromEntries(ids.map(id => [id, rect(tile(root, id))]));
  const start = down(header(root)), target = shifted(start, 0, 96 * 12);
  try {
    pointer("pointermove", document, target);
    const preview = shown(); assert.deepEqual(preview["group:c"], { x: 0, y: 0, w: 3, h: 4 });
    assert.deepEqual(writes(ff), []);
    pointer("pointerup", document, target); await flush(ff);
    assert.deepEqual(shown(), preview);
    assert.deepEqual(writes(ff), [{ "tile:10:group:a": { x: 0, y: 12, w: 3, h: 4 } }]);
    assert.equal((await ff.browser.storage.sync.get(null))["tile:10:group:c"], undefined);
  } finally { escape(); await flush(ff); }
});

test("four-column unmapped drag previews pending pushes where they land without writes", async () => {
  const { ff, root } = await setup({ width: 656, folders: { 2: "b" } });
  const ids = ["local:1", "group:b", "pinned", "clock"];
  const shown = () => Object.fromEntries(ids.map(id => [id, rect(tile(root, id))]));
  assert.equal(root.querySelector(".grid").style.getPropertyValue("--cols"), "4");
  const start = down(tile(root, "local:1").querySelector(".column-header")), target = shifted(start, 0, 96 * 5);
  try {
    pointer("pointermove", document, target);
    const preview = shown();
    assert.deepEqual(preview, {
      "local:1": { x: 0, y: 5, w: 3, h: 4 }, "group:b": { x: 0, y: 0, w: 3, h: 4 },
      pinned: { x: 0, y: 9, w: 3, h: 4 }, clock: { x: 0, y: 13, w: 4, h: 2 },
    });
    assert.deepEqual(writes(ff), []);
    pointer("pointerup", document, target); await flush(ff);
    assert.deepEqual(shown(), preview); assert.deepEqual(writes(ff), []);
  } finally { escape(); await flush(ff); }
});

for (const mapped of [true, false]) {
  for (const kind of ["move", "resize"]) {
    test(`closing the ${mapped ? "mapped" : "unmapped"} dragged group cancels ${kind} and leaves neighbours unchanged`, async () => {
      const { ff, root, control } = await setup({ folders: mapped ? { 1: "a", 2: "b" } : { 2: "b" },
        settings: { showClock: false, showPinned: false } });
      const id = mapped ? "group:a" : "local:1", node = tile(root, id);
      const source = kind === "move" ? node.querySelector(".column-header") : node.querySelector(".tile-resize");
      const start = down(source), target = shifted(start, 0, 192);
      pointer("pointermove", document, target);
      assert.equal(rect(tile(root, "group:b")).y, 6, "the closing tile must have pushed a neighbour in preview");
      await ff.browser.tabs.remove(10); await flush(ff);
      assert.equal(control.ui.gridDragging, true);
      assert.equal(tile(root, id), node, "the removal render stays held during the gesture");
      ff.calls.length = 0;
      pointer("pointerup", document, target); await flush(ff);
      assert.equal(control.ui.gridDragging, false);
      assert.equal(root.hasAttribute("data-grid-dragging"), false);
      assert.equal(tile(root, id), undefined, "closed tile disappears after cancellation");
      assert.deepEqual(rect(tile(root, "group:b")), initial["tile:10:group:b"]);
      assert.deepEqual(writes(ff), [], "neither the vanished tile nor its preview pushes may be written");
      assert.deepEqual((await ff.browser.storage.sync.get(null))["tile:10:group:b"], initial["tile:10:group:b"]);
    });
  }
}

for (const kind of ["move", "resize"]) {
  test(`${kind} uses grid padding and scroll content coordinates`, async () => {
    const { ff, root } = await setup({ layout: { ...initial, "tile:10:group:a": { x: 0, y: 8, w: 3, h: 4 } } });
    const grid = root.querySelector(".grid"); grid.style.padding = "12px 0 0 20px"; grid.scrollTop = 576;
    const source = kind === "move" ? header(root) : tile(root).querySelector(".tile-resize"); assert.ok(source);
    const start = down(source); pointer("pointermove", document, shifted(start, 96, -96));
    assert.deepEqual(rect(tile(root)), kind === "move" ? { x: 1, y: 7, w: 3, h: 4 } : { x: 0, y: 8, w: 4, h: 3 });
    escape(); await flush(ff); assert.deepEqual(writes(ff), []);
  });
  test(`${kind} auto-scrolls vertically and the snapped target follows the scroll`, async () => {
    const { root } = await setup({ layout: { ...initial, "tile:10:clock": { x: 5, y: 20, w: 5, h: 2 } } });
    const grid = root.querySelector(".grid"), source = kind === "move" ? header(root) : tile(root).querySelector(".tile-resize"); assert.ok(source);
    const start = down(source), target = { clientX: start.clientX, clientY: grid.getBoundingClientRect().bottom - 2 };
    pointer("pointermove", document, target); const first = rect(tile(root));
    for (let i = 0; i < 10; i++) await nextFrame();
    assert.ok(grid.scrollTop >= 96, "reuse 12px-per-frame edge scrolling");
    assert.ok(kind === "move" ? rect(tile(root)).y > first.y : rect(tile(root)).h > first.h, "scrolling must update the snap without another pointermove");
    escape(); const top = grid.scrollTop; await nextFrame(); await nextFrame(); assert.equal(grid.scrollTop, top, "cancel stops auto-scroll");
  });
}

for (const kind of ["move", "resize"]) {
  test(`unmapped group ${kind} stays pending, then mapping saves its rect and pushes once`, async () => {
    let folders = { 2: "b" };
    const { ff, root, control } = await setup({ layout: { "tile:10:group:b": { x: 0, y: 4, w: 3, h: 4 } }, settings: { showClock: false, showPinned: false },
      listener: message => message.type === "foxy:reconcile" ? { ok: true } : message.type === "foxy:saved" ? { saved: [], missing: [], folders } : undefined });
    const source = kind === "move" ? tile(root, "local:1").querySelector(".column-header") : tile(root, "local:1").querySelector(".tile-resize"); assert.ok(source);
    const start = down(source); pointer("pointermove", document, shifted(start, 0, 192));
    pointer("pointerup", document, shifted(start, 0, 192)); await flush(ff);
    const wanted = kind === "move" ? { x: 0, y: 2, w: 3, h: 4 } : { x: 0, y: 0, w: 3, h: 6 };
    assert.deepEqual(rect(tile(root, "local:1")), wanted); assert.equal(rect(tile(root, "group:b")).y, 6);
    assert.deepEqual(writes(ff), [], "pending tiles and their pushes wait for the mapping");
    folders = { 1: "a", 2: "b" }; await control.refresh(); await flush(ff);
    assert.deepEqual(writes(ff), [{ "tile:10:group:b": { x: 0, y: 6, w: 3, h: 4 }, "tile:10:group:a": wanted }]);
    await control.refresh(); await flush(ff); assert.equal(writes(ff).length, 1);
  });
}

for (const kind of ["move", "resize", "rail"]) {
  test(`${kind} returning to its starting rectangle saves nothing`, async () => {
    const { ff, root } = await setup();
    const source = kind === "move" ? header(root) : kind === "resize" ? tile(root).querySelector(".tile-resize") : root.querySelector(".rail-resize");
    const start = down(source); pointer("pointermove", document, shifted(start, kind === "rail" ? -192 : 192, 192));
    assert.ok(kind === "rail" ? root.querySelector(".rail").getBoundingClientRect().width > 272 : rect(tile(root)).y > 0 || rect(tile(root)).w > 3);
    pointer("pointermove", document, start); pointer("pointerup", document, start); await flush(ff);
    assert.deepEqual(rect(tile(root)), initial["tile:10:group:a"]); assert.deepEqual(writes(ff), []);
  });
}

for (const kind of ["move", "rail"]) {
  test(`a stale grid re-read spanning a ${kind} write is discarded before storage events arrive`, async () => {
    const { ff, root } = await setup();
    const sync = ff.browser.storage.sync, get = sync.get, set = sync.set;
    let releaseRead, releaseWrite, readBegan, writeBegan, writeEnded;
    const readGate = new Promise(resolve => { releaseRead = resolve; }), writeGate = new Promise(resolve => { releaseWrite = resolve; });
    const readStarted = new Promise(resolve => { readBegan = resolve; }), writeStarted = new Promise(resolve => { writeBegan = resolve; });
    const writeFinished = new Promise(resolve => { writeEnded = resolve; });
    let reads = 0;
    sync.get = async keys => {
      const value = await get(keys);
      if (keys === null && ++reads === 1) { readBegan(); await readGate; }
      return value;
    };
    sync.set = async entries => { writeBegan(); await writeGate; await set(entries); writeEnded(); };
    try {
      ff.fire("storage.onChanged", { settings: { newValue: {} } }, "sync"); await ff.settle(); await readStarted;
      const source = kind === "move" ? header(root) : root.querySelector(".rail-resize"), start = down(source);
      const target = shifted(start, kind === "rail" ? -192 : 0, kind === "rail" ? 0 : 192);
      pointer("pointermove", document, target);
      assert.equal(kind === "move" ? rect(tile(root)).y : Number(root.querySelector(".rail").style.getPropertyValue("--rail-cells")), kind === "move" ? 2 : 5);
      pointer("pointerup", document, target); await writeStarted;
      releaseRead(); await nextFrame(); releaseWrite(); await writeFinished;
      // Do not settle the fake: its storage.onChanged event is still queued.
      // The move write now starts before the slide, so allow its render hold
      // to end before requiring the stale snapshot's replacement read.
      if (kind === "move") await new Promise(resolve => setTimeout(resolve, 330));
      for (let i = 0; i < 8; i++) await nextFrame();
      assert.equal(kind === "move" ? rect(tile(root)).y : Number(root.querySelector(".rail").style.getPropertyValue("--rail-cells")), kind === "move" ? 2 : 5);
      assert.equal(writes(ff).length, 1); assert.ok(reads >= 2, "a snapshot spanning our write must be re-read");
      await flush(ff); assert.equal(writes(ff).length, 1);
    } finally { releaseRead(); releaseWrite(); sync.get = get; sync.set = set; }
  });
}

test("tile write failure logs once and keeps the committed layout without a retry loop", async () => {
  const { ff, root } = await setup(), sync = ff.browser.storage.sync, set = sync.set;
  const warnings = [], warn = console.warn; console.warn = (...args) => warnings.push(args);
  sync.set = async () => { throw new Error("Sync unavailable"); };
  try {
    const source = header(root), start = down(source);
    pointer("pointermove", document, shifted(start, 0, 192)); pointer("pointerup", document, shifted(start, 0, 192)); await flush(ff);
    assert.deepEqual(rect(tile(root)), { x: 0, y: 2, w: 3, h: 4 });
    assert.equal(warnings.length, 1); assert.ok(warnings[0][0].startsWith("Foxy:"));
    await flush(ff); assert.equal(warnings.length, 1);
    assert.deepEqual((await sync.get(null))["tile:10:group:a"], initial["tile:10:group:a"]);
  } finally { sync.set = set; console.warn = warn; }
});

test("failed layout reads gate tile drag writes", async () => {
  const { ff, root, control } = await setup(), sync = ff.browser.storage.sync, get = sync.get;
  const warn = console.warn; console.warn = () => {};
  try {
    sync.get = async keys => { if (keys === null) throw new Error("Layout unreadable"); return get(keys); };
    ff.fire("storage.onChanged", { settings: { newValue: {} } }, "sync"); await flush(ff); await control.refresh(); await flush(ff);
    const source = header(root), start = down(source);
    pointer("pointermove", document, shifted(start, 0, 192)); pointer("pointerup", document, shifted(start, 0, 192)); await flush(ff);
    assert.deepEqual(rect(tile(root)), { x: 0, y: 2, w: 3, h: 4 }); assert.deepEqual(writes(ff), []);
  } finally { sync.get = get; console.warn = warn; }
});

test("failed or malformed saved replies gate drag writes too", async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const { ff, root } = await setup({ listener: message => message.type === "foxy:reconcile" ? { ok: true }
      : message.type === "foxy:saved" ? { ok: false } : undefined });
    await new Promise(resolve => setTimeout(resolve, 550)); await flush(ff);
    const source = tile(root, "pinned").querySelector(".column-title"), start = down(source);
    const before = rect(tile(root, "pinned")).y;
    pointer("pointermove", document, shifted(start, 0, 192));
    assert.equal(rect(tile(root, "pinned")).y, before + 2, "the gated drag must still preview");
    pointer("pointerup", document, shifted(start, 0, 192)); await flush(ff);
    assert.deepEqual(writes(ff), []);
  } finally { console.warn = warn; }
});

// Deltas straddle half the stretched pitch (48.2115px), not half the preset
// pitch (48px). Moving and resizing must agree with the fractional cells.
for (const kind of ["move", "resize"]) {
  test(`${kind} snaps against fractional pitch and commits the shown rectangle only`, async () => {
    const { ff, root, control } = await setup({ width: 1237.5,
      settings: { showClock: false, showPinned: false }, layout: {
        "tile:10:group:a": { x: 0, y: 0, w: 3, h: 4 }, "tile:10:group:b": { x: 0, y: 4, w: 3, h: 4 },
      } });
    assert.ok(Math.abs(control.view.cell - (1253.5 / 13 - 16)) < 0.00001, "controller keeps the fractional page width");
    const source = kind === "move" ? header(root) : tile(root).querySelector(".tile-resize"), start = down(source);
    try {
      pointer("pointermove", document, shifted(start, 48.1, 0));
      assert.deepEqual(rect(tile(root)), { x: 0, y: 0, w: 3, h: 4 }, "still below the stretched half-pitch");
      pointer("pointermove", document, shifted(start, 48.3, 0));
      const expected = kind === "move" ? { x: 1, y: 0, w: 3, h: 4 } : { x: 0, y: 0, w: 4, h: 4 };
      assert.deepEqual(rect(tile(root)), expected);
      const box = root.querySelector(".drop-outline").getBoundingClientRect(), origin = root.querySelector(".grid").getBoundingClientRect();
      assert.ok(Math.abs(box.left - origin.left - expected.x * (1253.5 / 13)) < 0.5);
      assert.ok(Math.abs(box.width - (expected.w * (1253.5 / 13) - 16)) < 0.5);
      assert.deepEqual(writes(ff), []);
      pointer("pointerup", document, shifted(start, 48.3, 0)); await flush(ff);
      assert.deepEqual(rect(tile(root)), expected);
      assert.deepEqual(writes(ff), [{ "tile:10:group:a": expected }]);
    } finally { escape(); await flush(ff); }
  });
}


const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.1,
  `${message}: expected ${expected}, got ${actual}`);
const box = node => node.getBoundingClientRect();

// Removing activate's pinned start geometry makes the tile jump by two cells.
test("Q1 free follow keeps its start offset across a target change", async () => {
  const { ff, root } = await setup();
  const node = tile(root), before = box(node), start = down(header(root));
  try {
    pointer("pointermove", document, shifted(start, 37, 173));
    close(box(node).left - before.left, 37, "free x after target change");
    close(box(node).top - before.top, 173, "free y after target change");
    assert.equal(rect(root.querySelector(".drop-outline")).y, 2);
  } finally { escape(); await flush(ff); }
});

// Unchanged setProperty calls create no MutationObserver record. Count calls
// at the real CSS boundary to catch removal of preview's same-target guard.
test("Q2 same target does not rebuild preview", async () => {
  const { ff, root } = await setup();
  const start = down(header(root)), original = CSSStyleDeclaration.prototype.setProperty;
  let calls = 0;
  try {
    pointer("pointermove", document, shifted(start, 0, 192));
    CSSStyleDeclaration.prototype.setProperty = function (name, ...rest) {
      if (name === "--x") calls++;
      return original.call(this, name, ...rest);
    };
    for (let i = 0; i < 10; i++) pointer("pointermove", document, shifted(start, 5 + i, 200));
    assert.equal(calls, 0, "same-target moves must not rebuild tile geometry");
  } finally { CSSStyleDeclaration.prototype.setProperty = original; escape(); await flush(ff); }
});

// Removing positionTiles' --rows leaves a zero-height dots layer.
test("Q3 dots layer covers the viewport and occupied rows during a gesture", async () => {
  const { ff, root } = await setup({ layout: { ...initial, "tile:10:clock": { x: 5, y: 20, w: 5, h: 2 } } });
  const grid = root.querySelector(".grid"), dots = grid.querySelector(".grid-corners");
  const start = down(header(root));
  try {
    pointer("pointermove", document, shifted(start, 37, 173));
    assert.ok(grid.classList.contains("gesturing"));
    const height = box(dots).height;
    assert.ok(height >= grid.clientHeight, `dots layer height ${height} must cover viewport ${grid.clientHeight}`);
    assert.ok(height >= 2096, `dots layer height ${height} must cover 22 rows at 96px pitch minus 16px gap`);
  } finally { escape(); await flush(ff); }
});

// Missing a gesture scroll listener leaves both free geometry and target stale.
for (const kind of ["move", "resize"]) {
  test(`scroll during ${kind} keeps the free edge under the pointer and updates the outline`, async () => {
    const { ff, root } = await setup({ layout: { ...initial, "tile:10:clock": { x: 5, y: 20, w: 5, h: 2 } } });
    const grid = root.querySelector(".grid"), node = tile(root);
    const start = down(kind === "move" ? header(root) : node.querySelector(".tile-resize"));
    try {
      pointer("pointermove", document, shifted(start, 37, 100));
      const before = box(node);
      grid.scrollTop = 200; grid.dispatchEvent(new Event("scroll"));
      await nextFrame(); await nextFrame();
      const after = box(node), outline = root.querySelector(".drop-outline");
      close(kind === "move" ? after.top : after.bottom, kind === "move" ? before.top : before.bottom,
        "free pointer edge after scroll");
      close(after.left, before.left, "free x after scroll");
      assert.deepEqual(rect(outline), kind === "move" ? { x: 0, y: 3, w: 3, h: 4 } : { x: 0, y: 0, w: 3, h: 7 });
      close(kind === "move" ? box(outline).top : box(outline).bottom,
        box(grid).top + (kind === "move" ? 88 : 456), "outline follows scrolled content cell");
      assert.deepEqual(writes(ff), []);
    } finally { escape(); await flush(ff); }
    // A later scroll on the old container must not call preview for a finished drag.
    grid.dispatchEvent(new Event("scroll"));
  });
}

// Without grid isolation, the dragged tile's z-index escapes above the pane.
test("a dragged tile stays below the open settings pane where they overlap", async () => {
  const { ff, root, pane } = await setup({ withPane: true });
  root.querySelector(".settings-cell").click();
  assert.equal(pane.hidden, false);
  await new Promise(resolve => setTimeout(resolve, 220));
  const grid = root.querySelector(".grid"), start = down(header(root));
  try {
    pointer("pointermove", document, shifted(start, 800, 21));
    assert.ok(tile(root).classList.contains("dragging"));
    const x = box(grid).right - 20, y = box(grid).top + 100;
    assert.ok(x > box(pane).left && y < box(pane).bottom, "probe lies inside the pane");
    assert.ok(x > box(tile(root)).left && y > box(tile(root)).top, "dragged tile overlaps the probe");
    const hit = document.elementFromPoint(x, y);
    assert.ok(hit === pane || pane.contains(hit), `pane must cover dragged content, got ${hit?.className}`);
  } finally { escape(); await flush(ff); }
});

// Snapping the captured tile instead of just its target loses these exact deltas.
test("free move follows 37px by 21px while the neutral outline stays snapped", async () => {
  const { ff, root } = await setup();
  const node = tile(root), before = box(node), start = down(header(root));
  try {
    pointer("pointermove", document, shifted(start, 37, 21));
    const moved = box(node), outline = root.querySelector(".drop-outline");
    assert.ok(outline, "active move needs an outline");
    close(moved.left - before.left, 37, "free x"); close(moved.top - before.top, 21, "free y");
    close(box(outline).left, before.left, "snapped x"); close(box(outline).top, before.top, "snapped y");
    close(box(outline).width, 272, "snapped width"); close(box(outline).height, 368, "snapped height");
    assert.ok(node.classList.contains("dragging"));
    assert.equal(getComputedStyle(node).boxShadow, "none");
    assert.ok(Number(getComputedStyle(node).zIndex) > Number(getComputedStyle(outline).zIndex));
    for (const [scheme, line, fill] of [["dark", "rgba(255, 255, 255, 0.45)", "rgba(255, 255, 255, 0.08)"],
      ["light", "rgba(0, 0, 0, 0.45)", "rgba(0, 0, 0, 0.08)"]]) {
      root.style.colorScheme = scheme;
      const style = getComputedStyle(outline);
      assert.equal(style.borderTopWidth, "2px"); assert.equal(style.borderTopStyle, "solid");
      assert.equal(style.borderTopColor, line); assert.equal(style.backgroundColor, fill);
      assert.equal(style.borderRadius, "12px"); assert.equal(style.pointerEvents, "none");
    }
    assert.deepEqual(writes(ff), []);
  } finally { escape(); await flush(ff); }
});

// Rebuilding an unchanged target mutates neighbours unnecessarily; skipping a
// changed target or queuing old previews leaves their final layout wrong.
test("neighbours slide only on target changes and rapid reversals keep the last target", async () => {
  const { ff, root } = await setup();
  const neighbour = tile(root, "group:b"), start = down(header(root));
  try {
    pointer("pointermove", document, shifted(start, 0, 192));
    assert.equal(rect(neighbour).y, 6);
    assert.equal(getComputedStyle(neighbour).transitionDuration, "0.2s, 0.2s, 0.2s, 0.2s, 0.2s");
    const mutations = [], observer = new MutationObserver(records => mutations.push(...records));
    observer.observe(neighbour, { attributes: true, attributeFilter: ["style"] });
    pointer("pointermove", document, shifted(start, 12, 200)); await Promise.resolve();
    observer.disconnect(); assert.equal(mutations.length, 0, "same target must not rebuild the preview");
    for (const dy of [0, 288, 96, 192, 0, 192]) pointer("pointermove", document, shifted(start, 12, dy));
    assert.equal(rect(neighbour).y, 6);
    await new Promise(resolve => setTimeout(resolve, 240));
    close(box(neighbour).top - box(root.querySelector(".grid")).top, 576, "last neighbour target");
    pointer("pointermove", document, shifted(start, 12, 0));
    assert.equal(rect(neighbour).y, 4);
    await new Promise(resolve => setTimeout(resolve, 240));
    close(box(neighbour).top - box(root.querySelector(".grid")).top, 384, "reversed neighbour target");
    assert.deepEqual(writes(ff), []);
  } finally { escape(); await flush(ff); }
});

// Dots normally ignore pointer events. Enable hit testing only for this probe
// so elementFromPoint checks their paint order, not just pointer-events:none.
test("corner dots stay behind clock, pinned, saved and group tiles during a gesture", async () => {
  const layout = {
    "tile:10:clock": { x: 0, y: 0, w: 3, h: 2 },
    "tile:10:pinned": { x: 3, y: 0, w: 2, h: 2 },
    "tile:10:saved": { x: 5, y: 0, w: 2, h: 2 },
    "tile:10:group:a": { x: 0, y: 2, w: 3, h: 4 },
    "tile:10:group:b": { x: 3, y: 2, w: 3, h: 4 },
  };
  const { ff, root } = await setup({ layout, listener: message => message.type === "foxy:reconcile"
    ? { ok: true } : message.type === "foxy:saved"
      ? { folders: { 1: "a", 2: "b" }, saved: [{ folderId: "closed", title: "Closed" }], missing: [] } : undefined });
  const grid = root.querySelector(".grid"), dots = grid.querySelector(".grid-corners");
  const start = down(header(root)); pointer("pointermove", document, shifted(start, 12, 0));
  try {
    assert.ok(grid.classList.contains("gesturing"));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(getComputedStyle(dots).opacity, "1");
    dots.style.pointerEvents = "auto";
    const origin = grid.getBoundingClientRect();
    for (const id of ["clock", "pinned", "saved", "group:b"]) {
      const node = tile(root, id), saved = layout[`tile:10:${id}`];
      // 88px is the first 96px-pitch gap intersection within these multi-cell cards.
      const hit = document.elementFromPoint(origin.left + saved.x * 96 + 88,
        origin.top + saved.y * 96 + 88);
      assert.ok(hit === node || node.contains(hit), `${id}: the tile covers its internal corner dot`);
      assert.equal(getComputedStyle(node).zIndex, "1", `${id}: tile layer`);
    }
    assert.equal(getComputedStyle(dots).zIndex, "0", "dots stay below all tiles");
    assert.equal(getComputedStyle(grid.querySelector(".drop-outline")).zIndex, "2");
    assert.equal(getComputedStyle(tile(root)).zIndex, "3", "dragged tile stays above the target");
    const emptyHit = document.elementFromPoint(origin.left + 7 * 96 + 88, origin.top + 2 * 96 + 88);
    assert.ok(emptyHit === dots || dots.contains(emptyHit), "the dots layer still paints in empty space");
  } finally { dots.style.pointerEvents = ""; escape(); await flush(ff); }
});

// A full-grid dot image shows through glass cards. Check the generated dots,
// not hit testing, which cannot detect paint through translucent tiles.
for (const kind of ["move", "resize"]) {
  test(`${kind} dots omit resting interiors and follow pushed preview tiles only on target changes`, async () => {
    const { ff, root } = await setup(), grid = root.querySelector(".grid");
    const dots = grid.querySelector(".grid-corners");
    const source = kind === "move" ? header(root) : tile(root).querySelector(".tile-resize");
    const start = down(source);
    const points = () => [...dots.querySelectorAll("circle")].map(circle =>
      [Number(circle.getAttribute("cx")), Number(circle.getAttribute("cy"))]);
    const has = (x, y) => points().some(([cx, cy]) => cx === x && cy === y);
    const checkInteriors = () => {
      for (const [cx, cy] of points()) {
        const i = (cx + 8) / 96, j = (cy + 8) / 96;
        for (const node of grid.querySelectorAll(".tile:not(.dragging)")) {
          const { x, y, w, h } = rect(node);
          assert.equal(x < i && i < x + w && y < j && j < y + h, false,
            `dot (${i}, ${j}) must not show through ${node.dataset.tileId}`);
        }
      }
    };
    try {
      pointer("pointermove", document, shifted(start, 12, 0));
      assert.ok(has(88, 88), "the dragged tile's start area keeps its dot");
      assert.ok(has(280, 184), "tile edges keep their gap-crossing dot");
      assert.ok(has(376, 88), "an uncovered crossing keeps its dot");
      assert.equal(has(88, 472), false, "resting group interior has no dot");
      assert.equal(has(568, 88), false, "resting pinned interior has no dot");
      assert.equal(has(568, 472), false, "resting clock interior has no dot");
      checkInteriors();
      const changes = [], observer = new MutationObserver(records => changes.push(...records));
      observer.observe(dots, { childList: true, subtree: true, attributes: true });
      try {
        for (let x = 13; x < 23; x++) pointer("pointermove", document, shifted(start, x, 0));
        await Promise.resolve();
        assert.equal(changes.length, 0, "same-target moves do not rebuild dots");
      } finally { observer.disconnect(); }
      pointer("pointermove", document, shifted(start, 12, 192));
      assert.equal(rect(tile(root, "group:b")).y, 6, "preview pushes the resting group");
      assert.ok(has(88, 472), "the pushed group's old interior is uncovered");
      assert.equal(has(88, 664), false, "the pushed group's new interior has no dot");
      checkInteriors();
      pointer("pointermove", document, shifted(start, 12, 0));
      assert.equal(has(88, 472), false, "dots follow the returning group too");
      checkInteriors();
    } finally { escape(); await flush(ff); }
  });
}

test("cell-corner dots fade only for tile gestures, centred in gap intersections", async () => {
  const { ff, root } = await setup(), grid = root.querySelector(".grid");
  const dots = grid.querySelector(".grid-corners"); assert.ok(dots);
  assert.equal(getComputedStyle(dots).opacity, "0");
  const start = down(header(root)); pointer("pointermove", document, shifted(start, 12, 0));
  try {
    assert.ok(grid.classList.contains("gesturing"));
    await new Promise(resolve => setTimeout(resolve, 150));
    const style = getComputedStyle(dots);
    assert.equal(style.opacity, "1"); assert.equal(style.transitionDuration, "0.12s");
    const circle = dots.querySelector('circle[cx="88"][cy="88"]');
    assert.ok(circle, "dot is centred at the 88px gap crossing");
    assert.ok([...dots.querySelectorAll("circle")].every(circle => circle.getAttribute("r") === "1.5"), "3px diameter dots");
    for (const [scheme, fill] of [["dark", "rgba(255, 255, 255, 0.35)"], ["light", "rgba(0, 0, 0, 0.35)"]]) {
      root.style.colorScheme = scheme;
      assert.equal(getComputedStyle(circle).fill, fill, "35% neutral dots in either theme");
    }
    escape(); assert.equal(grid.classList.contains("gesturing"), false);
    await flush(ff); assert.equal(getComputedStyle(dots).opacity, "0");
    assert.equal(root.querySelector(".drop-outline"), null);
    const railStart = down(root.querySelector(".rail-resize"));
    pointer("pointermove", document, shifted(railStart, -96, 0));
    assert.equal(root.querySelector(".grid").classList.contains("gesturing"), false, "rail keeps its old snapping");
  } finally { escape(); await flush(ff); }
});

for (const kind of ["move", "resize"]) {
  for (const end of ["release", "cancel"]) {
    test(`${kind} ${end} holds remote renders through the slide but release saves at once`, async () => {
      const { ff, root, control } = await setup();
      const node = tile(root), neighbour = tile(root, "group:b"), original = box(node);
      const source = kind === "move" ? header(root) : node.querySelector(".tile-resize"), start = down(source);
      pointer("pointermove", document, shifted(start, 37, 173));
      const target = box(root.querySelector(".drop-outline"));
      await ff.browser.storage.sync.set({ "tile:10:pinned": { x: 5, y: 20, w: 3, h: 4 } });
      await flush(ff); ff.calls.length = 0;
      const pinned = tile(root, "pinned");
      if (end === "release") pointer("pointerup", document, shifted(start, 37, 173)); else escape();
      for (let i = 0; i < 6; i++) await Promise.resolve();
      assert.equal(control.ui.gridDragging, true, "hold extends through settlement");
      assert.equal(tile(root), node, "captured node is retained while sliding");
      assert.equal(tile(root, "pinned"), pinned); assert.equal(rect(pinned).y, 0);
      assert.deepEqual(writes(ff), end === "cancel" ? [] : [{ "tile:10:group:a": kind === "move"
        ? { x: 0, y: 2, w: 3, h: 4 } : { x: 0, y: 0, w: 3, h: 6 },
        "tile:10:group:b": { x: 0, y: 6, w: 3, h: 4 } }], "release saves before the visual slide ends");
      const beforeSlide = box(node);
      assert.equal(getComputedStyle(node).zIndex, "3", "settling tile stays above the outline and neighbours");
      await new Promise(resolve => setTimeout(resolve, 80));
      const duringSlide = box(node);
      assert.ok(kind === "move" ? Math.abs(duringSlide.top - beforeSlide.top) > 0.1
        : Math.abs(duringSlide.height - beforeSlide.height) > 0.1, "release/cancel actually animates");
      await flush(ff);
      assert.equal(control.ui.gridDragging, false); assert.equal(rect(tile(root, "pinned")).y, 20);
      const landed = box(tile(root)), expected = end === "release" ? target : original;
      close(landed.left, expected.left, "landed x"); close(landed.top, expected.top, "landed y");
      close(landed.width, expected.width, "landed width"); close(landed.height, expected.height, "landed height");
      if (end === "cancel") { assert.deepEqual(writes(ff), []); assert.equal(rect(neighbour).y, 4); }
      else assert.deepEqual(writes(ff), [{ "tile:10:group:a": kind === "move"
        ? { x: 0, y: 2, w: 3, h: 4 } : { x: 0, y: 0, w: 3, h: 6 },
        "tile:10:group:b": { x: 0, y: 6, w: 3, h: 4 } }]);
    });
  }
}

// Releasing onState before the slide ends replaces the captured node and jumps
// to a board update that arrives after pointerup, not just one held before it.
test("a board update arriving during the release slide stays held until landing", async () => {
  const { ff, root, control } = await setup();
  const node = tile(root), pinned = tile(root, "pinned"), start = down(header(root));
  const target = shifted(start, 37, 173);
  pointer("pointermove", document, target);
  const landing = box(root.querySelector(".drop-outline"));
  pointer("pointerup", document, target); await nextFrame();
  const dropWrites = [{ "tile:10:group:a": { x: 0, y: 2, w: 3, h: 4 }, "tile:10:group:b": { x: 0, y: 6, w: 3, h: 4 } }];
  assert.deepEqual(writes(ff), dropWrites, "release saved before the incoming update");
  const remote = { "tile:10:pinned": { x: 5, y: 20, w: 3, h: 4 } };
  await ff.browser.storage.sync.set(remote); await ff.settle();
  assert.equal(control.ui.gridDragging, true);
  assert.equal(tile(root), node, "the sliding node must not be replaced");
  assert.equal(tile(root, "pinned"), pinned); assert.equal(rect(pinned).y, 0, "incoming update is held");
  await flush(ff);
  assert.equal(control.ui.gridDragging, false); assert.equal(rect(tile(root, "pinned")).y, 20);
  close(box(tile(root)).left, landing.left, "landing x after held render");
  close(box(tile(root)).top, landing.top, "landing y after held render");
  assert.deepEqual(writes(ff), [...dropWrites, remote], "no duplicate drop or unrelated tile write");
});

test("free resize follows the pointer in pixels and clamps to minimum and available width", async () => {
  const { ff, root } = await setup(), node = tile(root), original = box(node);
  const start = down(node.querySelector(".tile-resize"));
  try {
    pointer("pointermove", document, shifted(start, 37, 21));
    close(box(node).width - original.width, 37, "free width"); close(box(node).height - original.height, 21, "free height");
    close(box(root.querySelector(".drop-outline")).width, 272, "snapped width");
    pointer("pointermove", document, shifted(start, -2000, -2000));
    close(box(node).width, 176, "minimum width"); close(box(node).height, 176, "minimum height");
    pointer("pointermove", document, shifted(start, 2000, 0)); close(box(node).width, 944, "column cap");
    assert.deepEqual(writes(ff), []);
  } finally { escape(); await flush(ff); }
});

for (const kind of ["move", "resize"]) {
  test(`window resize cancels ${kind} without stale geometry or a stuck hold`, async () => {
    const { ff, root, control } = await setup();
    const start = down(kind === "move" ? header(root) : tile(root).querySelector(".tile-resize"));
    pointer("pointermove", document, shifted(start, 37, 173));
    root.style.width = "560px"; window.dispatchEvent(new Event("resize"));
    await flush(ff);
    assert.equal(control.ui.gridDragging, false); assert.equal(root.hasAttribute("data-grid-dragging"), false);
    assert.equal(root.querySelector(".drop-outline"), null); assert.equal(root.querySelector(".tile.dragging"), null);
    assert.deepEqual(writes(ff), []);
    assert.deepEqual(rect(tile(root)), initial["tile:10:group:a"]);
    pointer("pointerup", document, shifted(start, 37, 173)); await flush(ff); assert.deepEqual(writes(ff), []);
  });
}

// Suppressed transition events must still release the hold at the 300ms fallback.
test("settlement has a timeout when transitionend is missing and ignores unrelated events", async () => {
  const { ff, root, control } = await setup();
  const node = tile(root), start = down(header(root));
  root.addEventListener("transitionend", event => event.stopImmediatePropagation(), true);
  pointer("pointermove", document, shifted(start, 37, 173));
  pointer("pointerup", document, shifted(start, 37, 173));
  node.dispatchEvent(new TransitionEvent("transitionend", { bubbles: true, propertyName: "opacity" }));
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(control.ui.gridDragging, true); assert.equal(writes(ff).length, 1, "saving does not wait for the fallback");
  await flush(ff); assert.equal(control.ui.gridDragging, false); assert.equal(writes(ff).length, 1);
});

// Firefox's media preference is browser-owned. Enable its real media rules in
// the stylesheet; the absence of CSS transitions must also skip the slide wait.
test("reduced motion makes neighbour and release positions immediate without a hold delay", async () => {
  const { ff, root, control } = await setup();
  const rules = [...document.styleSheets].filter(sheet => sheet.href?.endsWith("/extension/newtab.css"))
    .flatMap(sheet => [...sheet.cssRules]).filter(rule => rule.conditionText === "(prefers-reduced-motion: reduce)");
  const conditions = rules.map(rule => rule.media.mediaText);
  try {
    rules.forEach(rule => { rule.media.mediaText = "all"; });
    const node = tile(root), start = down(header(root));
    pointer("pointermove", document, shifted(start, 37, 173));
    assert.equal(getComputedStyle(tile(root, "group:b")).transitionDuration, "0s");
    close(box(tile(root, "group:b")).top - box(root.querySelector(".grid")).top, 576, "immediate neighbour");
    const target = box(root.querySelector(".drop-outline"));
    pointer("pointerup", document, shifted(start, 37, 173));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    close(box(tile(root)).left, target.left, "immediate landing x"); close(box(tile(root)).top, target.top, "immediate landing y");
    assert.equal(control.ui.gridDragging, false); await flush(ff); assert.equal(writes(ff).length, 1);
  } finally { rules.forEach((rule, i) => { rule.media.mediaText = conditions[i]; }); escape(); await flush(ff); }
});


test("real geometry transitionend releases settlement before the fallback, unrelated events cannot", async () => {
  const { ff, root, control } = await setup();
  const node = tile(root), source = header(root), start = down(source);
  pointer("pointermove", document, shifted(start, 37, 173));
  pointer("pointerup", document, shifted(start, 37, 173));
  await nextFrame();
  node.dispatchEvent(new TransitionEvent("transitionend", { bubbles: true, propertyName: "opacity" }));
  source.dispatchEvent(new TransitionEvent("transitionend", { bubbles: true, propertyName: "top" }));
  assert.equal(control.ui.gridDragging, true, "only pending tile geometry transitions can end the hold");
  assert.equal(writes(ff).length, 1, "release already saved while geometry transitions are pending");
  await new Promise(resolve => setTimeout(resolve, 240));
  assert.equal(control.ui.gridDragging, false, "real transitionend must finish without waiting for 300ms");
  await flush(ff); assert.equal(writes(ff).length, 1);
});


// A visual slide cannot revoke a drop accepted by the release-time group gate.
test("a group closed during its release slide keeps the accepted drop and pushes", async () => {
  const { ff, root, control } = await setup();
  const start = down(header(root)), target = shifted(start, 37, 173);
  pointer("pointermove", document, target); pointer("pointerup", document, target);
  await nextFrame();
  assert.equal(control.ui.gridDragging, true);
  await ff.browser.tabs.remove(10); await ff.settle();
  assert.ok(tile(root), "group removal stays held during settlement");
  await new Promise(resolve => setTimeout(resolve, 650)); await flush(ff);
  assert.equal(control.ui.gridDragging, false); assert.equal(tile(root), undefined);
  assert.deepEqual(rect(tile(root, "group:b")), { x: 0, y: 6, w: 3, h: 4 });
  assert.deepEqual(writes(ff), [{ "tile:10:group:a": { x: 0, y: 2, w: 3, h: 4 }, "tile:10:group:b": { x: 0, y: 6, w: 3, h: 4 } }]);
  assert.equal(ff.calls.filter(call => call.api === "tabGroups.get").length, 1, "the group gate runs only at release");
});

// Delaying onCommit until settlement loses these releases to the unload gate.
for (const id of ["group:a", "clock"]) {
  for (const kind of ["move", "resize"]) {
    test(`pagehide right after ${id} ${kind} release preserves the gesture write`, async () => {
      const { ff, root, control } = await setup(), node = tile(root, id);
      const source = node.querySelector(kind === "resize" ? ".tile-resize" : id === "clock" ? ".tile-header" : ".column-header");
      const start = down(source), target = shifted(start, 37, 173);
      pointer("pointermove", document, target); pointer("pointerup", document, target);
      // Group releases have the same asynchronous existence check as 3.0.0.
      // Non-group pagehide is synchronous with pointerup, before any microtask.
      if (id === "group:a") for (let i = 0; i < 6; i++) await Promise.resolve();
      assert.equal(control.ui.gridDragging, true, "pagehide precedes the end of the visual slide");
      window.dispatchEvent(new Event("pagehide"));
      await flush(ff);
      const wanted = id === "clock" ? { "tile:10:clock": kind === "move"
        ? { x: 5, y: 6, w: 5, h: 2 } : { x: 5, y: 4, w: 5, h: 4 } }
        : { "tile:10:group:a": kind === "move" ? { x: 0, y: 2, w: 3, h: 4 } : { x: 0, y: 0, w: 3, h: 6 },
          "tile:10:group:b": { x: 0, y: 6, w: 3, h: 4 } };
      assert.deepEqual(writes(ff), [wanted], "accepted drop saves exactly once, with 3.0.0 tile rectangles");
      const stored = await ff.browser.storage.sync.get(Object.keys(wanted));
      assert.deepEqual(stored, wanted);
      assert.equal(control.ui.gridDragging, false);
    });
  }
}

// Unload before the release-time existence check resolves still cancels a drop.
test("pagehide during the release group check prevents the gesture write", async () => {
  const { ff, root, control } = await setup(), get = ff.browser.tabGroups.get;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  ff.browser.tabGroups.get = async id => { await gate; return get(id); };
  try {
    const start = down(header(root)), target = shifted(start, 37, 173);
    pointer("pointermove", document, target); pointer("pointerup", document, target);
    window.dispatchEvent(new Event("pagehide"));
    release(); await flush(ff);
    assert.deepEqual(writes(ff), []);
    assert.equal(control.ui.gridDragging, false);
  } finally { release(); ff.browser.tabGroups.get = get; }
});
