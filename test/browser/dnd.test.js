import { test, assert, fixture, dispatchDrag, nextFrame } from "./harness.js";
import { createBoardFirefox as createFirefox } from "./controller.js";
import { buildBoard } from "../../extension/src/board/model.js";

const TAB = "application/x-foxy-tab", GROUP = "application/x-foxy-group";
const setup = () => ({
  windows: [{ id: 1, focused: true }, { id: 2 }], selfTabId: 99,
  groups: [{ id: 101, windowId: 1, title: "First" }, { id: 102, windowId: 1, title: "Second" },
    { id: 201, windowId: 2, title: "Remote" }],
  tabs: [{ id: 11, windowId: 1, pinned: true }, { id: 12, windowId: 1, groupId: 101 },
    { id: 13, windowId: 1, groupId: 101 }, { id: 14, windowId: 1, groupId: 102 },
    { id: 15, windowId: 1 }, { id: 99, windowId: 1, url: location.origin + location.pathname },
    { id: 21, windowId: 2, pinned: true }, { id: 22, windowId: 2, groupId: 201 },
    { id: 23, windowId: 2 }].map(tab => ({ ...tab, lastAccessed: 100 / tab.windowId })),
});
let css;
async function makeRoot(width = 1520) {
  css ??= new Promise(resolve => {
    const link = document.createElement("link");
    link.rel = "stylesheet"; link.href = "/extension/newtab.css"; link.onload = resolve;
    document.head.append(link);
  });
  await css;
  const root = document.createElement("div");
  root.className = "board"; root.style.width = `${width}px`; root.style.height = "500px";
  fixture().append(root);
  return root;
}
async function draw(set = setup(), width = 1520) {
  const ff = createFirefox(set), root = await makeRoot(width);
  const board = buildBoard({ windows: await ff.browser.windows.getAll(), tabs: await ff.browser.tabs.query({}),
    groups: await ff.browser.tabGroups.query({}), currentWindowId: 1, selfTabId: 99 });
  const calls = { tabs: [], states: [], opened: [] };
  const handlers = { onTabDrop: (...args) => calls.tabs.push(args), onDragState: value => calls.states.push(value), onOpen: row => calls.opened.push(row.id) };
  const { renderBoard } = await import("./view.js");
  renderBoard(root, board, {}, handlers);
  return { root, board, calls, handlers, renderBoard };
}
// Firefox targets the draggable ancestor, not the input, on a real pointer drag.
// Omitting the source-column editor guard starts a drag and fades this header.
for (const editor of ["name", "colour"]) {
  test(`${editor} editor blocks ancestor-target dragstart without fading or a drag hold`, async () => {
    const { root, calls } = await draw();
    const source = header(root);
    source.querySelector(editor === "name" ? ".group-name" : ".dot").click();
    const dt = start(source);
    try {
      assert.deepEqual(calls.states, [], "an open editor must not start a drag hold");
      assert.equal(dt.getData(GROUP), "");
      assert.equal(source.classList.contains("dragging"), false);
      assert.equal(getComputedStyle(source).opacity, "1");
    } finally {
      dispatchDrag("dragend", source, { dataTransfer: dt });
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
  });
}

const tab = root => root.querySelector('[data-tab-id="15"]');
const header = root => root.querySelector('.column[data-group-id="201"] .column-header');
function start(source) { return dispatchDrag("dragstart", source).dataTransfer; }
function point(node, x = 0.5, y = 0.5) {
  const r = node.getBoundingClientRect();
  return { clientX: r.left + r.width * x, clientY: r.top + r.height * y };
}
function clean(root) {
  assert.equal(root.querySelectorAll(".dragging, .drop-target, .drop-line, .cell-preview").length, 0);
}
function rgba(color) {
  const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
  canvas.width = canvas.height = 1;
  ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data];
}
function composite([r, g, b, a], background) {
  return [r, g, b].map((value, i) => value * a / 255 + background[i] * (1 - a / 255));
}
function luminance(rgb) {
  const linear = rgb.map(value => value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
async function flush(ff) { await ff.settle(); await nextFrame(); await nextFrame(); }
async function controller(set = setup(), listener, layout = {}, options = {}) {
  const ff = createFirefox(set, listener), root = await makeRoot();
  await ff.browser.storage.sync.set(layout); await ff.settle();
  const { createController } = await import("../../extension/src/main.js");
  const control = createController(root, ff.browser, undefined, options);
  await control.refresh();
  await flush(ff); // Drain the one-time reconcile and deferred first paint.
  await flush(ff); // Deliver fake storage events from the initial tile writes.
  return { root, ff, control };
}

// Without controller board-membership guards, foreign MIME payloads can reach
// executor reads/mutations, including the Foxy page and another Foxy page.
for (const [id, label] of [[99, "self"], [55, "other Foxy-page"], [123456, "unknown"]]) {
  test(`foreign ${label} tab payload is ignored in every drop zone without API calls`, async () => {
    const set = setup();
    set.tabs.push({ id: 55, windowId: 1, url: location.origin + location.pathname + "?foreign" });
    const { root, ff } = await controller(set);
    const messages = [], debug = console.debug;
    console.debug = (...args) => messages.push(args);
    try {
      for (const selector of ['.rows[data-zone="pinned"]', '.rows[data-zone="tabs"]',
        '.rows[data-group-id="101"]', '.grid']) {
        const target = root.querySelector(selector), dt = new DataTransfer();
        dt.setData(TAB, String(id));
        ff.calls.length = 0;
        dispatchDrag("drop", target, { dataTransfer: dt, ...point(target, 0.5, 0) });
        await flush(ff);
        assert.deepEqual(ff.calls, [], "a non-board tab must not reach any API, including refresh");
      }
      assert.equal(messages.length, 4);
      assert.ok(messages.every(args => args[0].startsWith("Foxy:")));
    } finally { console.debug = debug; }
  });
}
// Wrong midpoint axis/slot, a layout-affecting marker, or an unreadable-data
// branch fails these assertions on actual DragEvents and Firefox geometry.
test("tab drag uses types during dragover and places one neutral 2px line between rows", async () => {
  const { root, calls } = await draw();
  const source = tab(root), dt = start(source);
  try {
    assert.equal(dt.getData(TAB), "15");
    assert.equal(dt.effectAllowed, "move");
    assert.equal(getComputedStyle(source).opacity, "0.4");
    const rows = root.querySelector('.rows[data-group-id="101"]');
    const [first, second] = rows.querySelectorAll(".row");
    const before = [point(first), point(second)];
    // Real Firefox's protected mode exposes types, but not the payload.
    const getData = dt.getData.bind(dt);
    dt.getData = () => { throw new Error("protected dragover data must not be read"); };
    const options = { dataTransfer: dt, ...point(first, 0.5, 1) };
    assert.ok(dispatchDrag("dragover", second.querySelector(".row-label"), options).defaultPrevented);
    dispatchDrag("dragover", rows, options);
    dt.getData = getData;
    const line = root.querySelector(".drop-line");
    assert.ok(line, "a valid row target needs an insertion marker");
    assert.equal(root.querySelectorAll(".drop-line").length, 1);
    assert.deepEqual([point(first), point(second)], before, "marker must not shift rows");
    const bounds = line.getBoundingClientRect();
    assert.equal(bounds.height, 2);
    assert.ok(Math.abs(bounds.top + 1 - first.getBoundingClientRect().bottom) <= 1);
    assert.ok(rows.closest(".column").classList.contains("drop-target"));
    const style = getComputedStyle(line);
    const [r, g, b] = rgba(style.backgroundColor);
    assert.equal(r, g); assert.equal(g, b, "the line must remain neutral");
    assert.equal(style.boxShadow, "none"); assert.equal(style.borderTopWidth, "0px"); assert.equal(style.outlineStyle, "none");
    dispatchDrag("drop", rows, options);
    assert.deepEqual(calls.tabs, [[15, { zone: "group", groupId: 101, slot: 1, tabId: 15 }]]);
  } finally { dispatchDrag("dragend", source, { dataTransfer: dt }); }
  assert.deepEqual(calls.states, [true, false]); clean(root);
});

// A white-only marker or fill mixing toward white fails in the light scheme.
for (const scheme of ["light", "dark"]) {
  test(`${scheme} drag feedback has a contrasting neutral line and visible target fill`, async () => {
    const { root } = await draw();
    root.style.colorScheme = scheme;
    const source = tab(root), dt = start(source), rows = root.querySelector('.rows[data-group-id="101"]');
    const column = rows.closest(".column"), background = scheme === "light" ? [255, 255, 255] : [0, 0, 0];
    const card = composite(rgba(getComputedStyle(column).backgroundColor), background);
    try {
      dispatchDrag("dragover", rows, { dataTransfer: dt, ...point(rows.querySelector(".row"), 0.5, 1) });
      const fill = composite(rgba(getComputedStyle(column).backgroundColor), background);
      const color = rgba(getComputedStyle(root.querySelector(".drop-line")).backgroundColor);
      assert.equal(color[0], color[1]); assert.equal(color[1], color[2]);
      const line = composite(color, fill), a = luminance(line), b = luminance(fill);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      assert.ok(ratio >= 3, `line contrast against the target must be at least 3:1, got ${ratio}`);
      assert.ok(Math.abs(luminance(fill) - luminance(card)) >= 0.02, "target fill must visibly differ from the card");
      assert.ok(scheme === "light" ? luminance(fill) < luminance(card) : luminance(fill) > luminance(card),
        "feedback fill must mix toward the opposite neutral end of the scheme");
    } finally { dispatchDrag("dragend", source, { dataTransfer: dt }); }
  });
}

for (const [zone, slot] of [["pinned", 0], ["pinned", 1], ["pinned", 2], ["tabs", 0], ["tabs", 1], ["tabs", 2]]) {
  test(`${zone} tab payload at top, remote boundary or end (slot ${slot})`, async () => {
    const { root, calls } = await draw();
    const source = tab(root), dt = start(source), rows = root.querySelector(`.rows[data-zone="${zone}"]`);
    const list = [...rows.querySelectorAll(".row")];
    const coords = slot === 0 ? point(list[0], 0.5, 0) : point(list[slot - 1], 0.5, 1);
    try {
      assert.ok(dispatchDrag("dragover", rows, { dataTransfer: dt, ...coords }).defaultPrevented);
      dispatchDrag("drop", rows, { dataTransfer: dt, ...coords });
      assert.deepEqual(calls.tabs, [[15, { zone, slot, tabId: 15 }]]);
    } finally { dispatchDrag("dragend", source, { dataTransfer: dt }); }
  });
}
for (const zone of ["pinned", "tabs"]) {
  for (const slot of [1, 2]) {
    test(`${zone} window-boundary marker at slot ${slot} sits at the preceding row bottom`, async () => {
      const set = setup(); set.windows.push({ id: 3 });
      set.tabs.push({ id: 31, windowId: 3 }, { id: 32, windowId: 3, pinned: true });
      const { root, calls } = await draw(set);
      const source = root.querySelector('[data-tab-id="12"]'), dt = start(source);
      const rows = root.querySelector(`.rows[data-zone="${zone}"]`), list = [...rows.querySelectorAll(".row")];
      const after = list[slot - 1].getBoundingClientRect(), before = list[slot].getBoundingClientRect();
      const opts = { dataTransfer: dt, clientX: after.left + 10, clientY: (after.bottom + before.top) / 2 };
      try {
        dispatchDrag("dragover", rows, opts);
        const line = root.querySelector(".drop-line").getBoundingClientRect();
        assert.ok(Math.abs(line.top + 1 - after.bottom) <= 1, "marker must sit on after.bottom, outside the window heading/gap");
        dispatchDrag("drop", rows, opts);
        assert.deepEqual(calls.tabs, [[12, { zone, slot, tabId: 12 }]]);
      } finally { dispatchDrag("dragend", source, { dataTransfer: dt }); }
    });
  }
}

for (const zone of ["pinned", "tabs"]) {
  test(`empty ${zone} accepts a tab at slot zero`, async () => {
    const set = setup(); set.tabs = set.tabs.filter(t => t.id !== 11 && t.id !== 21 && t.id !== 15 && t.id !== 23);
    const { root, calls } = await draw(set);
    const source = root.querySelector('[data-tab-id="12"]'), dt = start(source);
    const rows = root.querySelector(`.rows[data-zone="${zone}"]`);
    try {
      assert.ok(dispatchDrag("dragover", rows, { dataTransfer: dt, ...point(rows) }).defaultPrevented);
      assert.equal(root.querySelector(".drop-line").getBoundingClientRect().height, 2);
      dispatchDrag("drop", rows, { dataTransfer: dt, ...point(rows) });
      assert.deepEqual(calls.tabs, [[12, { zone, slot: 0, tabId: 12 }]]);
    } finally { dispatchDrag("dragend", source, { dataTransfer: dt }); }
  });
}
for (const [selector, drop] of [
  ['.column[data-group-id="101"] .group-name', { zone: "group", groupId: 101, slot: 0, tabId: 15 }],
  ['.column[data-group-id="201"] .other-window', { zone: "group", groupId: 201, slot: 0, tabId: 15 }],
  ['.fixed[data-zone="pinned"] .column-title', { zone: "pinned", slot: 0, tabId: 15 }],
  ['.fixed[data-zone="tabs"] .column-title', { zone: "tabs", slot: 0, tabId: 15 }],
]) {
  test(`tab drop on ${selector} targets the column's slot zero`, async () => {
    const set = setup();
    for (let i = 0; i < 30; i++) set.tabs.push({ id: 1000 + i, windowId: 1, groupId: 101 });
    const { root, calls } = await draw(set);
    const source = tab(root), dt = start(source), target = root.querySelector(selector);
    root.querySelector('.rows[data-group-id="101"]').scrollTop = 160;
    try {
      const opts = { dataTransfer: dt, ...point(target) };
      assert.ok(dispatchDrag("dragover", target, opts).defaultPrevented, "a column heading accepts tab drops");
      assert.ok(target.closest(".column").classList.contains("drop-target"));
      if (drop.zone === "tabs") assert.equal(root.querySelector(".drop-line"), null, "the TABS title is a no-op for its first row");
      else assert.ok(root.querySelector(".drop-line"));
      dispatchDrag("drop", target, opts);
      assert.deepEqual(calls.tabs, [[15, drop]]);
    } finally { dispatchDrag("dragend", source, { dataTransfer: dt }); }
  });
}

test("leaving the board and cancelled dragend clear feedback without opening a row", async () => {
  const { root, calls } = await draw();
  const source = tab(root), dt = start(source), target = root.querySelector('.rows[data-group-id="101"]');
  dispatchDrag("dragover", target, { dataTransfer: dt, ...point(target) });
  dispatchDrag("dragleave", target, { dataTransfer: dt, relatedTarget: null });
  assert.equal(root.querySelector(".drop-line"), null);
  dispatchDrag("dragend", source, { dataTransfer: dt });
  clean(root); assert.deepEqual(calls.states, [true, false]);
  source.click(); assert.deepEqual(calls.opened, [], "post-drag click must not activate/close the page");
  source.click(); assert.deepEqual(calls.opened, [15], "a later ordinary click remains usable");
});
test("a keyboard-activated click after a drag works without a fresh pointerdown", async () => {
  const { root, calls } = await draw();
  const source = tab(root), dt = start(source);
  dispatchDrag("dragend", source, { dataTransfer: dt });
  await new Promise(resolve => setTimeout(resolve, 0));
  source.focus();
  // Keyboard/assistive activation has detail zero and no preceding pointerdown.
  source.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
  assert.deepEqual(calls.opened, [15], "drag suppression must expire before a later keyboard click");
});

test("delegation is attached once and uses the newest render handlers", async () => {
  const { root, board, renderBoard, calls } = await draw();
  const latest = [];
  renderBoard(root, board, {}, { onTabDrop: (...args) => latest.push(args), onDragState: v => latest.push(v) });
  const source = tab(root), dt = start(source), target = root.querySelector('.column[data-group-id="101"] .column-header');
  dispatchDrag("drop", target, { dataTransfer: dt, ...point(target) });
  dispatchDrag("dragend", source, { dataTransfer: dt });
  assert.deepEqual(latest, [true, [15, { zone: "group", groupId: 101, slot: 0, tabId: 15 }], false]);
  assert.deepEqual(calls.states, []); assert.deepEqual(calls.tabs, []);
});
test("tab drops on the clock tile still do nothing", async () => {
  const { root, calls } = await draw();
  const source = tab(root), dataTransfer = start(source);
  try {
    for (const target of [root.querySelector('.tile[data-kind="clock"]'), root.querySelector('.clock-time')]) {
      const valid = root.querySelector('.rows[data-group-id="101"]');
      dispatchDrag("dragover", valid, { dataTransfer, ...point(valid.querySelector(".row"), 0.5, 0) });
      assert.ok(root.querySelector(".drop-line"), "start with valid feedback so rejection must clear it");
      const over = dispatchDrag("dragover", target, { dataTransfer, ...point(target) });
      assert.equal(over.defaultPrevented, false);
      assert.equal(dataTransfer.dropEffect, "none");
      assert.equal(root.querySelector(".drop-line, .drop-target"), null);
      const drop = dispatchDrag("drop", target, { dataTransfer, ...point(target) });
      assert.equal(drop.defaultPrevented, false);
      assert.deepEqual(calls.tabs, []);
    }
  } finally { dispatchDrag("dragend", source, { dataTransfer }); }
});

// Wrong cell pitch, gap ownership, right-edge clamp or scroll coordinates
// changes the emitted rectangle; a layout-affecting preview moves real tiles.
for (const [label, col, row, offset, scrollTop, expected] of [
  ["empty cell", 11, 0, 20, 0, { x: 10, y: 0, w: 3, h: 4 }],
  ["gap", 11, 0, 88, 0, { x: 10, y: 0, w: 3, h: 4 }],
  ["last column", 12, 0, 20, 0, { x: 10, y: 0, w: 3, h: 4 }],
  ["scrolled cell", 9, 4, 20, 288, { x: 9, y: 4, w: 3, h: 4 }],
]) {
  test(`tab over ${label} previews and drops the default clamped group rectangle`, async () => {
    const { root, calls } = await draw();
    const grid = root.querySelector(".grid");
    if (scrollTop) {
      const spacer = document.createElement("div"); spacer.style.cssText = "height:1136px;pointer-events:none";
      grid.append(spacer); grid.scrollTop = scrollTop;
    }
    const source = tab(root), dataTransfer = start(source);
    const bounds = grid.getBoundingClientRect(), tile = root.querySelector('.tile[data-kind="clock"]');
    const before = tile.getBoundingClientRect().toJSON();
    const coords = { clientX: bounds.left + col * 96 + offset,
      clientY: bounds.top + row * 96 + offset - grid.scrollTop };
    try {
      // Firefox protects payload data during dragover, even for a cell target.
      const getData = dataTransfer.getData.bind(dataTransfer);
      dataTransfer.getData = () => { throw new Error("protected payload"); };
      assert.ok(dispatchDrag("dragover", grid, { dataTransfer, ...coords }).defaultPrevented);
      dataTransfer.getData = getData;
      const preview = root.querySelector(".cell-preview"); assert.ok(preview);
      const r = preview.getBoundingClientRect(), style = getComputedStyle(preview);
      assert.equal(r.left, bounds.left + expected.x * 96);
      assert.equal(r.top, bounds.top + expected.y * 96 - grid.scrollTop);
      assert.equal(r.width, 272); assert.equal(r.height, 368);
      const [red, green, blue, alpha] = rgba(style.backgroundColor);
      assert.equal(red, green); assert.equal(green, blue); assert.ok(alpha > 0 && alpha < 255);
      assert.equal(style.borderRadius, getComputedStyle(tile).borderRadius);
      assert.equal(style.borderTopWidth, "0px"); assert.equal(style.outlineStyle, "none");
      assert.equal(style.boxShadow, "none"); assert.equal(style.pointerEvents, "none");
      assert.deepEqual(tile.getBoundingClientRect().toJSON(), before, "no live push preview for tab drops");
      dispatchDrag("dragleave", grid, { dataTransfer, relatedTarget: null });
      assert.equal(root.querySelector(".cell-preview"), null);
      dispatchDrag("dragover", grid, { dataTransfer, ...coords });
      dispatchDrag("drop", grid, { dataTransfer, ...coords });
      assert.deepEqual(calls.tabs, [[15, { zone: "cell", tabId: 15, rect: expected }]]);
      assert.equal(root.querySelector(".cell-preview"), null);
      dispatchDrag("dragover", grid, { dataTransfer, ...coords });
    } finally { dispatchDrag("dragend", source, { dataTransfer }); }
    clean(root);
  });
}

test("a group tile covering cells keeps row insertion, never a cell preview", async () => {
  const { root, calls } = await draw();
  const source = tab(root), dataTransfer = start(source), target = root.querySelector('.tile[data-group-id="101"]');
  try {
    dispatchDrag("dragover", root.querySelector(".grid"), { dataTransfer, ...point(root.querySelector(".grid"), 0.95, 0.05) });
    assert.ok(root.querySelector(".cell-preview"));
    dispatchDrag("dragover", target, { dataTransfer, ...point(target) });
    assert.equal(root.querySelector(".cell-preview"), null); assert.ok(root.querySelector(".drop-line"));
    dispatchDrag("drop", target, { dataTransfer, ...point(target) });
    assert.deepEqual(calls.tabs, [[15, { zone: "group", groupId: 101, slot: 0, tabId: 15 }]]);
  } finally { dispatchDrag("dragend", source, { dataTransfer }); }
});

// Falling back to the grid for a tile's trailing gap must not create a group.
for (const [kind, side, slot] of [["group", "right", 1], ["group", "below", 2], ["pinned", "below", 2]]) {
  test(`the gap ${side} of a ${kind} tile keeps its row insertion target`, async () => {
    const { root, calls } = await draw();
    const tile = root.querySelector(kind === "group" ? '.tile[data-group-id="101"]' : '.tile[data-kind="pinned"]');
    const rows = tile.querySelector(".rows"), bounds = tile.getBoundingClientRect();
    const coords = side === "right"
      ? { clientX: bounds.right + 8, clientY: rows.querySelector(".row").getBoundingClientRect().bottom }
      : { clientX: bounds.left + 20, clientY: bounds.bottom + 8 };
    const hit = document.elementFromPoint(coords.clientX, coords.clientY);
    assert.equal(hit, root.querySelector(".grid"), "the pointer hits the gap, not the tile");
    const source = tab(root), dataTransfer = start(source);
    try {
      assert.ok(dispatchDrag("dragover", hit, { dataTransfer, ...coords }).defaultPrevented);
      assert.equal(dataTransfer.dropEffect, "move");
      assert.equal(root.querySelector(".cell-preview"), null);
      assert.ok(rows.querySelector(".drop-line"), "gap feedback belongs to the tile's rows");
      dispatchDrag("drop", hit, { dataTransfer, ...coords });
      assert.deepEqual(calls.tabs, [[15, { zone: kind, ...(kind === "group" ? { groupId: 101 } : {}), slot, tabId: 15 }]]);
    } finally { dispatchDrag("dragend", source, { dataTransfer }); }
    clean(root);
  });
}

test("the gap below the clock rejects tab drops without moving tiles or writing storage", async () => {
  const reply = { saved: [], missing: [], folders: { 101: "one", 102: "two", 201: "remote" } };
  const { root, ff } = await controller(setup(), message => message.type === "foxy:reconcile" ? { ok: true }
    : message.type === "foxy:saved" ? reply : undefined, dropLayout);
  const beforeTiles = [...root.querySelectorAll(".tile")].map(tile => [tile.dataset.tileId, rectOf(tile)]);
  const beforeStorage = await ff.browser.storage.sync.get(null);
  const clock = root.querySelector('[data-kind="clock"]').getBoundingClientRect();
  const coords = { clientX: clock.left + 20, clientY: clock.bottom + 8 };
  const hit = document.elementFromPoint(coords.clientX, coords.clientY);
  assert.equal(hit, root.querySelector(".grid"));
  const source = tab(root), dataTransfer = start(source);
  ff.calls.length = 0;
  try {
    const over = dispatchDrag("dragover", hit, { dataTransfer, ...coords });
    assert.equal(over.defaultPrevented, false);
    assert.equal(dataTransfer.dropEffect, "none");
    assert.equal(root.querySelector(".cell-preview, .drop-line, .drop-target"), null);
    assert.equal(dispatchDrag("drop", hit, { dataTransfer, ...coords }).defaultPrevented, false);
  } finally { dispatchDrag("dragend", source, { dataTransfer }); }
  await flush(ff); await flush(ff);
  assert.deepEqual(ff.calls, [], "a rejected gap drop reaches no API");
  assert.deepEqual([...root.querySelectorAll(".tile")].map(tile => [tile.dataset.tileId, rectOf(tile)]), beforeTiles);
  assert.deepEqual(await ff.browser.storage.sync.get(null), beforeStorage);
});

test("scrolled grid drop lands the group tile in the content cell under the pointer", async () => {
  const { root, ff } = await controller();
  const source = tab(root), dataTransfer = start(source), grid = root.querySelector(".grid");
  grid.style.padding = "8px 12px";
  const spacer = document.createElement("div"); spacer.style.cssText = "height:1520px;pointer-events:none"; grid.append(spacer);
  grid.scrollTop = 384;
  const bounds = grid.getBoundingClientRect();
  const coords = { clientX: bounds.left + 12 + 9 * 96 + 20,
    clientY: bounds.top + 8 + 6 * 96 + 20 - grid.scrollTop };
  try {
    assert.equal(document.elementFromPoint(coords.clientX, coords.clientY), grid, "pointer is over empty grid content");
    dispatchDrag("dragover", grid, { dataTransfer, ...coords });
    dispatchDrag("drop", grid, { dataTransfer, ...coords });
    dispatchDrag("dragend", source, { dataTransfer });
    await flush(ff); await flush(ff);
    const groupId = (await ff.browser.tabs.get(15)).groupId;
    assert.ok(groupId !== -1);
    assert.deepEqual(rectOf(root.querySelector(`[data-tile-id="local:${groupId}"]`)), { x: 9, y: 6, w: 3, h: 4 });
  } finally { dispatchDrag("dragend", source, { dataTransfer }); endName(root); }
});

const dropLayout = {
  "tile:clock": { x: 0, y: 0, w: 5, h: 2 },
  "tile:pinned": { x: 5, y: 0, w: 3, h: 4 },
  "tile:group:one": { x: 8, y: 0, w: 3, h: 4 },
  "tile:group:two": { x: 0, y: 4, w: 3, h: 4 },
  "tile:group:remote": { x: 3, y: 4, w: 3, h: 4 },
  "tile:group:closed": { x: 4, y: 2, w: 3, h: 4 },
};
async function pendingDrop(initial = { saved: [], missing: [], folders: { 101: "one", 102: "two", 201: "remote" } }) {
  let reply = initial;
  const { root, ff, control } = await controller(setup(), message => message.type === "foxy:reconcile" ? { ok: true }
    : message.type === "foxy:saved" ? reply : undefined, dropLayout);
  const source = tab(root), dataTransfer = start(source), grid = root.querySelector(".grid"), bounds = grid.getBoundingClientRect();
  const coords = { clientX: bounds.left + 4 * 96 + 20, clientY: bounds.top + 2 * 96 + 20 };
  ff.calls.length = 0;
  dispatchDrag("dragover", grid, { dataTransfer, ...coords });
  dispatchDrag("drop", grid, { dataTransfer, ...coords });
  dispatchDrag("dragend", source, { dataTransfer });
  await flush(ff); await flush(ff);
  const groupId = (await ff.browser.tabs.get(15)).groupId;
  return { root, ff, control, groupId, setReply: value => { reply = value; } };
}
function rectOf(tile) {
  return { x: Number(tile.style.getPropertyValue("--x")), y: Number(tile.style.getPropertyValue("--y")),
    w: Number(tile.style.getPropertyValue("--w")), h: Number(tile.style.getPropertyValue("--h")) };
}
function endName(root) {
  root.querySelector(".name-editor")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

test("empty-cell drop shows the unmapped tile at its rect, opens its editor and saves changed tiles only after mapping", async () => {
  const { root, ff, control, groupId, setReply } = await pendingDrop();
  try {
    assert.ok(groupId !== -1, "the tab must join a new group");
    assert.equal((await ff.browser.tabGroups.get(groupId)).windowId, 1);
    const tile = root.querySelector(`[data-tile-id="local:${groupId}"]`); assert.ok(tile);
    assert.deepEqual(rectOf(tile), { x: 4, y: 2, w: 3, h: 4 });
    assert.ok(tile.querySelector(".name-editor"), "new group opens its name editor");
    assert.deepEqual(ff.calls.filter(c => c.api === "storage.sync.set"), [], "unmapped placement is display-only");
    assert.deepEqual(await ff.browser.storage.sync.get(null), dropLayout);
    setReply({ saved: [], missing: [], folders: { 101: "one", 102: "two", 201: "remote", [groupId]: "new" } });
    ff.fire("bookmarks.onCreated", "new", { id: "new", type: "folder" }); await flush(ff);
    assert.ok(root.querySelector(`[data-tile-id="local:${groupId}"]`), "mapping update is held by the editor");
    endName(root); await flush(ff); await flush(ff);
    assert.deepEqual(rectOf(root.querySelector('[data-tile-id="group:new"]')), { x: 4, y: 2, w: 3, h: 4 });
    const writes = ff.calls.filter(c => c.api === "storage.sync.set");
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].args[0], {
      "tile:group:new": { x: 4, y: 2, w: 3, h: 4 },
      "tile:pinned": { x: 5, y: 6, w: 3, h: 4 },
      "tile:group:remote": { x: 3, y: 10, w: 3, h: 4 },
    });
    assert.deepEqual(await ff.browser.storage.sync.get(null), { ...dropLayout, ...writes[0].args[0] });
    await control.refresh(); await flush(ff); await flush(ff);
    assert.equal(ff.calls.filter(c => c.api === "storage.sync.set").length, 1, "mapped pending entry is consumed once");
    assert.deepEqual(ff.errors, []);
    assert.equal(ff.calls.some(c => c.api === "tabs.remove" || c.args[0]?.type === "blank-and-close"), false);
  } finally { endName(root); }
});

// Only the injected new-group delay is held; clock and saved-read timers run normally.
function groupTimers() {
  const delay = 123456, timers = new Map();
  const set = window.setTimeout, clear = window.clearTimeout;
  window.setTimeout = (callback, ms, ...args) => {
    const timer = set(callback, ms, ...args);
    if (ms === delay) timers.set(timer, () => callback(...args));
    return timer;
  };
  window.clearTimeout = timer => { timers.delete(timer); clear(timer); };
  return { options: { newGroupDelay: delay }, timers,
    fire() {
      for (const [timer, callback] of [...timers]) {
        window.clearTimeout(timer); callback();
      }
    },
    restore() {
      for (const timer of timers.keys()) clear(timer);
      window.setTimeout = set; window.clearTimeout = clear;
    },
  };
}

for (const order of ["dropper-first", "dropper-second"]) {
  test(`two Foxy pages (${order}) keep the dropped group's rectangle without another first-free write`, async () => {
    const timer = groupTimers();
    let folders = { 101: "one", 102: "two", 201: "remote" };
    const ff = createFirefox(setup(), message => message.type === "foxy:reconcile" ? { ok: true }
      : message.type === "foxy:saved" ? { saved: [], missing: [], folders } : undefined);
    const { createController } = await import("../../extension/src/main.js");
    const pages = [];
    try {
      await ff.browser.storage.sync.set(dropLayout); await ff.settle();
      for (let i = 0; i < 2; i++) {
        const root = await makeRoot();
        const control = createController(root, ff.browser, undefined, timer.options);
        await control.refresh(); await flush(ff); await flush(ff);
        pages.push({ root, control });
      }
      const A = pages[order === "dropper-first" ? 0 : 1], B = pages[order === "dropper-first" ? 1 : 0];
      await A.control.handlers.onTabDrop(15, { zone: "cell", rect: { x: 4, y: 2, w: 3, h: 4 } });
      await flush(ff); endName(A.root); await flush(ff); await flush(ff);
      const groupId = (await ff.browser.tabs.get(15)).groupId;
      assert.deepEqual(rectOf(B.root.querySelector(`[data-tile-id="local:${groupId}"]`)), { x: 6, y: 4, w: 3, h: 4 });
      ff.calls.length = 0;
      folders = { ...folders, [groupId]: "new" };
      ff.fire("bookmarks.onCreated", "new", { id: "new", type: "folder" });
      await flush(ff); await flush(ff);
      assert.deepEqual((await ff.browser.storage.sync.get(null))["tile:group:new"], { x: 4, y: 2, w: 3, h: 4 });
      timer.fire(); await flush(ff); await flush(ff);
      const writes = ff.calls.filter(c => c.api === "storage.sync.set" && c.args[0]["tile:group:new"]);
      assert.equal(writes.length, 1, "only the dropping page writes the new tile");
      for (const { root } of pages) {
        assert.deepEqual(rectOf(root.querySelector('[data-tile-id="group:new"]')), { x: 4, y: 2, w: 3, h: 4 });
      }
      assert.deepEqual(ff.errors, []);
    } finally {
      for (const { root } of pages) { endName(root); root.remove(); }
      timer.restore();
    }
  });
}

async function externalGroup(options) {
  let folders = { 101: "one", 102: "two", 201: "remote" };
  const result = await controller(setup(), message => message.type === "foxy:reconcile" ? { ok: true }
    : message.type === "foxy:saved" ? { saved: [], missing: [], folders } : undefined, dropLayout, options);
  const { ff } = result;
  const groupId = await ff.browser.tabs.group({ tabIds: [15], createProperties: { windowId: 1 } });
  folders = { ...folders, [groupId]: "external" };
  ff.fire("bookmarks.onCreated", "external", { id: "external", type: "folder" });
  await flush(ff); await flush(ff);
  return { ...result, groupId };
}

test("a post-paint group stays display-only until the delay and key check, then saves its default rectangle once", async () => {
  const timer = groupTimers(); let root;
  try {
    const result = await externalGroup(timer.options); root = result.root;
    const { ff, control } = result;
    assert.deepEqual(rectOf(root.querySelector('[data-tile-id="group:external"]')), { x: 6, y: 4, w: 3, h: 4 });
    assert.equal((await ff.browser.storage.sync.get(null))["tile:group:external"], undefined);
    assert.equal(timer.timers.size, 1);
    await control.refresh(); await flush(ff);
    assert.equal(timer.timers.size, 1, "refresh does not restart the delay");
    ff.calls.length = 0;
    timer.fire(); await flush(ff); await flush(ff);
    assert.ok(ff.calls.some(c => c.api === "storage.sync.get" && c.args[0] === "tile:group:external"));
    assert.deepEqual((await ff.browser.storage.sync.get(null))["tile:group:external"], { x: 6, y: 4, w: 3, h: 4 });
    assert.equal(ff.calls.filter(c => c.api === "storage.sync.set" && c.args[0]["tile:group:external"]).length, 1);
    await control.refresh(); await flush(ff);
    assert.equal(timer.timers.size, 0);
  } finally { root?.remove(); timer.restore(); }
});

test("the delayed key check adopts an existing drop rectangle even before storage.onChanged is delivered", async () => {
  const timer = groupTimers(); let root;
  try {
    const result = await externalGroup(timer.options); root = result.root;
    const { ff } = result;
    await ff.browser.storage.sync.set({
      "tile:group:external": { x: 4, y: 2, w: 3, h: 4 },
      "tile:pinned": { x: 5, y: 6, w: 3, h: 4 },
      "tile:group:remote": { x: 3, y: 10, w: 3, h: 4 },
    });
    // Keep the fake's event queue held until the delayed key read has resolved.
    ff.calls.length = 0;
    timer.fire(); await nextFrame(); await nextFrame(); await nextFrame();
    assert.deepEqual((await ff.browser.storage.sync.get(null))["tile:group:external"], { x: 4, y: 2, w: 3, h: 4 });
    assert.deepEqual(rectOf(root.querySelector('[data-tile-id="group:external"]')), { x: 4, y: 2, w: 3, h: 4 });
    assert.equal(ff.calls.filter(c => c.api === "storage.sync.set").length, 0);
    await flush(ff);
  } finally { root?.remove(); timer.restore(); }
});

for (const ending of ["group removal", "page unload"]) {
  test(`a deferred group tile cancels its timer on ${ending}`, async () => {
    const timer = groupTimers(); let root;
    try {
      const result = await externalGroup(timer.options); root = result.root;
      const { ff } = result;
      assert.equal(timer.timers.size, 1);
      ff.calls.length = 0;
      if (ending === "group removal") { await ff.browser.tabs.remove(15); await flush(ff); }
      else window.dispatchEvent(new Event("pagehide"));
      assert.equal(timer.timers.size, 0);
      timer.fire(); await flush(ff); await flush(ff);
      assert.equal((await ff.browser.storage.sync.get(null))["tile:group:external"], undefined);
      assert.equal(ff.calls.filter(c => c.api === "storage.sync.set").length, 0);
    } finally { root?.remove(); timer.restore(); }
  });
}

async function twoPendingDrops(layout, rects) {
  let reply = { saved: [], missing: [], folders: { 101: "one", 102: "two", 201: "remote" } };
  const { root, ff, control } = await controller(setup(), message => message.type === "foxy:reconcile" ? { ok: true }
    : message.type === "foxy:saved" ? reply : undefined, layout);
  const ids = [];
  for (const [i, tabId] of [15, 23].entries()) {
    await control.handlers.onTabDrop(tabId, { zone: "cell", rect: rects[i] });
    await flush(ff); endName(root); await flush(ff);
    ids.push((await ff.browser.tabs.get(tabId)).groupId);
  }
  return { root, ff, control, ids, map: folders => {
    reply = { ...reply, folders: { ...reply.folders, ...folders } };
    ff.fire("bookmarks.onCreated", "new", { id: "new", type: "folder" });
  } };
}

test("mapping one pending tile ignores another pending tile's first-free position when saving pushes", async () => {
  const layout = { ...dropLayout, "tile:group:remote": { x: 6, y: 8, w: 3, h: 4 } };
  const { root, ff, ids, map } = await twoPendingDrops(layout,
    [{ x: 6, y: 4, w: 3, h: 4 }, { x: 0, y: 14, w: 3, h: 4 }]);
  try {
    assert.deepEqual(rectOf(root.querySelector('[data-tile-id="group:remote"]')), { x: 6, y: 8, w: 3, h: 4 });
    assert.deepEqual(rectOf(root.querySelector(`[data-tile-id="local:${ids[1]}"]`)), { x: 0, y: 14, w: 3, h: 4 });
    ff.calls.length = 0;
    map({ [ids[0]]: "first" }); await flush(ff); await flush(ff);
    assert.deepEqual(ff.calls.filter(c => c.api === "storage.sync.set").map(c => c.args[0]),
      [{ "tile:group:first": { x: 6, y: 4, w: 3, h: 4 } }], "only the mapped tile moves, not a real tile below a phantom local tile");
    assert.deepEqual(rectOf(root.querySelector('[data-tile-id="group:remote"]')), { x: 6, y: 8, w: 3, h: 4 });
    assert.deepEqual((await ff.browser.storage.sync.get(null))["tile:group:remote"], { x: 6, y: 8, w: 3, h: 4 });
  } finally { endName(root); }
});

test("pending groups mapped together are saved in drop order rather than tab-strip order", async () => {
  const { root, ff, control, ids, map } = await twoPendingDrops(dropLayout,
    [{ x: 4, y: 6, w: 3, h: 4 }, { x: 5, y: 7, w: 3, h: 4 }]);
  try {
    await ff.browser.tabGroups.move(ids[1], { index: 1 }); await flush(ff); await control.refresh(); await flush(ff);
    const groupOrder = [...root.querySelectorAll('.tile[data-kind="group"]')].map(tile => Number(tile.dataset.groupId));
    assert.ok(groupOrder.indexOf(ids[1]) < groupOrder.indexOf(ids[0]), "tab-strip order is opposite to drop order");
    ff.calls.length = 0;
    map({ [ids[0]]: "first", [ids[1]]: "second" }); await flush(ff); await flush(ff);
    const writes = ff.calls.filter(c => c.api === "storage.sync.set");
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].args[0]["tile:group:first"], { x: 4, y: 11, w: 3, h: 4 });
    assert.deepEqual(writes[0].args[0]["tile:group:second"], { x: 5, y: 7, w: 3, h: 4 });
    assert.deepEqual(rectOf(root.querySelector('[data-tile-id="group:first"]')), { x: 4, y: 11, w: 3, h: 4 });
    assert.deepEqual(rectOf(root.querySelector('[data-tile-id="group:second"]')), { x: 5, y: 7, w: 3, h: 4 });
  } finally { endName(root); }
});

for (const readEnds of ["before", "after"]) {
  test(`a storage re-read ending ${readEnds} the pending tile write cannot restore the stale layout`, async () => {
    const { root, ff, groupId, setReply } = await pendingDrop();
    endName(root); await flush(ff); await flush(ff);
    const sync = ff.browser.storage.sync, get = sync.get, set = sync.set, send = ff.browser.runtime.sendMessage;
    let releaseSaved, releaseRead, releaseWrite, savedBegan, readBegan, writeBegan, writeEnded;
    const savedGate = new Promise(resolve => { releaseSaved = resolve; });
    const readGate = new Promise(resolve => { releaseRead = resolve; });
    const writeGate = new Promise(resolve => { releaseWrite = resolve; });
    const savedStarted = new Promise(resolve => { savedBegan = resolve; });
    const readStarted = new Promise(resolve => { readBegan = resolve; });
    const writeStarted = new Promise(resolve => { writeBegan = resolve; });
    const writeFinished = new Promise(resolve => { writeEnded = resolve; });
    let reads = 0, writes = 0;
    ff.browser.runtime.sendMessage = async message => {
      const reply = await send(message);
      if (message.type === "foxy:saved") { savedBegan(); await savedGate; }
      return reply;
    };
    sync.get = async keys => {
      const value = await get(keys);
      if (keys === null && ++reads === 1) { readBegan(); await readGate; }
      return value;
    };
    sync.set = async entries => {
      if (entries["tile:group:new"] && ++writes === 1) {
        writeBegan(); await writeGate; await set(entries); writeEnded();
      } else await set(entries);
    };
    try {
      ff.calls.length = 0;
      setReply({ saved: [], missing: [], folders: { 101: "one", 102: "two", 201: "remote", [groupId]: "new" } });
      ff.fire("bookmarks.onCreated", "new", { id: "new", type: "folder" });
      await ff.settle(); await nextFrame(); await savedStarted;
      ff.fire("storage.onChanged", { settings: { newValue: { showDate: false } } }, "sync");
      await ff.settle(); await nextFrame(); await readStarted;
      releaseSaved(); await writeStarted;
      if (readEnds === "before") { releaseRead(); await nextFrame(); }
      releaseWrite(); await writeFinished;
      // Do not settle the fake yet: the write's onChanged has not been delivered.
      // Only the page's write guard can invalidate this stale storage snapshot.
      releaseRead(); await nextFrame(); await nextFrame(); await nextFrame();
      assert.deepEqual((await get(null))["tile:group:new"], { x: 4, y: 2, w: 3, h: 4 });
      assert.equal(writes, 1, "the stale read must not write the group again at a first-free spot");
      assert.ok(reads >= 2, "discard the stale read and re-read storage after the write");
      assert.deepEqual(rectOf(root.querySelector('[data-tile-id="group:new"]')), { x: 4, y: 2, w: 3, h: 4 });
      await flush(ff); await flush(ff);
      assert.equal(writes, 1);
      assert.deepEqual(ff.errors, []);
    } finally {
      releaseSaved(); releaseRead(); releaseWrite();
      sync.get = get; sync.set = set; ff.browser.runtime.sendMessage = send; endName(root);
      await flush(ff);
    }
  });
}

test("a pending tile write queued two microtasks after a layout reply cannot restore a stale rectangle", async () => {
  const { root, ff, groupId, setReply } = await pendingDrop();
  endName(root); await flush(ff); await flush(ff);
  const sync = ff.browser.storage.sync, get = sync.get, set = sync.set, send = ff.browser.runtime.sendMessage;
  let releaseRead, releaseSaved, releaseWrite, readBegan, savedBegan, writeBegan;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const savedGate = new Promise(resolve => { releaseSaved = resolve; });
  const readStarted = new Promise(resolve => { readBegan = resolve; });
  const savedStarted = new Promise(resolve => { savedBegan = resolve; });
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  const writeStarted = new Promise(resolve => { writeBegan = resolve; });
  let reads = 0;
  sync.get = async keys => {
    const value = await get(keys);
    if (keys === null && ++reads === 1) { readBegan(); await readGate; }
    return value;
  };
  ff.browser.runtime.sendMessage = async message => {
    const reply = await send(message);
    if (message.type === "foxy:saved") { savedBegan(); await savedGate; }
    return reply;
  };
  sync.set = async entries => {
    if (entries["tile:group:new"]) { writeBegan(); await writeGate; }
    return set(entries);
  };
  try {
    setReply({ saved: [], missing: [], folders: { 101: "one", 102: "two", 201: "remote", [groupId]: "new" } });
    ff.fire("bookmarks.onCreated", "new", { id: "new", type: "folder" });
    await ff.settle(); await nextFrame(); await savedStarted;
    ff.fire("storage.onChanged", { settings: { newValue: { showDate: false } } }, "sync");
    await ff.settle(); await nextFrame(); await readStarted;
    ff.calls.length = 0;
    releaseRead();
    for (let i = 0; i < 2; i++) await null;
    releaseSaved();
    await writeStarted; await nextFrame(); await nextFrame();
    assert.deepEqual(rectOf(root.querySelector('[data-tile-id="group:new"]')), { x: 4, y: 2, w: 3, h: 4 });
    releaseWrite();
    for (let i = 0; i < 6; i++) await flush(ff);
    const writes = ff.calls.filter(c => c.api === "storage.sync.set" && c.args[0]["tile:group:new"]);
    assert.deepEqual((await get(null))["tile:group:new"], { x: 4, y: 2, w: 3, h: 4 });
    assert.equal(writes.length, 1, "a chain queued during the await must finish before checking the write counter");
    assert.deepEqual(rectOf(root.querySelector('[data-tile-id="group:new"]')), { x: 4, y: 2, w: 3, h: 4 });
    assert.deepEqual(ff.errors, []);
  } finally {
    releaseRead(); releaseSaved(); releaseWrite(); sync.get = get; sync.set = set; ff.browser.runtime.sendMessage = send;
    endName(root); await flush(ff);
  }
});

test("a fast folder mapping during the final tab read preserves the pending drop rectangle", async () => {
  let folders = { 101: "one", 102: "two", 201: "remote" };
  const { root, ff, control } = await controller(setup(), message => message.type === "foxy:reconcile" ? { ok: true }
    : message.type === "foxy:saved" ? { saved: [], missing: [], folders } : undefined, dropLayout);
  const query = ff.browser.tabs.query;
  let release, began;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  ff.browser.tabs.query = async (...args) => { const tabs = await query(...args); began(); await gate; return tabs; };
  folders = { ...folders, 202: "fast" };
  const dropping = control.handlers.onTabDrop(15, { zone: "cell", rect: { x: 4, y: 2, w: 3, h: 4 } });
  try {
    await started; await flush(ff);
    assert.equal(root.querySelector('[data-tile-id="group:fast"]'), null, "post-drop snapshot has not returned yet");
    release(); ff.browser.tabs.query = query; await dropping; await flush(ff); await flush(ff);
    assert.deepEqual(rectOf(root.querySelector('[data-tile-id="group:fast"]')), { x: 4, y: 2, w: 3, h: 4 });
    assert.ok(root.querySelector('[data-tile-id="group:fast"] .name-editor'));
    assert.deepEqual((await ff.browser.storage.sync.get(null))["tile:group:fast"], { x: 4, y: 2, w: 3, h: 4 });
  } finally { release(); ff.browser.tabs.query = query; await dropping; endName(root); }
});

for (const [label, invalid] of [
  ["missing map", { saved: [], missing: [] }],
  ["array map", { saved: [], missing: [], folders: [] }],
  ["null map", { saved: [], missing: [], folders: null }],
  ["invalid folder value", { saved: [], missing: [], folders: { 101: 17 } }],
  ["failed reply", { ok: false, saved: [], missing: [], folders: {} }],
]) {
  test(`pending tile and other new tiles wait for valid saved folders after ${label}`, async () => {
    const warnings = [], warn = console.warn; console.warn = (...args) => warnings.push(args);
    let root;
    try {
      const dropped = await pendingDrop(invalid); root = dropped.root;
      const { ff, groupId, setReply } = dropped;
      assert.ok(groupId !== -1);
      assert.deepEqual(rectOf(root.querySelector(`[data-tile-id="local:${groupId}"]`)), { x: 4, y: 2, w: 3, h: 4 });
      setReply({ ...invalid, folders: { [groupId]: "new" } });
      // For failures, keep the explicit failure marker. For malformed maps,
      // preserve the malformed map while introducing a truthy group mapping.
      if (label === "array map") { const folders = []; folders[groupId] = "new"; setReply({ ...invalid, folders }); }
      else if (label === "invalid folder value") setReply({ ...invalid, folders: { 101: 17, [groupId]: "new" } });
      else if (label !== "failed reply") setReply(invalid);
      endName(root); ff.fire("bookmarks.onChanged", "new", { title: "Pending" });
      await flush(ff); await flush(ff);
      assert.deepEqual(ff.calls.filter(c => c.api === "storage.sync.set"), [], "no writes before a valid folders reply");
      setReply({ saved: [], missing: [], folders: { 101: "one", 102: "two", 201: "remote", [groupId]: "new" } });
      ff.fire("bookmarks.onChanged", "new", { title: "Mapped" }); await flush(ff); await flush(ff);
      assert.deepEqual((await ff.browser.storage.sync.get(null))["tile:group:new"], { x: 4, y: 2, w: 3, h: 4 });
      assert.deepEqual(rectOf(root.querySelector('[data-tile-id="group:new"]')), { x: 4, y: 2, w: 3, h: 4 });
      assert.deepEqual(ff.errors, []);
    } finally { endName(root ?? document.createElement("div")); console.warn = warn; }
  });
}

test("a pending group's removal drops its rectangle without saving a later stale mapping", async () => {
  const { root, ff, control, groupId, setReply } = await pendingDrop();
  try {
    assert.ok(groupId !== -1);
    await ff.browser.tabs.remove(15); await flush(ff); await flush(ff);
    assert.equal(root.querySelector(`[data-tile-id="local:${groupId}"]`), null);
    assert.equal(root.querySelector(".name-editor"), null);
    setReply({ saved: [], missing: [], folders: { 101: "one", 102: "two", 201: "remote", [groupId]: "gone" } });
    ff.fire("bookmarks.onChanged", "gone", { title: "Late" }); await flush(ff); await control.refresh(); await flush(ff);
    assert.equal((await ff.browser.storage.sync.get(null))["tile:group:gone"], undefined);
    assert.deepEqual(ff.calls.filter(c => c.api === "storage.sync.set"), []);
  } finally { endName(root); }
});

test("unknown drag types and malformed IDs cannot trigger a move", async () => {
  const { root, calls } = await draw();
  const target = root.querySelector('.rows[data-zone="tabs"]'), dt = new DataTransfer();
  dt.setData("text/plain", "15");
  assert.equal(dispatchDrag("dragover", target, { dataTransfer: dt, ...point(target) }).defaultPrevented, false);
  assert.equal(dt.dropEffect, "none");
  dt.setData(TAB, "15oops");
  assert.ok(dispatchDrag("dragover", target, { dataTransfer: dt, ...point(target) }).defaultPrevented,
    "a typed valid zone is accepted even when the eventual payload is malformed");
  dispatchDrag("drop", target, { dataTransfer: dt, ...point(target) });
  assert.deepEqual(calls.tabs, []); clean(root);
});

test("real drag events hold controller updates and release exactly one changed render", async () => {
  const { root, ff, control } = await controller();
  const source = tab(root), dt = start(source);
  let rebuilds = 0; const replace = root.replaceChildren.bind(root);
  root.replaceChildren = (...args) => { rebuilds++; replace(...args); };
  try {
    assert.equal(control.ui.dragging, true, "dragstart must hold synchronously");
    await ff.browser.tabs.update(23, { url: "https://example.com/deferred" });
    await ff.browser.tabGroups.update(101, { title: "Deferred" });
    await flush(ff); await control.refresh();
    assert.equal(rebuilds, 0); assert.equal(tab(root), source);
  } finally { dispatchDrag("dragend", source, { dataTransfer: dt }); }
  await flush(ff);
  assert.equal(control.ui.dragging, false); assert.equal(rebuilds, 1);
  assert.equal(root.querySelector('[data-tab-id="23"] .row-label').textContent, "https://example.com/deferred");
});
test("DOM drop holds the action after early dragend and does not close the page", async () => {
  const { root, ff } = await controller();
  const source = root.querySelector('[data-tab-id="21"]'), dt = start(source);
  let rebuilds = 0; const replace = root.replaceChildren.bind(root);
  root.replaceChildren = (...args) => { rebuilds++; replace(...args); };
  const move = ff.browser.tabs.move;
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  ff.browser.tabs.move = async (...args) => { const result = await move(...args); started(); await gate; return result; };
  try {
    const rows = root.querySelector('.rows[data-group-id="101"]');
    dispatchDrag("drop", rows, { dataTransfer: dt, ...point(rows.querySelector(".row"), 0.5, 0) });
    dispatchDrag("dragend", source, { dataTransfer: dt });
    await began; await flush(ff);
    assert.equal(rebuilds, 0, "action hold survives native dragend");
  } finally { release(); ff.browser.tabs.move = move; dispatchDrag("dragend", source, { dataTransfer: dt }); }
  await flush(ff);
  assert.equal(rebuilds, 1);
  assert.ok(root.querySelector('.rows[data-group-id="101"] [data-tab-id="21"]'));
  assert.equal(ff.calls.some(call => (call.api === "runtime.sendMessage" && call.args[0].type === "blank-and-close") || call.api === "tabs.remove"), false);
});
for (const [id, next] of [[101, 102], [201, 102]]) {
  test(`vanished focused group ${id} falls back to nearest column ${next}`, async () => {
    const { root, ff } = await controller();
    const close = root.querySelector(`.column[data-group-id="${id}"] .column-close`);
    close.focus({ preventScroll: true }); assert.equal(document.activeElement, close);
    const members = id === 101 ? [12, 13] : [22];
    await ff.browser.tabs.remove(members); await flush(ff);
    assert.equal(document.activeElement, root.querySelector(`.column[data-group-id="${next}"] .column-close`));
  });
}

// A marker at either no-op slot promises a move the resolver will not make.
for (const id of [11, 12, 15, 24]) {
  for (const edge of [0, 1]) {
    test(`tab ${id} has no insertion line at its adjacent no-op slot (edge ${edge})`, async () => {
      const set = setup(); set.tabs.push({ id: 24, windowId: 2 });
      const { root } = await draw(set);
      const source = root.querySelector(`[data-tab-id="${id}"]`), dt = start(source);
      try {
        const event = dispatchDrag("dragover", source, { dataTransfer: dt, ...point(source, 0.5, edge) });
        assert.ok(event.defaultPrevented);
        assert.equal(root.querySelector(".drop-line"), null, "a no-op tab slot must not show an insertion line");
      } finally { dispatchDrag("dragend", source, { dataTransfer: dt }); }
    });
  }
}
for (const id of [21, 23]) {
  test(`remote tab ${id} keeps its line when the adjacent boundary actually moves it here`, async () => {
    const { root } = await draw();
    const source = root.querySelector(`[data-tab-id="${id}"]`), dt = start(source);
    try {
      dispatchDrag("dragover", source, { dataTransfer: dt, ...point(source, 0.5, 0) });
      assert.ok(root.querySelector(".drop-line"), "a cross-window move is not an adjacent no-op");
    } finally { dispatchDrag("dragend", source, { dataTransfer: dt }); }
  });
}

// Supplementary integration checks on the already implemented resolver/moves
// contract: a wrong payload from DnD would change these real fake layouts.
test("tab dropped beside itself makes no move API calls through DOM delegation", async () => {
    const { root, ff } = await controller();
    const source = root.querySelector('[data-tab-id="12"]');
    const dt = start(source);
    const target = source.closest(".rows");
    ff.calls.length = 0;
    dispatchDrag("drop", target, { dataTransfer: dt, ...point(source, 0, 0) });
    dispatchDrag("dragend", source, { dataTransfer: dt });
    await flush(ff);
    assert.equal(ff.calls.some(call => ["tabs.move", "tabs.group", "tabs.ungroup", "tabs.update", "tabGroups.move"].includes(call.api)), false);
    assert.equal(ff.layout(1), "P11 | [101: 12 13] [102: 14] 15 99");
});
for (const [zone, one, two] of [
  ["tabs", "P11 | [101: 12 13] [102: 14] 15 99 22", "P21 | 23"],
  ["pinned", "P11 P22 | [101: 12 13] [102: 14] 15 99", "P21 | 23"],
]) {
  test(`remote tab dropped at ${zone} window boundary resolves to the local section end`, async () => {
    const { root, ff } = await controller();
    const source = root.querySelector('[data-tab-id="22"]'), dt = start(source);
    const rows = root.querySelector(`.rows[data-zone="${zone}"]`);
    dispatchDrag("drop", rows, { dataTransfer: dt, ...point(rows.querySelector(".row"), 0.5, 1) });
    dispatchDrag("dragend", source, { dataTransfer: dt });
    await flush(ff);
    assert.equal(ff.layout(1), one); assert.equal(ff.layout(2), two);
    assert.deepEqual(ff.errors, []);
    assert.equal(ff.calls.some(call => (call.api === "runtime.sendMessage" && call.args[0].type === "blank-and-close") || call.api === "tabs.remove"), false);
  });
}
test("a stale DOM tab drop warns and re-reads after dragend without closing the page", async () => {
  const { root, ff } = await controller();
  const source = tab(root), dt = start(source);
  const warnings = [], warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await ff.browser.tabs.remove(15); await flush(ff);
    assert.equal(tab(root), source, "the held stale source remains on screen until dragend");
    ff.calls.length = 0;
    const rows = root.querySelector('.rows[data-group-id="101"]');
    dispatchDrag("drop", rows, { dataTransfer: dt, ...point(rows) });
    dispatchDrag("dragend", source, { dataTransfer: dt });
    await flush(ff);
    assert.equal(tab(root), null);
    assert.ok(warnings.length > 0); assert.ok(warnings.every(args => args[0].startsWith("Foxy:")));
    assert.equal(ff.calls.some(call => (call.api === "runtime.sendMessage" && call.args[0].type === "blank-and-close") || call.api === "tabs.remove"), false);
    assert.ok(await ff.browser.tabs.get(99));
  } finally { console.warn = warn; dispatchDrag("dragend", source, { dataTransfer: dt }); }
});
test("a scrolled row list places its marker in scroll-content coordinates", async () => {
  const set = setup();
  for (let i = 0; i < 30; i++) set.tabs.push({ id: 1000 + i, windowId: 1, groupId: 101, lastAccessed: 100 });
  const { root, calls } = await draw(set);
  const source = tab(root), dt = start(source), rows = root.querySelector('.rows[data-group-id="101"]');
  rows.scrollTop = 160;
  const row = rows.querySelector('[data-tab-id="1005"]');
  const coords = point(row, 0.5, 1);
  try {
    dispatchDrag("dragover", row, { dataTransfer: dt, ...coords });
    const line = root.querySelector(".drop-line").getBoundingClientRect();
    assert.ok(Math.abs(line.top + 1 - row.getBoundingClientRect().bottom) <= 1);
    dispatchDrag("drop", rows, { dataTransfer: dt, ...coords });
    assert.deepEqual(calls.tabs, [[15, { zone: "group", groupId: 101, slot: 8, tabId: 15 }]]);
  } finally { dispatchDrag("dragend", source, { dataTransfer: dt }); }
});

// SAVED headings look like ordinary drop headings but are never drop zones.
test("tab drag over SAVED has no feedback and drop calls no handler", async () => {
    const { root, board, calls, handlers, renderBoard } = await draw();
    renderBoard(root, { ...board, saved: [{ folderId: "f1", title: "Saved", color: "grey", count: 1, cantReopen: [] }] }, {}, handlers);
    const source = tab(root);
    const dt = start(source);
    try {
      for (const selector of [".saved", ".saved .column-title", ".saved .rows", ".saved-row .row-open"]) {
        const target = root.querySelector(selector);
        const valid = root.querySelector('.rows[data-zone="pinned"]');
        dispatchDrag("dragover", valid, { dataTransfer: dt, ...point(valid, 0.5, 0) });
        assert.ok(root.querySelector(".drop-line"));
        const event = dispatchDrag("dragover", target, { dataTransfer: dt, ...point(target) });
        assert.equal(event.defaultPrevented, false); assert.equal(dt.dropEffect, "none");
        assert.equal(root.querySelector(".drop-line, .drop-target"), null);
        dispatchDrag("drop", target, { dataTransfer: dt, ...point(target) });
      }
      assert.deepEqual(calls.tabs, []);
    } finally { dispatchDrag("dragend", source, { dataTransfer: dt }); }
});


// Legacy tab-board tests should not exercise the absent saved-background error path.
test("fix r1: legacy dnd controller helper reads without background warnings", async () => {
  const warn = console.warn, warnings = [];
  console.warn = (...args) => warnings.push(args);
  try { await controller(); assert.deepEqual(warnings, []); }
  finally { console.warn = warn; }
});

test("a failed key check for a post-paint group retries on a later render instead of never saving", async () => {
  const timer = groupTimers(); let root;
  const warn = console.warn; console.warn = () => {};
  try {
    const result = await externalGroup(timer.options); root = result.root;
    const { ff, control } = result;
    const get = ff.browser.storage.sync.get;
    let failNext = true;
    ff.browser.storage.sync.get = async key => {
      if (failNext && key === "tile:group:external") { failNext = false; throw new Error("transient"); }
      return get(key);
    };
    timer.fire(); await flush(ff); await flush(ff);
    assert.equal((await get(null))["tile:group:external"], undefined);
    await control.refresh(); await flush(ff);
    assert.equal(timer.timers.size, 1, "a later render schedules the check again");
    timer.fire(); await flush(ff); await flush(ff);
    assert.deepEqual((await get(null))["tile:group:external"], { x: 6, y: 4, w: 3, h: 4 });
  } finally { console.warn = warn; if (root) { endName(root); root.remove(); } timer.restore(); }
});

// Using the stretched cell for defaults loses a row except at the exact XL pitch.
for (const [width, pitch] of [[1000, 1016 / 6], [1366, 1382 / 8], [1584, 160], [1600, 161.6]]) {
  test(`XL tab drop at ${width}px previews and saves the setting's 2 by 3 default`, async () => {
    let reply = { folders: {}, saved: [], missing: [] };
    const set = { windows: [{ id: 1, focused: true }], selfTabId: 99, groups: [],
      tabs: [{ id: 15, windowId: 1 }, { id: 99, windowId: 1 }] };
    const { root, ff, control } = await controller(set, message => message.type === "foxy:reconcile"
      ? { ok: true } : message.type === "foxy:saved" ? reply : undefined,
      { settings: { showClock: false, showPinned: false, showSaved: false } });
    root.style.width = `${width}px`;
    await ff.browser.storage.local.set({ deviceSettings: { cellSize: "XL" } });
    await control.refresh(); await flush(ff); await flush(ff);
    const grid = root.querySelector(".grid"), bounds = grid.getBoundingClientRect();
    const coords = { clientX: bounds.left + 1.2 * pitch, clientY: bounds.top + 1.2 * pitch };
    const source = tab(root), dataTransfer = start(source);
    try {
      const hit = document.elementFromPoint(coords.clientX, coords.clientY);
      assert.equal(hit, grid, "pointer hits an empty cell");
      assert.ok(dispatchDrag("dragover", hit, { dataTransfer, ...coords }).defaultPrevented);
      const preview = grid.querySelector(".cell-preview").getBoundingClientRect();
      for (const [actual, expected] of [[preview.left - bounds.left, pitch], [preview.top - bounds.top, pitch],
        [preview.width, 2 * pitch - 16], [preview.height, 3 * pitch - 16]]) {
        assert.ok(Math.abs(actual - expected) < 0.5, `stretched preview geometry: expected ${expected}, got ${actual}`);
      }
      dispatchDrag("drop", hit, { dataTransfer, ...coords });
      dispatchDrag("dragend", source, { dataTransfer });
      await flush(ff); await flush(ff);
      const groupId = (await ff.browser.tabs.get(15)).groupId;
      assert.deepEqual(rectOf(root.querySelector(`[data-tile-id="local:${groupId}"]`)), { x: 1, y: 1, w: 2, h: 3 });
      reply = { ...reply, folders: { [groupId]: "new" } };
      endName(root); await control.refresh(); await flush(ff); await flush(ff);
      assert.deepEqual((await ff.browser.storage.sync.get("tile:group:new"))["tile:group:new"],
        { x: 1, y: 1, w: 2, h: 3 });
    } finally { dispatchDrag("dragend", source, { dataTransfer }); endName(root); }
  });
}

for (const [label, x, y, expected] of [
  ["empty cell", 5.2, 0.2, { zone: "cell", tabId: 15, rect: { x: 5, y: 0, w: 3, h: 4 } }],
  ["empty trailing gap", 5.95, 0.2, { zone: "cell", tabId: 15, rect: { x: 5, y: 0, w: 3, h: 4 } }],
  ["right tile gap", 2.95, 0.2, { zone: "group", groupId: 101, slot: 0, tabId: 15 }],
  ["next column", 3.01, 0.2, { zone: "cell", tabId: 15, rect: { x: 3, y: 0, w: 3, h: 4 } }],
  ["bottom tile gap", 0.2, 1.95, { zone: "group", groupId: 101, slot: 2, tabId: 15 }],
  ["next row", 0.2, 2.01, { zone: "cell", tabId: 15, rect: { x: 0, y: 2, w: 3, h: 4 } }],
]) {
  test(`fractional pitch: ${label} selects the cell or covered tile under the pointer`, async () => {
    const { root, board, calls, handlers, renderBoard } = await draw(setup(), 1237.5);
    renderBoard(root, { ...board, columns: board.columns.filter(g => g.id === 101) }, {}, handlers, {
      synced: { showClock: false, showPinned: false, showSaved: false, railCells: 3, otherWindows: true },
      folders: { 101: "one" }, layout: [{ id: "group:one", x: 0, y: 0, w: 3, h: 2 }],
    });
    const grid = root.querySelector(".grid"), bounds = grid.getBoundingClientRect(), pitch = 1253.5 / 13;
    const coords = { clientX: bounds.left + x * pitch, clientY: bounds.top + y * pitch };
    const hit = document.elementFromPoint(coords.clientX, coords.clientY);
    assert.ok(hit && root.contains(hit));
    const source = tab(root), dataTransfer = start(source);
    try {
      assert.ok(dispatchDrag("dragover", hit, { dataTransfer, ...coords }).defaultPrevented);
      if (expected.zone === "cell") {
        const box = root.querySelector(".cell-preview").getBoundingClientRect();
        assert.ok(Math.abs(box.left - (bounds.left + expected.rect.x * pitch)) < 0.5);
        assert.ok(Math.abs(box.top - (bounds.top + expected.rect.y * pitch)) < 0.5);
        assert.ok(Math.abs(box.width - (3 * pitch - 16)) < 0.5);
      } else {
        assert.equal(root.querySelector(".cell-preview"), null);
        assert.ok(root.querySelector('.rows[data-group-id="101"] .drop-line'));
      }
      dispatchDrag("drop", hit, { dataTransfer, ...coords });
      assert.deepEqual(calls.tabs, [[15, expected]]);
    } finally { dispatchDrag("dragend", source, { dataTransfer }); }
  });
}
