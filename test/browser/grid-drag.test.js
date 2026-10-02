import { test, assert, fixture, nextFrame, withPseudoState } from "./harness.js";
import { createBoardFirefox } from "./controller.js";
import { createController } from "../../extension/src/main.js";

let css;
async function flush(ff) {
  await ff.settle();
  for (let i = 0; i < 5; i++) await nextFrame();
}
const initial = {
  "tile:group:a": { x: 0, y: 0, w: 3, h: 4 },
  "tile:group:b": { x: 0, y: 4, w: 3, h: 4 },
  "tile:pinned": { x: 5, y: 0, w: 3, h: 4 },
  "tile:clock": { x: 5, y: 4, w: 5, h: 2 },
};
async function setup({ layout = initial, width = 1232, settings = {}, folders = { 1: "a", 2: "b" }, extraGroups = [], listener } = {}) {
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
  await ff.browser.storage.sync.set({ ...layout, settings }); await ff.settle();
  const root = document.createElement("div"); root.className = "board";
  root.style.cssText = `width:${width}px;height:600px`; fixture().append(root);
  const control = createController(root, ff.browser);
  await control.refresh(); await flush(ff); ff.calls.length = 0;
  return { ff, root, control };
}
const tile = (root, id = "group:a") => [...root.querySelectorAll(".tile")].find(node => node.dataset.tileId === id);
const header = root => tile(root).querySelector(".column-header");
const rect = node => ({ x: Number(node.style.gridColumnStart) - 1, y: Number(node.style.gridRowStart) - 1,
  w: Number(node.style.gridColumnEnd.replace("span ", "")), h: Number(node.style.gridRowEnd.replace("span ", "")) });
const writes = ff => ff.calls.filter(call => call.api === "storage.sync.set").map(call => call.args[0]);
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
  assert.equal(getComputedStyle(node).opacity, "0.85");
  assert.deepEqual(captures, [1], "the pointer source must request capture");
  assert.deepEqual(writes(ff), [], "preview must not write");
  pointer("pointerup", document, shifted(start, 20, 192)); source.click(); await flush(ff);
  assert.equal(root.querySelector(".name-editor"), null, "a post-drag click cannot rename");
  assert.deepEqual(writes(ff), [{ "tile:group:a": { x: 0, y: 2, w: 3, h: 4 }, "tile:group:b": { x: 0, y: 6, w: 3, h: 4 } }]);
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
  assert.deepEqual(rect(tile(root)), initial["tile:group:a"]); assert.deepEqual(writes(ff), []);
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
      assert.deepEqual(rect(tile(root)), initial["tile:group:a"]);
      assert.deepEqual(rect(tile(root, "group:b")), initial["tile:group:b"]);
      assert.equal(root.querySelector(".rail").getBoundingClientRect().width, 272);
      assert.deepEqual(writes(ff), []);
      pointer("pointerup", document, shifted(start, 192, 192)); await flush(ff); assert.deepEqual(writes(ff), []);
    });
  }
}

test("resize corner snaps its bottom right, pushes live and respects minima and columns", async () => {
  const { ff, root } = await setup();
  let source = tile(root).querySelector(".tile-resize"); assert.ok(source);
  let start = down(source, point(source, 0.5, 0.5));
  pointer("pointermove", document, shifted(start, 192, 192));
  assert.deepEqual(rect(tile(root)), { x: 0, y: 0, w: 5, h: 6 });
  assert.deepEqual(rect(tile(root, "group:b")), { x: 0, y: 6, w: 3, h: 4 });
  pointer("pointerup", document, shifted(start, 192, 192)); await flush(ff);
  assert.deepEqual(writes(ff), [{ "tile:group:a": { x: 0, y: 0, w: 5, h: 6 }, "tile:group:b": { x: 0, y: 6, w: 3, h: 4 } }]);
  source = tile(root).querySelector(".tile-resize"); start = down(source);
  pointer("pointermove", document, shifted(start, -2000, -2000));
  assert.deepEqual(rect(tile(root)), { x: 0, y: 0, w: 2, h: 2 });
  pointer("pointermove", document, shifted(start, 2000, 0)); assert.equal(rect(tile(root)).w, 10); escape(); await flush(ff);
  source = tile(root, "clock").querySelector(".tile-resize"); start = down(source);
  pointer("pointermove", document, shifted(start, -2000, -2000));
  assert.equal(rect(tile(root, "clock")).w, 3); assert.equal(rect(tile(root, "clock")).h, 2); escape();
});

test("every tile has a subtle 16px hover and focus resize corner, clock has a move header", async () => {
  const { root } = await setup();
  for (const node of root.querySelectorAll(".tile")) {
    const handle = node.querySelector(".tile-resize"); assert.ok(handle);
    const bounds = handle.getBoundingClientRect(), card = node.getBoundingClientRect(), style = getComputedStyle(handle);
    assert.equal(bounds.width, 16); assert.equal(bounds.height, 16);
    assert.equal(style.cursor, "nwse-resize"); assert.equal(style.opacity, "0");
    assert.ok(bounds.right <= card.right && bounds.bottom <= card.bottom);
    withPseudoState([node], "hover", () => assert.equal(getComputedStyle(handle).opacity, "1"));
    handle.focus(); assert.equal(document.activeElement, handle);
    withPseudoState([node], "focus-within", () => assert.equal(getComputedStyle(handle).opacity, "1")); handle.blur();
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

for (const kind of ["move", "resize", "rail"]) {
  for (const end of ["release", "cancel"]) {
    test(`remote storage updates during ${kind} are held and applied after ${end}`, async () => {
      const { ff, root } = await setup();
      const source = kind === "move" ? header(root) : kind === "resize" ? tile(root).querySelector(".tile-resize") : root.querySelector(".rail-resize");
      assert.ok(source); const start = down(source), original = tile(root, "pinned");
      pointer("pointermove", document, shifted(start, kind === "rail" ? -96 : 0, 96));
      await ff.browser.storage.sync.set({ "tile:pinned": { x: 0, y: 20, w: 3, h: 4 }, settings: { transparency: "high" } });
      await flush(ff);
      assert.equal(tile(root, "pinned"), original, "no DOM replacement while captured");
      assert.equal(rect(original).y, 0, "remote position is held during preview");
      if (end === "release") pointer("pointerup", document, shifted(start, kind === "rail" ? -96 : 0, 96)); else escape();
      await flush(ff);
      assert.equal(rect(tile(root, "pinned")).y, 20);
      assert.equal(root.style.getPropertyValue("--card-alpha-dark"), "0.45");
      const localWrites = writes(ff).slice(1);
      assert.ok(localWrites.every(entry => !("tile:pinned" in entry)), "an unrelated remote tile must not be written back");
      if (kind === "rail" && end === "release") assert.deepEqual(localWrites, [{ settings: { transparency: "high", railCells: 4 } }]);
      if (end === "cancel") assert.deepEqual(localWrites, []);
    });
  }
}

test("narrow fit writes nothing, move uses shown tiles and saves only moved or pushed rectangles", async () => {
  const layout = { "tile:group:a": { x: 7, y: 0, w: 3, h: 4 }, "tile:group:b": { x: 0, y: 4, w: 5, h: 4 },
    "tile:group:c": { x: 8, y: 10, w: 5, h: 4 } };
  const { ff, root } = await setup({ layout, folders: { 1: "a", 2: "b", 3: "c" }, settings: { showClock: false, showPinned: false },
    extraGroups: [{ id: 3, windowId: 1, title: "C" }] });
  root.style.width = "560px"; window.dispatchEvent(new Event("resize")); await flush(ff);
  assert.deepEqual(rect(tile(root)), { x: 0, y: 0, w: 3, h: 4 });
  assert.deepEqual(rect(tile(root, "group:c")), { x: 0, y: 10, w: 3, h: 4 }); assert.deepEqual(writes(ff), []);
  const source = header(root), start = down(source); pointer("pointermove", document, shifted(start, 0, 192));
  pointer("pointerup", document, shifted(start, 0, 192)); await flush(ff);
  assert.deepEqual(writes(ff), [{ "tile:group:a": { x: 0, y: 2, w: 3, h: 4 }, "tile:group:b": { x: 0, y: 6, w: 3, h: 4 } }]);
  assert.deepEqual((await ff.browser.storage.sync.get(null))["tile:group:c"], layout["tile:group:c"]);
  root.style.width = "1232px"; window.dispatchEvent(new Event("resize")); await flush(ff);
  assert.deepEqual(rect(tile(root)), { x: 0, y: 2, w: 3, h: 4 });
});

for (const kind of ["move", "resize"]) {
  test(`${kind} uses grid padding and scroll content coordinates`, async () => {
    const { ff, root } = await setup({ layout: { ...initial, "tile:group:a": { x: 0, y: 8, w: 3, h: 4 } } });
    const grid = root.querySelector(".grid"); grid.style.padding = "12px 0 0 20px"; grid.scrollTop = 576;
    const source = kind === "move" ? header(root) : tile(root).querySelector(".tile-resize"); assert.ok(source);
    const start = down(source); pointer("pointermove", document, shifted(start, 96, -96));
    assert.deepEqual(rect(tile(root)), kind === "move" ? { x: 1, y: 7, w: 3, h: 4 } : { x: 0, y: 8, w: 4, h: 3 });
    escape(); await flush(ff); assert.deepEqual(writes(ff), []);
  });
  test(`${kind} auto-scrolls vertically and the snapped target follows the scroll`, async () => {
    const { root } = await setup({ layout: { ...initial, "tile:clock": { x: 5, y: 20, w: 5, h: 2 } } });
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
    const { ff, root, control } = await setup({ layout: { "tile:group:b": { x: 0, y: 4, w: 3, h: 4 } }, settings: { showClock: false, showPinned: false },
      listener: message => message.type === "foxy:reconcile" ? { ok: true } : message.type === "foxy:saved" ? { saved: [], missing: [], folders } : undefined });
    const source = kind === "move" ? tile(root, "local:1").querySelector(".column-header") : tile(root, "local:1").querySelector(".tile-resize"); assert.ok(source);
    const start = down(source); pointer("pointermove", document, shifted(start, 0, 192));
    pointer("pointerup", document, shifted(start, 0, 192)); await flush(ff);
    const wanted = kind === "move" ? { x: 0, y: 2, w: 3, h: 4 } : { x: 0, y: 0, w: 3, h: 6 };
    assert.deepEqual(rect(tile(root, "local:1")), wanted); assert.equal(rect(tile(root, "group:b")).y, 6);
    assert.deepEqual(writes(ff), [], "pending tiles and their pushes wait for the mapping");
    folders = { 1: "a", 2: "b" }; await control.refresh(); await flush(ff);
    assert.deepEqual(writes(ff), [{ "tile:group:b": { x: 0, y: 6, w: 3, h: 4 }, "tile:group:a": wanted }]);
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
    assert.deepEqual(rect(tile(root)), initial["tile:group:a"]); assert.deepEqual(writes(ff), []);
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
    assert.deepEqual((await sync.get(null))["tile:group:a"], initial["tile:group:a"]);
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
