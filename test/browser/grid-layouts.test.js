import { test, assert, fixture, nextFrame, dispatchDrag } from "./harness.js";
import { createBoardFirefox } from "./controller.js";
import { createController } from "../../extension/src/main.js";
import { createController as createOldController } from "./fixtures/foxy-3.1.1/src/main.js";
import { resetLayout } from "../../extension/src/settings/pane.js";
import { realLayout, realGroups, realFolders, widthEntries } from "./fixtures/real-layout.js";

const narrowLayout = {
  clock: { x: 0, y: 0, w: 6, h: 4 }, pinned: { x: 0, y: 4, w: 6, h: 3 },
  "group:tbr": { x: 6, y: 0, w: 11, h: 9 }, "group:dev": { x: 0, y: 9, w: 8, h: 9 },
  "group:cov": { x: 8, y: 9, w: 9, h: 9 }, "group:oce": { x: 0, y: 18, w: 8, h: 9 },
  "group:harness": { x: 8, y: 18, w: 9, h: 8 }, "group:telemetry": { x: 0, y: 27, w: 8, h: 8 },
};
let css;
async function flush(ff) {
  if (document.querySelector(".grid.settling")) await new Promise(resolve => setTimeout(resolve, 330));
  for (let i = 0; i < 8; i++) { await ff.settle(); await nextFrame(); }
}
async function setup(c = 34, entries = { "layout:34": { t: 1 }, ...widthEntries(34) }, replyGate, controllerOptions = {}, groups = realGroups) {
  css ??= new Promise(resolve => {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/extension/newtab.css";
    link.onload = resolve; document.head.append(link);
  }); await css;
  const folders = { ...realFolders };
  const ff = createBoardFirefox({ windows: [{ id: 1 }], selfTabId: 99, groups,
    tabs: [...groups.map(g => ({ id: 10 + g.id, windowId: 1, groupId: g.id })),
      { id: 30, windowId: 1 }, { id: 99, windowId: 1 }] },
  message => message.type === "foxy:reconcile" ? { ok: true } : message.type === "foxy:saved"
    ? replyGate ? replyGate.then(() => ({ saved: [], missing: [], folders })) : { saved: [], missing: [], folders } : undefined);
  await ff.browser.storage.sync.set({ settings: { railCells: 5 }, ...entries });
  await ff.browser.storage.local.set({ deviceSettings: { cellSize: "S" } }); await ff.settle();
  const root = document.createElement("div"); root.className = "board";
  root.style.cssText = `width:${(c + 5) * 64 - 16}px;height:800px`; fixture().append(root);
  const control = createController(root, ff.browser, undefined, { newGroupDelay: 10, ...controllerOptions });
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
async function move(root, ff, id, dx, dy, replyHeld = false) {
  const source = node(root, id).querySelector(".column-header, .tile-header"), b = source.getBoundingClientRect();
  const start = { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 };
  const at = { clientX: start.clientX + dx * 64, clientY: start.clientY + dy * 64 };
  pointer("pointerdown", source, start); pointer("pointermove", document, at);
  pointer("pointerup", document, at);
  if (replyHeld) { await new Promise(resolve => setTimeout(resolve, 330)); for (let i = 0; i < 8; i++) await nextFrame(); }
  else await flush(ff);
}
async function resize(root, ff, c) {
  root.style.width = `${(c + 5) * 64 - 16}px`; window.dispatchEvent(new Event("resize")); await flush(ff);
}
for (const [c, rectangles] of [[34, [[0,0,6,4],[0,4,6,3],[6,0,7,9],[13,0,7,9],[20,0,7,9],[27,0,7,9],[20,9,7,8],[27,9,7,8]]],
  [33, [[0,0,6,4],[0,4,6,3],[6,0,7,9],[13,0,6,9],[19,0,7,9],[26,0,7,9],[19,9,7,8],[26,9,7,8]]],
  [28, [[0,0,5,4],[0,4,5,3],[5,0,6,9],[11,0,5,9],[16,0,6,9],[22,0,6,9],[16,9,6,8],[22,9,6,8]]],
  [17, [[0,0,6,4],[0,4,6,3],[6,0,7,9],[0,9,7,9],[7,9,7,9],[0,18,7,9],[7,18,7,8],[0,27,7,8]]]]) {
  test(`real saved 34-column layout renders at ${c} without writes`, async () => {
    const { root, ff, control } = await setup(c);
    assert.equal(control.view.cols, c); assert.equal(control.view.k, 34);
    assert.deepEqual(Object.values(shown(root)).map(r => [r.x, r.y, r.w, r.h]), rectangles);
    assert.deepEqual(writes(ff), []);
    assert.ok((await ff.browser.storage.local.get("layoutsShown")).layoutsShown[34] > 0, "source 34 is recorded locally even in a narrow window");
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
test("legacy migration waits for valid folders, copies once without removing and ignores late legacy", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const entries = Object.fromEntries(Object.entries(realLayout).map(([id, r]) => [`tile:${id}`, r]));
  const { root, ff } = await setup(34, entries, gate);
  try {
    assert.deepEqual(writes(ff), []); release(); await flush(ff);
    assert.equal(writes(ff).length, 1);
    assert.deepEqual(Object.fromEntries(Object.entries(writes(ff)[0]).filter(([k]) => k.startsWith("tile:"))), widthEntries(34));
    const removals = ff.calls.filter(c => c.api === "storage.sync.remove");
    assert.deepEqual(removals, []);
    assert.deepEqual((await ff.browser.storage.sync.get(null))["tile:clock"], realLayout.clock);
    ff.calls.length = 0;
    await ff.browser.storage.sync.set({ "tile:clock": { ...realLayout.clock, y: 30 } }); await flush(ff);
    assert.deepEqual((await ff.browser.storage.sync.get(null))["tile:clock"], { ...realLayout.clock, y: 30 });
    assert.equal((await ff.browser.storage.sync.get(null))["tile:6:clock"], undefined);
    assert.deepEqual(shown(root), realLayout);
    assert.equal(writes(ff).length, 1, "only the simulated 3.1.1 write, no migration");
    assert.ok(node(root, "clock"));
  } finally { release(); }
});
test("Reset removes every layout and metadata in one remove, then recreates only visible current-width tiles", async () => {
  const { ff, control } = await setup(17, { "layout:17": { t: 2 }, "layout:34": { t: 1 }, ...widthEntries(34), ...widthEntries(17),
    "tile:clock": realLayout.clock,
    "tile:34:group:closed": { x: 0, y: 50, w: 7, h: 9 }, keep: 7 });
  await resetLayout(ff.browser); await flush(ff);
  const removal = ff.calls.find(c => c.api === "storage.sync.remove").args[0];
  assert.ok(removal.includes("layout:17") && removal.includes("layout:34") && removal.includes("tile:clock"));
  const stored = await ff.browser.storage.sync.get(null);
  assert.equal(stored.keep, 7); assert.deepEqual(Object.keys(stored).filter(key => key.startsWith("layout:")), ["layout:17"]);
  assert.equal(stored["tile:34:group:closed"], undefined); assert.equal(control.view.k, 17);
});
test("fifth layout eviction protects the source in use even when oldest and breaks ties by width", async () => {
  const { root, ff } = await setup(17, { "layout:34": { t: 0 }, "layout:35": { t: 1 }, "layout:36": { t: 1 }, "layout:37": { t: 2 },
    ...widthEntries(34), ...widthEntries(35), ...widthEntries(36), ...widthEntries(37) });
  await move(root, ff, "group:tbr", 0, 1);
  const stored = await ff.browser.storage.sync.get(null);
  assert.deepEqual(Object.keys(stored).filter(key => key.startsWith("layout:")).sort(), ["layout:17", "layout:34", "layout:36", "layout:37"]);
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

for (const [oldCols, newCols] of [[34, 17], [17, 34]]) {
  test(`3.1.1 at ${oldCols} coexists with 3.2 at ${newCols}, with bounded writes and independent edits`, async () => {
    const legacy = Object.fromEntries(Object.entries(realLayout).map(([id, r]) => [`tile:${id}`, r]));
    const { root, ff, control } = await setup(newCols, { ...legacy,
      "layout:17": { t: 2 }, "layout:34": { t: 1 }, "layout:20": { t: 3 }, "layout:28": { t: 4 },
      ...widthEntries(17, narrowLayout), ...widthEntries(34), ...widthEntries(20), ...widthEntries(28) });
    const oldRoot = document.createElement("div"); oldRoot.className = "board";
    oldRoot.style.cssText = `width:${(oldCols + 5) * 64 - 16}px;height:800px`; fixture().append(oldRoot);
    const oldUi = { dragging: false, editing: false, editGroupId: null };
    try {
      const old = createOldController(oldRoot, ff.browser, oldUi, { newGroupDelay: 10 });
      await old.refresh(); for (let i = 0; i < 5; i++) await flush(ff);
      assert.ok(writes(ff).length <= 1, "opening the old controller must not start a rewrite loop");
      assert.deepEqual(Object.fromEntries(Object.entries(await ff.browser.storage.sync.get(null))
        .filter(([key]) => key.startsWith("tile:34:"))), widthEntries(34));
      await move(root, ff, "group:tbr", 0, 1);
      const beforeOldEdit = await ff.browser.storage.sync.get(null);
      const perWidth = entries => Object.fromEntries(Object.entries(entries).filter(([key]) => /^tile:\d+:|^layout:/.test(key)));
      const newDisplay = shown(root);
      await move(oldRoot, ff, "group:tbr", 0, 1);
      for (let i = 0; i < 5; i++) await flush(ff);
      const after = await ff.browser.storage.sync.get(null);
      assert.deepEqual(perWidth(after), perWidth(beforeOldEdit), "3.1.1 edits cannot touch 3.2 layouts");
      assert.deepEqual(shown(root), newDisplay);
      assert.ok(after["tile:group:tbr"].y !== legacy["tile:group:tbr"].y, "the old gesture wrote its legacy arrangement");
      assert.equal(control.view.k, newCols);
      assert.ok(writes(ff).length <= 3, "only the two user edits and at most one migration");
      assert.equal(ff.calls.filter(c => c.api === "storage.sync.remove").length, 0);
    } finally { oldUi.dragging = true; control.ui.dragging = true; oldRoot.remove(); root.remove(); }
  }, { timeout: 15000 });
}

test("layouts 17 and 34 choose the width-filling source at every intermediate width and on rail changes", async () => {
  const { root, ff, control } = await setup(33, { "layout:17": { t: 2 }, "layout:34": { t: 1 },
    ...widthEntries(34), ...widthEntries(17, narrowLayout) });
  for (let c = 18; c <= 33; c++) {
    await resize(root, ff, c);
    assert.equal(control.view.k, c >= 24 ? 34 : 17, `columns ${c}`);
  }
  await ff.browser.storage.sync.set({ settings: { railCells: 15 } }); await flush(ff);
  assert.equal(control.view.cols, 23); assert.equal(control.view.k, 17);
  await ff.browser.storage.sync.set({ settings: { railCells: 14 } }); await flush(ff);
  assert.equal(control.view.cols, 24); assert.equal(control.view.k, 34);
  assert.equal(writes(ff).filter(write => Object.keys(write).some(key => key.startsWith("tile:") || key.startsWith("layout:"))).length, 0);
});
test("a new group's first-free source slot right of the window is saved in k columns", async () => {
  const source = Object.fromEntries(Object.entries(realLayout).map(([id, r], i) => [id,
    id === "clock" ? { x: 0, y: 0, w: 20, h: 10 } : { ...r, y: 20 + i * 10 }]));
  const { ff, folders } = await setup(17, { "layout:34": { t: 1 }, ...widthEntries(34, source) });
  const g = await ff.browser.tabs.group({ tabIds: [30] }); folders[g] = "new";
  ff.fire("bookmarks.onCreated", "new", { id: "new", type: "folder" }); await flush(ff);
  assert.deepEqual((await ff.browser.storage.sync.get(null))["tile:34:group:new"], { x: 20, y: 0, w: 5, h: 6 });
  assert.equal((await ff.browser.storage.sync.get(null))["tile:17:group:new"], undefined);
});
test("a held 17-column gesture keeps its target after widening to 34 before the first valid reply", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { root, ff, control } = await setup(17, undefined, gate, {}, []);
  try {
    await move(root, ff, "clock", 0, 1, true); assert.deepEqual(writes(ff), []);
    root.style.width = `${39 * 64 - 16}px`; window.dispatchEvent(new Event("resize"));
    for (let i = 0; i < 8; i++) await nextFrame(); assert.equal(control.view.k, 34);
    release(); await flush(ff);
    const stored = await ff.browser.storage.sync.get(null);
    assert.deepEqual(stored["tile:17:clock"], { x: 0, y: 1, w: 6, h: 4 });
    assert.deepEqual(Object.fromEntries(Object.entries(stored).filter(([key]) => key.startsWith("tile:34:"))), widthEntries(34));
    assert.equal(writes(ff).length, 1); assert.ok(writes(ff)[0]["layout:17"]);
  } finally { release(); }
});
// Hold only the new-group delay, so the source change can be tested without wall-clock races.
function groupTimers() {
  const delay = 123456, timers = new Map(), set = window.setTimeout, clear = window.clearTimeout;
  window.setTimeout = (callback, ms, ...args) => {
    const id = set(callback, ms, ...args); if (ms === delay) timers.set(id, () => callback(...args)); return id;
  };
  window.clearTimeout = id => { timers.delete(id); clear(id); };
  return { options: { newGroupDelay: delay }, timers,
    fire() { for (const [id, callback] of [...timers]) { window.clearTimeout(id); callback(); } },
    restore() { for (const id of timers.keys()) clear(id); window.setTimeout = set; window.clearTimeout = clear; },
  };
}
test("a two-page deferred new-group check restarts for the changed source layout", async () => {
  const timer = groupTimers(); let root, other;
  try {
    const result = await setup(17, { "layout:17": { t: 2 }, "layout:34": { t: 1 },
      ...widthEntries(17), ...widthEntries(34) }, undefined, timer.options);
    ({ root } = result); const { ff, folders, control } = result;
    other = document.createElement("div"); other.className = "board";
    other.style.cssText = `width:${39 * 64 - 16}px;height:800px`; fixture().append(other);
    const otherControl = createController(other, ff.browser, undefined, timer.options); await otherControl.refresh(); await flush(ff);
    const g = await ff.browser.tabs.group({ tabIds: [30] }); folders[g] = "new";
    ff.fire("bookmarks.onCreated", "new", { id: "new", type: "folder" }); await flush(ff);
    assert.equal(timer.timers.size, 2); const oldTimers = [...timer.timers.keys()];
    await resize(root, ff, 34); assert.equal(control.view.k, 34);
    assert.equal(timer.timers.size, 2); assert.equal(oldTimers.filter(id => timer.timers.has(id)).length, 1,
      "the 17-column page's timer was replaced; the other page's timer stayed");
    ff.calls.length = 0; timer.fire(); await flush(ff); await flush(ff);
    const checks = ff.calls.filter(c => c.api === "storage.sync.get" && typeof c.args[0] === "string" && c.args[0].endsWith(":group:new"));
    assert.ok(checks.length >= 1); assert.ok(checks.every(c => c.args[0] === "tile:34:group:new"));
    assert.equal((await ff.browser.storage.sync.get(null))["tile:17:group:new"], undefined);
    assert.ok((await ff.browser.storage.sync.get(null))["tile:34:group:new"]);
    control.ui.dragging = true; otherControl.ui.dragging = true;
  } finally { root?.remove(); other?.remove(); timer.restore(); }
});
test("a sync merge of six layouts evicts down to four without waiting for a user edit", async () => {
  const { ff, control } = await setup(34);
  await ff.browser.storage.local.set({ layoutsShown: { 34: Date.now(), 20: Date.now() } });
  await ff.browser.storage.sync.set(Object.fromEntries([10, 17, 20, 28, 30].flatMap((k, i) =>
    [[`layout:${k}`, { t: i + 1 }], ...Object.entries(widthEntries(k))]))); await flush(ff);
  const stored = await ff.browser.storage.sync.get(null);
  assert.equal(control.view.k, 34);
  assert.deepEqual(Object.keys(stored).filter(key => key.startsWith("layout:")).sort(), ["layout:20", "layout:28", "layout:30", "layout:34"]);
  assert.equal(writes(ff).length, 1, "only the simulated sync merge wrote tiles");
});

test("a 17-column gesture pushing unmapped groups writes their mapped ids to captured 17 after widening, never 34", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { root, ff } = await setup(17, undefined, gate);
  try {
    await move(root, ff, "clock", 0, 1, true);
    const released = shown(root);
    root.style.width = `${39 * 64 - 16}px`; window.dispatchEvent(new Event("resize"));
    for (let i = 0; i < 8; i++) await nextFrame();
    release(); await flush(ff);
    const stored = await ff.browser.storage.sync.get(null);
    assert.deepEqual(Object.fromEntries(Object.entries(stored).filter(([key]) => key.startsWith("tile:34:"))), widthEntries(34));
    for (const [id, rect] of Object.entries(released)) {
      const mapped = id.startsWith("local:") ? `group:${realFolders[id.slice(6)]}` : id;
      assert.deepEqual(stored[`tile:17:${mapped}`], rect, `captured visible rectangle ${mapped}`);
    }
    assert.equal(Object.keys(stored).filter(key => key.startsWith("tile:17:")).length, 8);
    assert.deepEqual(stored["tile:17:clock"], { x: 0, y: 1, w: 6, h: 4 });
    assert.deepEqual(stored["tile:17:group:oce"], { x: 0, y: 8, w: 5, h: 6 });
  } finally { release(); }
});
for (const ending of ["eviction", "Reset"]) {
  test(`pending local writes never recreate their captured target after ${ending}`, async () => {
    const timer = groupTimers(); let root, control;
    try {
      const result = await setup(17, undefined, undefined, timer.options);
      ({ root, control } = result); const { ff, folders } = result;
      const g = await ff.browser.tabs.group({ tabIds: [30] }); await flush(ff);
      await move(root, ff, "clock", 0, 1);
      assert.ok((await ff.browser.storage.sync.get(null))["layout:17"]);
      if (ending === "Reset") {
        await resetLayout(ff.browser);
        root.style.width = `${39 * 64 - 16}px`; window.dispatchEvent(new Event("resize"));
      } else {
        const stored = await ff.browser.storage.sync.get(null);
        await ff.browser.storage.sync.remove(Object.keys(stored).filter(key => key === "layout:17" || key.startsWith("tile:17:")));
      }
      await flush(ff);
      folders[g] = "new"; ff.calls.length = 0;
      ff.fire("bookmarks.onCreated", "new", { id: "new", type: "folder" }); await flush(ff);
      assert.equal(writes(ff).some(write => Object.keys(write).some(key => key.startsWith("tile:17:"))), false,
        "the old pending write must not recreate or overwrite layout 17");
      if (ending === "eviction") assert.equal((await ff.browser.storage.sync.get(null))["layout:17"], undefined);
    } finally { if (control) control.ui.dragging = true; root?.remove(); timer.restore(); }
  });
}

test("an evicted layout drops a held gesture before its first valid reply instead of recreating the target", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { root, ff, control } = await setup(17, { "layout:17": { t: 2 }, "layout:34": { t: 1 },
    ...widthEntries(17, narrowLayout), ...widthEntries(34) }, gate, {}, []);
  try {
    await move(root, ff, "clock", 0, 1, true);
    const stored = await ff.browser.storage.sync.get(null);
    await ff.browser.storage.sync.remove(Object.keys(stored).filter(key => key === "layout:17" || key.startsWith("tile:17:")));
    const settling = ff.settle();
    root.style.width = `${39 * 64 - 16}px`; window.dispatchEvent(new Event("resize"));
    for (let i = 0; i < 8; i++) await nextFrame();
    release(); await settling; await flush(ff);
    assert.equal(control.view.k, 34);
    assert.equal((await ff.browser.storage.sync.get(null))["layout:17"], undefined);
    assert.equal(writes(ff).some(write => Object.keys(write).some(key => key.startsWith("tile:17:"))), false);
    assert.deepEqual(Object.fromEntries(Object.entries(await ff.browser.storage.sync.get(null))
      .filter(([key]) => key.startsWith("tile:34:"))), widthEntries(34));
  } finally { release(); }
});

test("losing only a layout's metadata does not drop its pending placeholder write while tile keys survive", async () => {
  const timer = groupTimers(); let root, control;
  try {
    const result = await setup(17, { "layout:17": { t: 2 }, "layout:34": { t: 1 },
      ...widthEntries(17, narrowLayout), ...widthEntries(34) }, undefined, timer.options);
    ({ root, control } = result); const { ff, folders } = result;
    const g = await ff.browser.tabs.group({ tabIds: [30] }); await flush(ff);
    await move(root, ff, `local:${g}`, 0, 1);
    const released = rect(node(root, `local:${g}`));
    await ff.browser.storage.sync.remove("layout:17"); await flush(ff);
    folders[g] = "new"; ff.fire("bookmarks.onCreated", "new", { id: "new", type: "folder" }); await flush(ff);
    assert.deepEqual((await ff.browser.storage.sync.get(null))["tile:17:group:new"], released);
  } finally { if (control) control.ui.dragging = true; root?.remove(); timer.restore(); }
});
