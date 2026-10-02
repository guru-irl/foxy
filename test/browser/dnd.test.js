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
async function makeRoot(width = 1600) {
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
async function draw(set = setup(), width = 1600) {
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
  assert.equal(root.querySelectorAll(".dragging, .drop-target, .drop-line").length, 0);
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
async function controller(set = setup()) {
  const ff = createFirefox(set), root = await makeRoot();
  const { createController } = await import("../../extension/src/main.js");
  const control = createController(root, ff.browser);
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
        '.rows[data-group-id="101"]']) {
        const target = root.querySelector(selector), dt = new DataTransfer();
        dt.setData(TAB, String(id));
        ff.calls.length = 0;
        dispatchDrag("drop", target, { dataTransfer: dt, ...point(target, 0.5, 0) });
        await flush(ff);
        assert.deepEqual(ff.calls, [], "a non-board tab must not reach any API, including refresh");
      }
      assert.equal(messages.length, 3);
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
test("Task 3 tab drops on the clock tile and empty grid cells do nothing (Task 4 updates empty cells)", async () => {
  const { root, calls } = await draw();
  const source = tab(root), dataTransfer = start(source);
  try {
    for (const target of [root.querySelector('.tile[data-kind="clock"]'), root.querySelector(".grid")]) {
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
