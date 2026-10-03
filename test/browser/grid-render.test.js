import { test, assert, fixture, nextFrame, dispatchDrag } from "./harness.js";
import { createBoardFirefox } from "./controller.js";
import { renderBoard } from "./view.js";
import { narrowGroups, narrowFolders, narrowLayout } from "./fixtures/narrow-layout.js";

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

function rectStyle(node) {
  return ["x", "y", "w", "h"].map(key => node.style.getPropertyValue(`--${key}`));
}
function near(actual, expected, label) { assert.ok(Math.abs(actual - expected) <= 0.5, `${label}: ${actual} vs ${expected}`); }

test("grid renders groups and widgets at absolute cells, gear is a separate card", async () => {
  const node = await root();
  const layout = [{ id: "clock", x: 0, y: 0, w: 5, h: 2 }, { id: "pinned", x: 5, y: 0, w: 3, h: 4 },
    { id: "group:open", x: 0, y: 2, w: 3, h: 4 }, { id: "saved", x: 3, y: 4, w: 3, h: 4 }];
  renderBoard(node, board, {}, {}, { layout, folders: { 1: "open" } });
  const grid = node.querySelector(".grid"), rail = node.querySelector(".rail");
  assert.ok(grid); assert.ok(rail);
  assert.equal(grid.style.getPropertyValue("--cols"), "10");
  assert.equal(grid.style.getPropertyValue("--cell"), "80px");
  assert.equal(grid.style.getPropertyValue("--gap"), "16px");
  assert.equal(grid.style.getPropertyValue("--pitch"), "96px");
  assert.equal(rail.style.getPropertyValue("--rail-cells"), "3");
  assert.equal(rail.querySelector("h2").textContent, "TABS");
  const gear = node.querySelector(".settings-cell"), heading = rail.querySelector("h2");
  assert.equal(gear.getAttribute("aria-label"), "Settings");
  assert.equal(heading.contains(gear), false, "the heading's accessible name must be exactly TABS");
  assert.equal(gear.parentElement, node, "gear is outside the rail");
  const gearBox = gear.getBoundingClientRect(), railBox = rail.getBoundingClientRect(), boardBox = node.getBoundingClientRect();
  near(gearBox.width, 80, "gear width"); near(gearBox.height, 80, "gear height");
  near(gearBox.right, boardBox.right, "gear right"); near(gearBox.bottom, boardBox.bottom, "gear bottom");
  near(railBox.top, boardBox.top, "rail top"); near(railBox.bottom + 16, gearBox.top, "rail/gear gap");
  assert.equal(rail.getBoundingClientRect().width, 272);
  for (const tile of layout) {
    const el = [...grid.querySelectorAll(".tile")].find(el => el.dataset.tileId === tile.id);
    assert.ok(el, tile.id); assert.equal(el.dataset.kind, tile.id.startsWith("group:") ? "group" : tile.id);
    assert.deepEqual(rectStyle(el), [tile.x, tile.y, tile.w, tile.h].map(String));
    assert.equal(el.style.gridColumn, ""); assert.equal(el.style.gridRow, "");
    assert.equal(getComputedStyle(el).position, "absolute");
    const box = el.getBoundingClientRect(), origin = grid.getBoundingClientRect();
    near(box.left - origin.left, tile.x * 96, "tile left");
    near(box.top - origin.top, tile.y * 96, "tile top");
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

test("load saves only new tiles and preserves a tile whose folder is not known yet", async () => {
  const { ff } = await controller({ layout: { "tile:group:closed": { x: 0, y: 7, w: 3, h: 4 },
    "tile:group:missing": { x: 3, y: 7, w: 3, h: 4 }, "tile:group:gone": { x: 0, y: 9, w: 3, h: 4 } } });
  const saved = await ff.browser.storage.sync.get(null);
  assert.ok(saved["tile:group:open"]); assert.ok(saved["tile:group:remote"]);
  assert.ok(saved["tile:clock"]); assert.ok(saved["tile:pinned"]); assert.ok(saved["tile:saved"]);
  assert.ok(saved["tile:group:closed"]); assert.ok(saved["tile:group:missing"]);
  assert.deepEqual(saved["tile:group:gone"], { x: 0, y: 9, w: 3, h: 4 });
  assert.equal(ff.calls.filter(c => c.api === "storage.sync.remove").length, 0);
  const writes = ff.calls.filter(c => c.api === "storage.sync.set").slice(1).flatMap(c => Object.keys(c.args[0])).sort();
  assert.deepEqual(writes, ["tile:clock", "tile:group:open", "tile:group:remote", "tile:pinned", "tile:saved"]);
});

test("load past 400 tile keys prunes unknown folders but keeps open, saved and missing ones", async () => {
  const layout = Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`tile:group:unknown-${i}`, { x: 0, y: 9, w: 3, h: 4 }]));
  layout["tile:group:closed"] = { x: 0, y: 7, w: 3, h: 4 };
  layout["tile:group:missing"] = { x: 3, y: 7, w: 3, h: 4 };
  const { ff } = await controller({ layout });
  const stored = await ff.browser.storage.sync.get(null);
  assert.deepEqual(Object.keys(stored).filter(key => key.startsWith("tile:")).sort(),
    ["tile:clock", "tile:group:closed", "tile:group:missing", "tile:group:open", "tile:group:remote", "tile:pinned", "tile:saved"]);
});

for (const accepted of [true, false]) {
  test(`SAVED delete ${accepted ? "removes its tile key" : "keeps its tile key when refused"}`, async () => {
    const warn = console.warn; console.warn = () => {};
    try {
      let deleted = false;
      const { ff, node, control } = await controller({ layout: {
        "tile:group:closed": { x: 0, y: 7, w: 3, h: 4 }, "tile:group:unrelated": { x: 3, y: 7, w: 3, h: 4 },
      }, beforeStart(ff) {
        const send = ff.browser.runtime.sendMessage;
        ff.browser.runtime.sendMessage = async message => {
          if (message.type === "foxy:delete-saved") { deleted = accepted; return { ok: accepted }; }
          const reply = await send(message);
          return message.type === "foxy:saved" && deleted ? { ...reply, saved: [] } : reply;
        };
      } });
      await control.handlers.onDeleteSaved("closed");
      assert.ok((await ff.browser.storage.sync.get(null))["tile:group:closed"], "unconfirmed deletion must not remove the key");
      node.querySelector('[data-folder-id="closed"] .saved-delete').click();
      await control.handlers.onDeleteSaved("closed"); await flush(ff);
      const stored = await ff.browser.storage.sync.get(null);
      assert.equal(stored["tile:group:closed"] === undefined, accepted);
      assert.deepEqual(stored["tile:group:unrelated"], { x: 3, y: 7, w: 3, h: 4 });
      assert.equal(ff.calls.filter(c => c.api === "storage.sync.remove").length, accepted ? 1 : 0);
    } finally { console.warn = warn; }
  });
}

for (const delay of [80, 650]) {
  test(`first grid paint waits up to 500ms and writes wait for the saved reply (${delay}ms)`, async () => {
    let release, arrived = false;
    const reply = new Promise(resolve => { release = resolve; }).then(value => { arrived = true; return value; });
    const ff = createBoardFirefox({ windows: [{ id: 1 }], selfTabId: 99,
      groups: [{ id: 1, windowId: 1, title: "Group" }],
      tabs: [{ id: 10, windowId: 1, groupId: 1 }, { id: 99, windowId: 1 }] },
      message => message.type === "foxy:reconcile" ? { ok: true }
        : message.type === "foxy:saved" ? reply : undefined);
    await ff.browser.storage.sync.set({ "tile:pinned": { x: 5, y: 0, w: 3, h: 4 },
      "tile:group:open": { x: 0, y: 0, w: 3, h: 4 } });
    await ff.settle();
    const node = await root(), paints = [];
    const replace = node.replaceChildren.bind(node);
    node.replaceChildren = (...args) => {
      paints.push([...args[0].querySelectorAll(".tile")].map(t => [t.dataset.tileId, ...rectStyle(t)]));
      replace(...args);
    };
    ff.calls.length = 0;
    const earlyWrites = [], set = ff.browser.storage.sync.set;
    ff.browser.storage.sync.set = async entries => {
      if (!arrived) earlyWrites.push(entries);
      return set(entries);
    };
    const { createController } = await import("../../extension/src/main.js");
    const control = createController(node, ff.browser);
    const timer = setTimeout(() => release({ folders: { 1: "open" }, saved: [], missing: [] }), delay);
    try {
      await control.refresh();
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal(paints.length, 0, "a quick tab snapshot must not paint before the first saved reply");
      if (delay > 500) {
        await new Promise(resolve => setTimeout(resolve, 510));
        assert.ok(node.querySelector('[data-tile-id="local:1"]'), "the 500ms fallback must paint while the reply is still pending");
        assert.equal(ff.calls.filter(c => c.api === "storage.sync.set").length, 0, "fallback paint must not save tiles");
      }
      await reply; await flush(ff);
      assert.deepEqual(earlyWrites, [], "nothing may be written before a saved reply arrives");
      if (delay < 500) {
        assert.ok(paints.length > 0);
        assert.ok(paints.every(tiles => tiles.some(t => t[0] === "group:open" && t[1] === "0" && t[2] === "0" && t[3] === "3" && t[4] === "4")), "quick replies must never paint a default group place");
      }
      const stored = await ff.browser.storage.sync.get(null);
      assert.deepEqual(stored["tile:clock"], { x: 0, y: 4, w: 5, h: 2 }, "new clock must avoid the group's saved cells");
      assert.deepEqual(rectStyle(node.querySelector('[data-tile-id="group:open"]')), ["0", "0", "3", "4"]);
    } finally {
      clearTimeout(timer); release({ folders: { 1: "open" }, saved: [], missing: [] });
    }
  });
}

for (const pins of ["pending", "reject"]) {
  test(`first saved reply releases paint and writes independently of ${pins} pin names`, async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const warn = console.warn; console.warn = () => {};
    try {
      const { ff, node } = await controller({ layout: {
        "tile:pinned": { x: 5, y: 0, w: 3, h: 4 }, "tile:group:open": { x: 0, y: 0, w: 3, h: 4 },
      }, beforeStart(ff) {
        const send = ff.browser.runtime.sendMessage;
        ff.browser.runtime.sendMessage = async message => {
          if (message.type !== "foxy:pins") return send(message);
          if (pins === "reject") throw new Error("Pin names unavailable");
          await gate; return { pins: {} };
        };
      } });
      await new Promise(resolve => setTimeout(resolve, 80)); await flush(ff);
      const tile = node.querySelector('[data-tile-id="group:open"]');
      assert.ok(tile, "the saved reply, not the pin reply, releases first paint");
      assert.deepEqual(rectStyle(tile), ["0", "0", "3", "4"]);
      assert.ok((await ff.browser.storage.sync.get(null))["tile:clock"], "an arrived saved reply allows new tile writes");
      release(); await flush(ff);
    } finally { release(); console.warn = warn; }
  });
}

test("settings load and storage changes apply sizes, windows, visibility, density and alpha", async () => {
  const { ff, node } = await controller({ settings: { showClock: false, otherWindows: false } });
  assert.equal(node.querySelector('[data-kind="clock"]'), null);
  assert.equal(node.querySelector('[data-group-id="2"]'), null);
  assert.equal(node.querySelector('[data-tab-id="21"]'), null);
  assert.equal(node.querySelector('[data-tab-id="22"]'), null);
  await ff.browser.storage.sync.set({ settings: { railCells: 100, showPinned: false, showSaved: false, transparency: "high", otherWindows: true } });
  await ff.browser.storage.local.set({ deviceSettings: { cellSize: "S", density: "compact" } });
  await flush(ff);
  assert.equal(node.querySelector(".grid").style.getPropertyValue("--cell"), `${1248 / 19 - 16}px`);
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
    assert.deepEqual(rectStyle(node.querySelector('[data-group-id="1"]')), ["0", "10", "4", "3"]);
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
  assert.deepEqual(rectStyle(node.querySelector('[data-group-id="1"]')).filter((_, i) => i !== 1), ["0", "3", "4"]);
  assert.deepEqual(await ff.browser.storage.sync.get(null), stored);
  assert.equal(ff.calls.filter(c => c.api === "storage.sync.set" || c.api === "storage.sync.remove").length, 0);
  node.style.width = "1232px"; window.dispatchEvent(new Event("resize")); await flush(ff);
  assert.deepEqual(rectStyle(node.querySelector('[data-group-id="1"]')), ["7", "6", "3", "4"]);
});


// First-free overflow wrapping or resize writes break the reported arrangement.
test("the user's arrangement survives one- and five-cell narrowing and restores on widening without writes", async () => {
  const ff = createBoardFirefox({ windows: [{ id: 1 }], selfTabId: 99, groups: narrowGroups,
    tabs: [...narrowGroups.map(group => ({ id: group.id + 10, windowId: 1, groupId: group.id })),
      { id: 90, windowId: 1, pinned: true }, { id: 99, windowId: 1 }] },
    message => message.type === "foxy:reconcile" ? { ok: true }
      : message.type === "foxy:saved" ? { folders: narrowFolders, saved: [], missing: [] } : undefined);
  await ff.browser.storage.sync.set(narrowLayout); await ff.settle();
  const node = await root(); node.style.width = "2192px"; // 23 total, 20 grid columns.
  const { createController } = await import("../../extension/src/main.js");
  const control = createController(node, ff.browser); await control.refresh(); await flush(ff);
  const stored = await ff.browser.storage.sync.get(null); ff.calls.length = 0;
  const check = lost => {
    assert.equal(node.querySelector(".grid").style.getPropertyValue("--cols"), String(20 - lost));
    const origin = node.querySelector(".grid").getBoundingClientRect();
    for (const [key, saved] of Object.entries(narrowLayout)) {
      const tile = node.querySelector(`[data-tile-id="${key.slice(5)}"]`);
      const x = saved.x >= 10 ? saved.x - lost : saved.x;
      assert.deepEqual(rectStyle(tile), [x, saved.y, saved.w, saved.h].map(String));
      near(tile.getBoundingClientRect().left - origin.left, x * 96, `${key} left`);
      near(tile.getBoundingClientRect().top - origin.top, saved.y * 96, `${key} top`);
    }
  };
  check(0);
  for (const lost of [1, 5, 0]) {
    node.style.width = `${(23 - lost) * 96 - 16}px`;
    window.dispatchEvent(new Event("resize")); await flush(ff); check(lost);
    assert.deepEqual(await ff.browser.storage.sync.get(null), stored);
    assert.equal(ff.calls.filter(c => /storage\.(sync|local)\.(set|remove|clear)/.test(c.api)).length, 0);
  }
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
    assert.deepEqual(rectStyle(node.querySelector('[data-group-id="1"]')), ["0", "10", "4", "3"]);
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


test("a controller render draws the clock once with the real settings", async () => {
  const { ff, node } = await controller();
  const changes = [], clocks = [];
  const observer = new MutationObserver(records => changes.push(...records));
  observer.observe(node, { subtree: true, childList: true });
  const replace = node.replaceChildren.bind(node);
  node.replaceChildren = (...args) => {
    clocks.push(args[0].querySelector(".clock-time"));
    replace(...args);
  };
  try {
    await ff.browser.storage.sync.set({ settings: { timeFormat: "12", showDate: false } });
    await flush(ff);
    assert.equal(clocks.length, 1);
    assert.equal(changes.filter(record => record.target === clocks[0]).length, 1, "no default-settings clock draw before the actual draw");
    assert.equal(node.querySelector(".clock").dataset.format, "12");
    assert.equal(node.querySelector(".clock-date").hidden, true);
  } finally { observer.disconnect(); }
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

test("the board fills the page and fractional columns meet the right edge", async () => {
  await root();
  const page = document.createElement("main"); page.className = "page"; page.style.width = "1237.5px";
  const node = document.createElement("div"); node.className = "board";
  page.append(node); fixture().append(page);
  renderBoard(node, board, {}, {}, { layout: [{ id: "group:open", x: 0, y: 0, w: 10, h: 4 }], folders: { 1: "open" },
    synced: { showClock: false, showPinned: false, showSaved: false, railCells: 3, otherWindows: true } });
  const pageBox = page.getBoundingClientRect(), box = node.getBoundingClientRect();
  for (const side of ["top", "right", "bottom", "left"]) near(box[side], pageBox[side], `board ${side}`);
  const grid = node.querySelector(".grid"), tile = grid.querySelector(".tile"), rail = node.querySelector(".rail");
  const cell = 1253.5 / 13 - 16, pitch = 1253.5 / 13;
  near(parseFloat(getComputedStyle(grid).getPropertyValue("--cell")), cell, "stretched cell");
  near(tile.getBoundingClientRect().width, 10 * pitch - 16, "fractional tile width");
  near(tile.getBoundingClientRect().height, 4 * pitch - 16, "square cell height");
  near(tile.getBoundingClientRect().right + 16 + rail.getBoundingClientRect().width, pageBox.right, "all columns end at page right");
  near(grid.getBoundingClientRect().top, pageBox.top, "grid top");
  near(grid.getBoundingClientRect().bottom, pageBox.bottom, "grid bottom");
  assert.equal(tile.style.gridColumn, ""); assert.equal(tile.style.gridRow, "");
});

test("fractional neighbours keep a 16 px gap and the last row remains scrollable", async () => {
  const node = await root(); node.style.width = "1237.5px";
  renderBoard(node, board, {}, {}, { layout: [
    { id: "clock", x: 0, y: 0, w: 3, h: 2 }, { id: "pinned", x: 3, y: 0, w: 3, h: 2 },
    { id: "group:open", x: 0, y: 12, w: 10, h: 2 }], folders: { 1: "open" },
    synced: { showClock: true, showPinned: true, showSaved: false, railCells: 3, otherWindows: true } });
  const grid = node.querySelector(".grid"), clock = node.querySelector(".clock").getBoundingClientRect(), pinned = node.querySelector('[data-kind="pinned"]').getBoundingClientRect();
  near(pinned.left - clock.right, 16, "horizontal gap");
  near(grid.scrollHeight, 14 * (1253.5 / 13) - 16, "row extent");
  grid.scrollTop = grid.scrollHeight;
  near(node.querySelector('[data-kind="group"]').getBoundingClientRect().bottom, grid.getBoundingClientRect().bottom, "last tile bottom");
});

test("a failed saved-groups reply writes no tiles, since group places are unknown", async () => {
  const ff = createBoardFirefox({ windows: [{ id: 1 }], selfTabId: 99,
    groups: [{ id: 1, windowId: 1, title: "Group" }],
    tabs: [{ id: 10, windowId: 1, groupId: 1 }, { id: 99, windowId: 1 }] },
  message => message.type === "foxy:reconcile" ? { ok: true }
    : message.type === "foxy:saved" ? { ok: false } : undefined);
  await ff.browser.storage.sync.set({ "tile:group:open": { x: 0, y: 0, w: 3, h: 4 } }); await ff.settle();
  ff.calls.length = 0;
  const warn = console.warn; console.warn = () => {};
  try {
    const node = await root(); const { createController } = await import("../../extension/src/main.js");
    const control = createController(node, ff.browser); await control.refresh(); await flush(ff);
    await new Promise(resolve => setTimeout(resolve, 600)); await flush(ff);
    assert.ok(node.querySelector(".grid .tile"), "the board still paints");
    assert.deepEqual(ff.calls.filter(c => c.api === "storage.sync.set"), []);
  } finally { console.warn = warn; }
});
