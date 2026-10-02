import { test, assert, fixture, nextFrame, dispatchDrag } from "./harness.js";
import { createBoardFirefox } from "./controller.js";
import { renderBoard } from "./view.js";

let css;
async function root() {
  css ??= new Promise(resolve => {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/extension/newtab.css";
    link.onload = resolve; document.head.append(link);
  });
  await css; await document.fonts.ready;
  const root = document.createElement("div"); root.className = "board";
  root.style.cssText = "width:1232px;height:600px"; fixture().append(root); return root;
}
const rows = [{ id: 10, title: "Member", windowId: 1 }];
const board = { columns: [{ id: 1, title: "Group", current: true, windowId: 1, color: "gray", rows }],
  pinned: [], tabs: [], saved: [{ folderId: "closed", title: "Saved", color: "grey", count: 1, cantReopen: [] }], missing: [], windowOrder: [1] };

test("grid renders groups and widgets at their saved cells, rail has TABS and gear", async () => {
  const node = await root();
  const layout = [{ id: "clock", x: 0, y: 0, w: 5, h: 2 }, { id: "pinned", x: 5, y: 0, w: 3, h: 4 },
    { id: "group:open", x: 0, y: 2, w: 3, h: 4 }, { id: "saved", x: 3, y: 4, w: 3, h: 4 }];
  renderBoard(node, board, {}, {}, { layout, folders: { 1: "open" } });
  const grid = node.querySelector(".grid"), rail = node.querySelector(".rail");
  assert.ok(grid); assert.ok(rail);
  assert.equal(grid.style.getPropertyValue("--cols"), "10");
  assert.equal(grid.style.getPropertyValue("--cell"), "80px");
  assert.equal(grid.style.getPropertyValue("--gap"), "16px");
  assert.equal(rail.style.getPropertyValue("--rail-cells"), "3");
  assert.equal(rail.querySelector("h2").textContent, "TABS");
  assert.equal(rail.querySelector(".settings-button").getAttribute("aria-label"), "Settings");
  assert.equal(rail.getBoundingClientRect().width, 272);
  for (const tile of layout) {
    const el = [...grid.querySelectorAll(".tile")].find(el => el.dataset.tileId === tile.id);
    assert.ok(el, tile.id); assert.equal(el.dataset.kind, tile.id.startsWith("group:") ? "group" : tile.id);
    assert.equal(el.style.gridColumn, `${tile.x + 1} / span ${tile.w}`);
    assert.equal(el.style.gridRow, `${tile.y + 1} / span ${tile.h}`);
    assert.equal(el.getBoundingClientRect().width, tile.w * 96 - 16);
    assert.equal(el.getBoundingClientRect().height, tile.h * 96 - 16);
  }
  assert.equal(node.querySelector(".strip, .new-group"), null);
  assert.equal(node.querySelector(".column-header").draggable, false);
  const transfer = dispatchDrag("dragstart", node.querySelector(".column-header")).dataTransfer;
  assert.equal(transfer.types.length, 0, "headers cannot start HTML5 group drags");
  const group = node.querySelector('.tile[data-kind="group"]');
  transfer.setData("application/x-foxy-tab", "30");
  dispatchDrag("drop", node.querySelector(".grid"), { dataTransfer: transfer });
  assert.equal(group.querySelector(".drop-line"), null, "empty-cell drops are left to Task 4");
});

test("missing banner stays above grid and rail", async () => {
  const node = await root(); renderBoard(node, { ...board, missing: [{ folderId: "missing" }] }, {}, {});
  const banner = node.previousElementSibling;
  assert.ok(banner.classList.contains("banner"));
  assert.ok(banner.getBoundingClientRect().bottom <= node.querySelector(".grid").getBoundingClientRect().top);
});

async function flush(ff) { await ff.settle(); for (let i = 0; i < 4; i++) await nextFrame(); }
async function controller({ layout = {}, settings = {}, beforeStart = () => {} } = {}) {
  const ff = createBoardFirefox({ windows: [{ id: 1 }, { id: 2 }], selfTabId: 99,
    groups: [{ id: 1, windowId: 1, title: "Group" }, { id: 2, windowId: 2, title: "Remote" }],
    tabs: [{ id: 10, windowId: 1, groupId: 1 }, { id: 11, windowId: 1, pinned: true },
      { id: 20, windowId: 2, groupId: 2 }, { id: 21, windowId: 2, pinned: true }, { id: 22, windowId: 2 },
      { id: 99, windowId: 1 }] }, message => message.type === "foxy:reconcile" ? { ok: true }
      : message.type === "foxy:saved" ? { folders: { 1: "open", 2: "remote" }, saved: board.saved, missing: [{ folderId: "missing" }] } : undefined);
  await ff.browser.storage.sync.set({ ...layout, settings }); await ff.settle();
  beforeStart(ff);
  const node = await root(); const { createController } = await import("../../extension/src/main.js");
  const control = createController(node, ff.browser); await control.refresh(); await flush(ff);
  return { ff, node, control };
}

test("load saves only new tiles and prunes only absent folder keys", async () => {
  const { ff } = await controller({ layout: { "tile:group:closed": { x: 0, y: 7, w: 3, h: 4 },
    "tile:group:missing": { x: 3, y: 7, w: 3, h: 4 }, "tile:group:gone": { x: 0, y: 9, w: 3, h: 4 } } });
  const saved = await ff.browser.storage.sync.get(null);
  assert.ok(saved["tile:group:open"]); assert.ok(saved["tile:group:remote"]);
  assert.ok(saved["tile:clock"]); assert.ok(saved["tile:pinned"]); assert.ok(saved["tile:saved"]);
  assert.ok(saved["tile:group:closed"]); assert.ok(saved["tile:group:missing"]);
  assert.equal(saved["tile:group:gone"], undefined);
  const writes = ff.calls.filter(c => c.api === "storage.sync.set").slice(1).flatMap(c => Object.keys(c.args[0])).sort();
  assert.deepEqual(writes, ["tile:clock", "tile:group:open", "tile:group:remote", "tile:pinned", "tile:saved"]);
});

test("settings load and storage changes apply sizes, windows, visibility, density and alpha", async () => {
  const { ff, node } = await controller({ settings: { showClock: false, otherWindows: false } });
  assert.equal(node.querySelector('[data-kind="clock"]'), null);
  assert.equal(node.querySelector('[data-group-id="2"]'), null);
  assert.equal(node.querySelector('[data-tab-id="21"]'), null);
  assert.equal(node.querySelector('[data-tab-id="22"]'), null);
  await ff.browser.storage.sync.set({ settings: { railCells: 100, showPinned: false, showSaved: false, transparency: "high", otherWindows: true } });
  await ff.browser.storage.local.set({ deviceSettings: { cellSize: "S", density: "compact" } });
  await flush(ff);
  assert.equal(node.querySelector(".grid").style.getPropertyValue("--cell"), "48px");
  assert.equal(node.querySelector(".rail").style.getPropertyValue("--rail-cells"), "9");
  assert.equal(node.querySelector('[data-kind="pinned"], [data-kind="saved"]'), null);
  assert.ok(node.querySelector('[data-kind="clock"]'));
  assert.ok(node.querySelector('[data-group-id="2"]'));
  assert.equal(node.querySelector(".row").getBoundingClientRect().height, 24);
  const header = node.querySelector(".column-header").getBoundingClientRect();
  const close = node.querySelector(".column-header .column-close").getBoundingClientRect();
  assert.ok(close.top >= header.top && close.bottom <= header.bottom, "compact headers must not clip their close control");
  for (const [scheme, expected] of [["dark", "rgba(22, 22, 24, 0.45)"], ["light", "rgba(246, 246, 247, 0.55)"]]) {
    node.style.colorScheme = scheme;
    assert.equal(getComputedStyle(node.querySelector('.tile[data-kind="group"]')).backgroundColor, expected);
  }
});

for (const hold of ["drag", "editor"]) {
  test(`storage updates during ${hold} are held until the next allowed render`, async () => {
    const { ff, node, control } = await controller();
    const original = node.querySelector('[data-group-id="1"]');
    if (hold === "drag") control.handlers.onDragState(true); else original.querySelector(".group-name").click();
    await ff.browser.storage.sync.set({ settings: { showClock: false }, "tile:group:open": { x: 0, y: 10, w: 4, h: 3 } });
    await ff.browser.storage.local.set({ deviceSettings: { density: "compact" } });
    await flush(ff);
    assert.equal(node.querySelector('[data-group-id="1"]'), original);
    assert.ok(node.querySelector('[data-kind="clock"]'));
    if (hold === "drag") control.handlers.onDragState(false);
    else node.querySelector(".name-editor").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush(ff);
    assert.equal(node.querySelector('[data-kind="clock"]'), null);
    assert.equal(node.querySelector('[data-group-id="1"]').style.gridRow, "11 / span 3");
    assert.equal(node.querySelector(".row").getBoundingClientRect().height, 24);
  });
}

test("width changes coalesce to one frame, fit without writes, and widening restores saved places", async () => {
  const { ff, node } = await controller({ layout: { "tile:group:open": { x: 7, y: 6, w: 3, h: 4 } } });
  const stored = await ff.browser.storage.sync.get(null);
  let renders = 0; const replace = node.replaceChildren.bind(node); node.replaceChildren = (...args) => { renders++; replace(...args); };
  ff.calls.length = 0;
  node.style.width = "560px";
  for (let i = 0; i < 20; i++) window.dispatchEvent(new Event("resize"));
  await flush(ff);
  assert.equal(renders, 1);
  assert.equal(node.querySelector(".grid").style.getPropertyValue("--cols"), "3");
  assert.equal(node.querySelector('[data-group-id="1"]').style.gridColumn, "1 / span 3");
  assert.deepEqual(await ff.browser.storage.sync.get(null), stored);
  assert.equal(ff.calls.filter(c => c.api === "storage.sync.set" || c.api === "storage.sync.remove").length, 0);
  node.style.width = "1232px"; window.dispatchEvent(new Event("resize")); await flush(ff);
  assert.equal(node.querySelector('[data-group-id="1"]').style.gridColumn, "8 / span 3");
  assert.equal(node.querySelector('[data-group-id="1"]').style.gridRow, "7 / span 4");
});


test("failed storage reads keep the shown layout and settings, write nothing, and recover on a later event", async () => {
  const { ff, node, control } = await controller({ layout: { "tile:group:open": { x: 7, y: 6, w: 3, h: 4 } } });
  const original = node.querySelector('[data-group-id="1"]'), get = ff.browser.storage.sync.get;
  const warnings = [], warn = console.warn; console.warn = (...args) => warnings.push(args);
  try {
    await ff.browser.storage.sync.set({ settings: { showClock: false }, "tile:group:open": { x: 0, y: 10, w: 4, h: 3 } });
    ff.browser.storage.sync.get = async () => { throw new Error("Storage unavailable"); };
    ff.calls.length = 0;
    await flush(ff); await control.refresh(); await flush(ff);
    assert.equal(node.querySelector('[data-group-id="1"]'), original, "a failed load must not apply defaults over the shown layout");
    assert.ok(node.querySelector('[data-kind="clock"]'), "failed settings reads retain the applied settings");
    assert.equal(ff.calls.filter(c => c.api === "storage.sync.set" || c.api === "storage.sync.remove").length, 0);
    assert.ok(warnings.length > 0); assert.ok(warnings.every(w => w[0].startsWith("Foxy:")));
    const count = warnings.length; await flush(ff); assert.equal(warnings.length, count, "no retry loop");
    ff.browser.storage.sync.get = get;
    ff.fire("storage.onChanged", { settings: { newValue: { showClock: false } } }, "sync");
    await flush(ff);
    assert.equal(node.querySelector('[data-kind="clock"]'), null);
    assert.equal(node.querySelector('[data-group-id="1"]').style.gridRow, "11 / span 3");
  } finally { ff.browser.storage.sync.get = get; console.warn = warn; }
});

test("an initial layout-read failure displays defaults without overwriting or pruning unread keys", async () => {
  const warnings = [], warn = console.warn; console.warn = (...args) => warnings.push(args);
  let get;
  try {
    const { ff, node } = await controller({ layout: { "tile:group:open": { x: 7, y: 6, w: 3, h: 4 }, "tile:group:unknown": { x: 0, y: 12, w: 3, h: 4 } }, beforeStart(ff) {
      get = ff.browser.storage.sync.get;
      ff.browser.storage.sync.get = async keys => { if (keys === null) throw new Error("Layout unavailable"); return get(keys); };
    } });
    assert.ok(node.querySelector('[data-group-id="1"]'));
    const stored = await get(null);
    assert.deepEqual(stored["tile:group:open"], { x: 7, y: 6, w: 3, h: 4 });
    assert.ok(stored["tile:group:unknown"]);
    assert.equal(ff.calls.filter(c => c.api === "storage.sync.set").length, 1, "only the fixture seed write is allowed");
    assert.equal(ff.calls.filter(c => c.api === "storage.sync.remove").length, 0);
    assert.ok(warnings.some(w => w[0].startsWith("Foxy:")));
    ff.browser.storage.sync.get = get;
  } finally { console.warn = warn; }
});

// Visibility resumes a throttled clock without replacing the row/editor DOM.
test("clock settings apply live and visibility updates the tile without a board render", async () => {
  const DateClass = globalThis.Date;
  let hour = 13;
  globalThis.Date = class extends DateClass {
    constructor(...args) { super(...(args.length ? args : [2026, 9, 3, hour, 5])); }
  };
  try {
    const { ff, node } = await controller({ settings: { timeFormat: "12", showDate: false } });
    const row = node.querySelector('[data-tab-id="10"]');
    assert.equal(node.querySelector(".clock-time").textContent, "1:05 PM");
    assert.equal(node.querySelector(".clock-date").hidden, true);
    await ff.browser.storage.sync.set({ settings: { timeFormat: "24", showDate: true } }); await flush(ff);
    assert.equal(node.querySelector(".clock-time").textContent, "13:05");
    assert.equal(node.querySelector(".clock-date").hidden, false);
    const current = node.querySelector('[data-tab-id="10"]'); assert.ok(current !== row);
    let renders = 0; const replace = node.replaceChildren.bind(node); node.replaceChildren = (...args) => { renders++; replace(...args); };
    const hidden = Object.getOwnPropertyDescriptor(document, "hidden");
    try {
      hour = 14;
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
      assert.equal(node.querySelector(".clock-time").textContent, "14:05");
      assert.equal(renders, 0); assert.equal(node.querySelector('[data-tab-id="10"]'), current);
    } finally { if (hidden) Object.defineProperty(document, "hidden", hidden); else delete document.hidden; }
  } finally { globalThis.Date = DateClass; }
});


test("a storage change and bookmark update in one frame both publish without tab reads", async () => {
  const { ff, node } = await controller();
  const send = ff.browser.runtime.sendMessage;
  ff.browser.runtime.sendMessage = async message => {
    const reply = await send(message);
    return message.type === "foxy:saved" ? { ...reply, saved: [{ ...reply.saved[0], title: "Changed saved title" }] } : reply;
  };
  try {
    ff.calls.length = 0;
    ff.fire("bookmarks.onChanged", "closed", { title: "Changed saved title" });
    await ff.browser.storage.sync.set({ settings: { showClock: false } });
    await flush(ff);
    assert.equal(node.querySelector('[data-kind="clock"]'), null);
    assert.equal(node.querySelector(".saved-row .row-label").textContent, "Changed saved title");
    assert.equal(ff.calls.filter(c => c.api === "windows.getAll").length, 0);
    assert.equal(ff.calls.filter(c => c.api === "runtime.sendMessage" && c.args[0].type === "foxy:saved").length, 1);
  } finally { ff.browser.runtime.sendMessage = send; }
});
