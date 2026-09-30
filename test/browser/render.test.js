import { test, assert, fixture, nextFrame } from "./harness.js";
import { createFirefox } from "../fakes/firefox.js";
import { buildBoard } from "../../extension/src/board/model.js";

const setup = () => ({
  windows: [{ id: 1, focused: true }, { id: 2 }, { id: 3 }], selfTabId: 99,
  groups: [
    { id: 101, windowId: 1, title: "DEV SERVER", color: "red" },
    { id: 102, windowId: 1, title: "   ", color: "grey" },
    { id: 201, windowId: 2, title: "Research with a very long name that must never widen its column", color: "green" },
  ],
  tabs: [
    { id: 11, windowId: 1, pinned: true, title: "Pin" },
    { id: 12, windowId: 1, groupId: 101, title: "<b>Literal title</b>" },
    { id: 13, windowId: 1, groupId: 102, title: "Unnamed member" },
    { id: 14, windowId: 1, title: "Loose" },
    { id: 99, windowId: 1, url: location.origin + location.pathname, title: "Foxy" },
    { id: 21, windowId: 2, pinned: true, title: "Other pin", lastAccessed: 200 },
    { id: 22, windowId: 2, groupId: 201, title: "Other member" },
    { id: 23, windowId: 2, title: "Other loose" },
    { id: 24, windowId: 2, url: location.origin + location.pathname + "?another", title: "Other Foxy" },
    { id: 31, windowId: 3, pinned: true, title: "Third pin", lastAccessed: 100 },
    { id: 32, windowId: 3, title: "Third loose" },
  ],
});

let css;
async function root() {
  css ??= new Promise(resolve => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/extension/newtab.css";
    link.onload = resolve;
    document.head.append(link);
  });
  await css;
  await document.fonts.ready;
  const node = document.createElement("div");
  node.className = "board";
  node.style.width = "1600px";
  node.style.height = "600px";
  fixture().append(node);
  return node;
}
async function board(ff) {
  return buildBoard({ windows: await ff.browser.windows.getAll({ windowTypes: ["normal"] }),
    tabs: await ff.browser.tabs.query({}), groups: await ff.browser.tabGroups.query({}),
    currentWindowId: 1, selfTabId: 99, selfUrl: location.origin + location.pathname });
}
async function draw(handlers = {}) {
  const ff = createFirefox(setup());
  const node = await root();
  const { renderBoard } = await import("../../extension/src/board/render.js");
  renderBoard(node, await board(ff), { editGroupId: null }, handlers);
  return node;
}

// A renderer that drops, reorders or conflates current/remote columns fails these literal contracts.
test("board columns keep fixed edges and model group order", async () => {
  const node = await draw();
  assert.deepEqual([...node.querySelectorAll(".column")].map(el => el.dataset.zone ?? el.dataset.groupId),
    ["pinned", "101", "102", "201", "new-group", "tabs"]);
  assert.equal(node.firstElementChild.querySelector("h2").textContent, "PINNED");
  assert.equal(node.lastElementChild.querySelector("h2").textContent, "TABS");
  assert.equal(node.querySelector(".new-group .action").textContent, "+ NEW GROUP");
});

test("remote window sections have a subheading and space-only boundaries", async () => {
  const node = await draw();
  for (const zone of ["pinned", "tabs"]) {
    const rows = node.querySelector(`.rows[data-zone="${zone}"]`);
    assert.deepEqual([...rows.children].map(el => el.className), ["row", "subheading", "row", "window-gap", "row"]);
    assert.equal(rows.querySelector(".subheading").textContent, "OTHER WINDOWS");
    assert.ok(rows.querySelector(".window-gap").getBoundingClientRect().height >= 16);
  }
  assert.equal(node.querySelectorAll(".other-window").length, 1);
  assert.equal(node.querySelectorAll(".bring-here").length, 1);
  assert.equal(node.querySelector(".other-window").closest(".column").dataset.groupId, "201");
  assert.equal(node.querySelector(".other-window").textContent, "OTHER WINDOW");
});

test("rows expose drag identities, literal text and accessible close controls", async () => {
  const opened = [], closed = [], groupsClosed = [], brought = [];
  const node = await draw({ onOpen: row => opened.push(row.id), onCloseTab: id => closed.push(id),
    onCloseGroup: id => groupsClosed.push(id), onBringHere: id => brought.push(id) });
  const row = node.querySelector('[data-tab-id="12"]');
  assert.equal(row.dataset.windowId, "1");
  assert.equal(row.getAttribute("role"), "button");
  assert.equal(row.tabIndex, 0);
  assert.equal(row.draggable, true);
  assert.equal(row.querySelector(".row-label").textContent, "<b>Literal title</b>");
  assert.equal(row.querySelectorAll("b").length, 0);
  assert.equal(node.querySelectorAll('[data-tab-id="99"], [data-tab-id="24"]').length, 0);
  row.click();
  row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  row.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  row.querySelector(".row-close").click();
  node.querySelector('[data-group-id="101"] .column-close').click();
  node.querySelector(".bring-here").click();
  assert.deepEqual(opened, [12, 12, 12]);
  assert.deepEqual(closed, [12]);
  assert.deepEqual(groupsClosed, [101]);
  assert.deepEqual(brought, [201]);
});

test("unnamed and long groups retain 264px glass columns with hard scroll cuts", async () => {
  const node = await draw();
  const unnamed = node.querySelector('[data-group-id="102"] .group-name');
  assert.equal(unnamed.textContent, "UNNAMED");
  assert.ok(unnamed.classList.contains("unnamed"));
  for (const el of node.querySelectorAll(".column, .row")) {
    const style = getComputedStyle(el);
    assert.equal(style.borderTopWidth, "0px");
    assert.equal(style.outlineStyle, "none");
    assert.equal(style.boxShadow, "none");
    if (el.classList.contains("column")) assert.equal(el.offsetWidth, 264);
    else assert.equal(el.offsetHeight, 32);
  }
  const name = node.querySelector('[data-group-id="201"] .group-name');
  assert.equal(getComputedStyle(name).whiteSpace, "nowrap");
  assert.equal(getComputedStyle(name).textOverflow, "ellipsis");
  assert.ok(name.scrollWidth > name.clientWidth);
  for (const rows of node.querySelectorAll(".rows")) {
    assert.equal(getComputedStyle(rows).overflowY, "auto");
    assert.equal(getComputedStyle(rows).maskImage, "none");
    assert.equal(rows.tabIndex, -1);
  }
});

test("empty board still offers fixed columns and new group", async () => {
  const node = await root();
  const { renderBoard } = await import("../../extension/src/board/render.js");
  const ff = createFirefox({ tabs: [{ id: 99, windowId: 1 }] });
  renderBoard(node, await board(ff), { editGroupId: null }, {});
  assert.deepEqual([...node.querySelectorAll(".column")].map(el => el.dataset.zone), ["pinned", "new-group", "tabs"]);
});

async function controller(set = setup()) {
  const ff = createFirefox(set);
  const node = await root();
  const { createController } = await import("../../extension/src/main.js");
  const control = createController(node, ff.browser);
  await control.refresh();
  return { ff, node, control };
}
async function flush(ff) {
  await ff.settle();
  await nextFrame();
  await nextFrame();
}

test("controller batches remote tab, group, window and activation events per frame", async () => {
  const { ff, node } = await controller();
  ff.calls.length = 0;
  await ff.browser.tabs.update(23, { url: "https://example.com/updated" });
  await ff.browser.tabGroups.update(201, { title: "Remote renamed" });
  await ff.browser.windows.update(2, { focused: true });
  await ff.browser.tabs.update(23, { active: true });
  await flush(ff);
  assert.equal(node.querySelector('[data-tab-id="23"] .row-label').textContent, "https://example.com/updated");
  assert.equal(node.querySelector('[data-group-id="201"] .group-name').textContent, "Remote renamed");
  assert.equal(ff.calls.filter(call => call.api === "windows.getAll").length, 1);
});

test("controller retains horizontal and vertical scroll and focus through rebuild", async () => {
  const set = setup();
  for (let i = 0; i < 30; i++) set.tabs.push({ id: 1000 + i, windowId: 1, groupId: 101, title: `Tab ${i}` });
  const { ff, node, control } = await controller(set);
  node.style.width = "900px";
  const row = node.querySelector('[data-tab-id="1000"]');
  row.focus({ preventScroll: true });
  node.querySelector('.rows[data-group-id="101"]').scrollTop = 120;
  node.querySelector(".strip").scrollLeft = 90;
  await control.refresh();
  assert.equal(node.querySelector(".strip").scrollLeft, 90);
  assert.equal(node.querySelector('.rows[data-group-id="101"]').scrollTop, 120);
  assert.equal(document.activeElement.dataset.tabId, "1000");
  node.querySelector('[data-group-id="101"] .column-close').focus({ preventScroll: true });
  await control.refresh();
  assert.equal(document.activeElement.className, "column-close");
  await flush(ff);
});

test("controller holds updates during drag and edit including in-flight reads", async () => {
  const { ff, node, control } = await controller();
  const original = node.querySelector('[data-tab-id="23"]');
  let release;
  const query = ff.browser.tabs.query;
  ff.browser.tabs.query = async options => { const snapshot = await query(options); await new Promise(resolve => { release = resolve; }); return snapshot; };
  const reading = control.refresh();
  await Promise.resolve(); await Promise.resolve();
  control.handlers.onDragState(true);
  release();
  await reading;
  ff.browser.tabs.query = query;
  await ff.browser.tabs.update(23, { url: "https://example.com/after-drag" });
  await flush(ff);
  assert.equal(node.querySelector('[data-tab-id="23"]'), original);
  ff.calls.length = 0;
  control.handlers.onDragState(false);
  await flush(ff);
  assert.equal(node.querySelector('[data-tab-id="23"] .row-label').textContent, "https://example.com/after-drag");
  assert.equal(ff.calls.filter(call => call.api === "windows.getAll").length, 1);
  const editing = node.querySelector('[data-tab-id="23"]');
  control.handlers.onEditState(true);
  await ff.browser.tabs.update(23, { url: "https://example.com/after-edit" });
  await flush(ff);
  assert.equal(node.querySelector('[data-tab-id="23"]'), editing);
  control.handlers.onEditEnd();
  await flush(ff);
  assert.equal(node.querySelector('[data-tab-id="23"] .row-label').textContent, "https://example.com/after-edit");
});

test("controller ignores an older snapshot after a newer refresh finishes", async () => {
  const { ff, node, control } = await controller();
  const query = ff.browser.tabs.query;
  let release;
  let first = true;
  ff.browser.tabs.query = async options => {
    const snapshot = await query(options);
    if (first) { first = false; await new Promise(resolve => { release = resolve; }); }
    return snapshot;
  };
  const older = control.refresh();
  await Promise.resolve(); await Promise.resolve();
  await ff.browser.tabs.update(23, { url: "https://example.com/newest" });
  await control.refresh();
  release(); await older;
  assert.equal(node.querySelector('[data-tab-id="23"] .row-label').textContent, "https://example.com/newest");
  ff.browser.tabs.query = query;
  await flush(ff);
});

test("controller routes drops through target resolvers and requests a new group's editor", async () => {
  const { ff, node, control } = await controller();
  await control.handlers.onTabDrop(14, { zone: "group", groupId: 101, slot: 1 });
  assert.equal(node.querySelector('[data-group-id="101"] [data-tab-id="14"]').dataset.windowId, "1");
  await control.handlers.onTabDrop(23, { zone: "new-group" });
  assert.ok(control.ui.editGroupId != null);
  assert.ok(node.querySelector(`.column[data-group-id="${control.ui.editGroupId}"] [data-tab-id="23"]`));
  control.handlers.onEditEnd();
  await control.handlers.onGroupDrop(201, 0);
  assert.equal((await ff.browser.tabGroups.get(201)).windowId, 1);
  await flush(ff);
});

test("controller catches failed reads, logs Foxy and re-reads once", async () => {
  const ff = createFirefox(setup());
  const node = await root();
  const { createController } = await import("../../extension/src/main.js");
  const control = createController(node, ff.browser);
  const query = ff.browser.tabs.query;
  let first = true;
  ff.browser.tabs.query = async options => {
    if (first) { first = false; throw new Error("Read interrupted"); }
    return query(options);
  };
  const warnings = [], warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await control.refresh();
    await flush(ff);
    assert.ok(warnings.some(args => args[0].startsWith("Foxy:")));
    assert.ok(node.querySelector('[data-tab-id="23"]'));
  } finally { console.warn = warn; }
});


test("a short interaction invalidates an in-flight read and schedules its replacement", async () => {
  const { ff, node, control } = await controller();
  const query = ff.browser.tabs.query;
  let release;
  let first = true;
  ff.browser.tabs.query = async options => {
    const snapshot = await query(options);
    if (first) { first = false; await new Promise(resolve => { release = resolve; }); }
    return snapshot;
  };
  const old = node.querySelector('[data-tab-id="23"]');
  const reading = control.refresh();
  await Promise.resolve(); await Promise.resolve();
  control.handlers.onEditState(true);
  control.handlers.onEditEnd();
  release(); await reading;
  await nextFrame(); await nextFrame();
  assert.ok(node.querySelector('[data-tab-id="23"]') !== old, "invalidated read needs a replacement even without events");
  ff.browser.tabs.query = query;
});

test("missing and broken favicons use the globe at the same 16px size", async () => {
  const node = await draw();
  const globe = node.querySelector('[data-tab-id="12"] .icon');
  assert.ok(globe.classList.contains("icon-none"));
  assert.equal(globe.offsetWidth, 16);
  const ff = createFirefox(setup());
  const model = await board(ff);
  model.columns[0].rows[0].icon = "data:image/png;base64,AAAA";
  const { renderBoard } = await import("../../extension/src/board/render.js");
  renderBoard(node, model, { editGroupId: null }, {});
  const image = node.querySelector('[data-tab-id="12"] img');
  await new Promise(resolve => image.addEventListener("error", resolve, { once: true }));
  assert.ok(node.querySelector('[data-tab-id="12"] .icon-none'));
});

test("stale row actions warn and re-read instead of throwing or closing the page", async () => {
  const { ff, node, control } = await controller();
  await ff.browser.tabs.remove(23);
  const warnings = [], warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await control.handlers.onOpen({ id: 23, windowId: 2 });
    assert.ok(warnings.some(args => args[0].startsWith("Foxy:")));
    assert.equal(node.querySelector('[data-tab-id="23"]'), null);
    assert.ok(await ff.browser.tabs.get(99));
    assert.equal(ff.calls.filter(call => call.api === "runtime.sendMessage").length, 0);
  } finally { console.warn = warn; }
  await flush(ff);
});


test("fixed and scrolling columns share the same top and bottom edges", async () => {
  const node = await draw();
  const fixed = node.querySelector(".fixed").getBoundingClientRect();
  for (const column of node.querySelectorAll(".column")) {
    const bounds = column.getBoundingClientRect();
    assert.equal(bounds.top, fixed.top);
    assert.equal(bounds.bottom, fixed.bottom);
  }
});


test("onOpen closes only a history-free page and activates remote tabs and following pins", async () => {
  // Isolate history in a same-origin iframe; no global history entries survive the test.
  const frame = document.createElement("iframe");
  frame.srcdoc = '<div class="board"></div>';
  const loaded = new Promise(resolve => frame.addEventListener("load", resolve, { once: true }));
  fixture().append(frame);
  await loaded;
  try {
    const win = frame.contentWindow;
    const { createController } = await win.eval("import('/extension/src/main.js')");
    const ff = createFirefox(setup());
    const control = createController(frame.contentDocument.querySelector(".board"), ff.browser);
    await control.refresh();
    assert.equal(win.history.length, 1);
    await control.handlers.onOpen({ id: 23, windowId: 2 });
    assert.equal((await ff.browser.tabs.get(23)).active, true);
    assert.equal((await ff.browser.windows.getAll({})).find(win => win.id === 2).focused, true);
    assert.equal(ff.calls.filter(call => call.api === "runtime.sendMessage").length, 1);
    win.history.pushState(null, "");
    ff.calls.length = 0;
    await control.handlers.onOpen({ id: 21, windowId: 2, pinned: true });
    const pin = await ff.browser.tabs.get(21);
    assert.equal(pin.windowId, 1);
    assert.equal(pin.active, true);
    assert.equal(pin.pinned, true);
    assert.equal(ff.calls.filter(call => call.api === "runtime.sendMessage").length, 0);
    assert.ok(await ff.browser.tabs.get(99));
    await ff.settle();
    await new Promise(resolve => win.requestAnimationFrame(resolve));
    await new Promise(resolve => win.requestAnimationFrame(resolve));
  } finally { frame.remove(); }
});


test("generic button interaction fills do not erase the group-dot colour", async () => {
  const node = await draw();
  const dot = node.querySelector(".dot");
  // Synthetic key events cannot set Firefox's trusted focus-visible state.
  // Substitute an equal-specificity class in the actual rule, not a mock fill,
  // so the real stylesheet, source order and Firefox cascade are exercised.
  const sheet = [...document.styleSheets].find(sheet => sheet.href?.endsWith("/extension/newtab.css"));
  const rule = [...sheet.cssRules].find(rule => rule.selectorText?.includes("button:focus-visible"));
  const selector = rule.selectorText;
  try {
    assert.ok(getComputedStyle(dot).backgroundImage.includes("gradient"));
    rule.selectorText = selector.replace("button:focus-visible", "button.focus-test");
    dot.classList.add("focus-test");
    assert.ok(getComputedStyle(dot).backgroundImage.includes("gradient"), "generic focus fill must not erase the group colour");
  } finally { rule.selectorText = selector; }
});
