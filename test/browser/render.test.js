import { test, assert, fixture, nextFrame, withPseudoState } from "./harness.js";
import { createBoardFirefox as createFirefox } from "./controller.js";
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
  const { renderBoard } = await import("./view.js");
  renderBoard(node, await board(ff), { editGroupId: null }, handlers);
  return node;
}

// A renderer that drops, reorders or conflates current/remote columns fails these literal contracts.
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
  assert.equal(row.getAttribute("role"), null);
  assert.equal(row.querySelector(".row-open").tabIndex, 0);
  assert.equal(row.querySelector(".row-close").tabIndex, 0);
  assert.equal(row.tabIndex, -1);
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
  assert.deepEqual(opened, [12], "the noninteractive row wrapper must ignore keydown; native buttons supply activation clicks");
  assert.deepEqual(closed, [12]);
  assert.deepEqual(groupsClosed, [101]);
  assert.deepEqual(brought, [201]);
});

test("close, bring, rename and colour labels identify their tab or group", async () => {
  const node = await draw();
  assert.equal(node.querySelector('[data-tab-id="12"] .row-close').getAttribute("aria-label"), "Close tab: <b>Literal title</b>");
  const named = node.querySelector('[data-group-id="101"]');
  assert.equal(named.querySelector(".column-close").getAttribute("aria-label"), "Close group: DEV SERVER");
  assert.equal(named.querySelector(".group-name").getAttribute("aria-label"), "Rename DEV SERVER");
  assert.equal(named.querySelector(".dot").getAttribute("aria-label"), "Colour of DEV SERVER");
  const unnamed = node.querySelector('[data-group-id="102"]');
  assert.equal(unnamed.querySelector(".column-close").getAttribute("aria-label"), "Close group: Unnamed");
  assert.equal(unnamed.querySelector(".group-name").getAttribute("aria-label"), "Rename Unnamed");
  assert.equal(unnamed.querySelector(".dot").getAttribute("aria-label"), "Colour of Unnamed");
  assert.equal(node.querySelector(".bring-here").getAttribute("aria-label"),
    "Bring Research with a very long name that must never widen its column here");
});

// Too little alpha separation makes UNNAMED look named; too little contrast
// makes it unreadable against the composited neutral card.
for (const scheme of ["light", "dark"]) {
  test(`UNNAMED is clearly fainter but retains at least 3:1 contrast in ${scheme}`, async () => {
    const node = await draw(); node.style.colorScheme = scheme;
    const unnamed = node.querySelector(".unnamed"), named = node.querySelector('[data-group-id="101"] .group-name');
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d");
    const rgba = color => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    const alpha = element => rgba(getComputedStyle(element).color)[3] / 255;
    assert.ok(alpha(named) - alpha(unnamed) >= 0.1, "UNNAMED needs a clearly lower alpha than named titles");
    ctx.fillStyle = scheme === "light" ? "white" : "black"; ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = getComputedStyle(unnamed.closest(".column")).backgroundColor; ctx.fillRect(0, 0, 1, 1);
    const card = [...ctx.getImageData(0, 0, 1, 1).data];
    ctx.fillStyle = getComputedStyle(unnamed).color; ctx.fillRect(0, 0, 1, 1);
    const text = [...ctx.getImageData(0, 0, 1, 1).data];
    const luminance = rgb => rgb.slice(0, 3).map(c => c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
    const a = luminance(card), b = luminance(text);
    const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    assert.ok(contrast >= 3, `UNNAMED contrast must be at least 3:1, got ${contrast}`);
  });
}

test("unnamed and long groups retain cell-sized glass tiles without masking short lists", async () => {
  const node = await draw();
  const unnamed = node.querySelector('[data-group-id="102"] .group-name');
  assert.equal(unnamed.textContent, "UNNAMED");
  assert.ok(unnamed.classList.contains("unnamed"));
  for (const el of node.querySelectorAll(".column, .row")) {
    const style = getComputedStyle(el);
    assert.equal(style.borderTopWidth, "0px");
    assert.equal(style.outlineStyle, "none");
    assert.equal(style.boxShadow, "none");
    if (el.classList.contains("column")) assert.equal(el.offsetWidth, 272);
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

// Generic button fills must not create a second surface inside the row/header.
for (const state of ["hover", "active", "focus-visible"]) {
  for (const kind of ["row", "group name"]) {
    test(`${kind} ${state} paints only its containing surface`, async () => {
      const node = await draw(); node.style.colorScheme = "dark";
      const button = node.querySelector(kind === "row" ? ".row-open" : ".group-name");
      const container = button.parentElement;
      const elements = state === "hover" ? [button, container] : [button];
      withPseudoState(elements, state, () => {
        const style = getComputedStyle(container);
        for (const corner of ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"]) {
          assert.equal(style[corner], "8px", "interaction fills need the same rounded corners as rows");
        }
        assert.equal(getComputedStyle(button).backgroundColor, "rgba(0, 0, 0, 0)", "the inner button must stay transparent");
        assert.equal(getComputedStyle(container).backgroundColor,
          state === "hover" ? "rgba(255, 255, 255, 0.08)" : "rgba(255, 255, 255, 0.12)");
      });
    });
  }
}

test("controller owns saved confirmation and serializes busy folder IDs in its render key", async () => {
  const { ff, node, control } = await controller();
  assert.equal(control.ui.confirmFolderId, null);
  assert.ok(control.ui.busy instanceof Set);
  const rebuilds = countRebuilds(node);
  control.handlers.onConfirmDelete("f1");
  assert.equal(control.ui.confirmFolderId, "f1");
  assert.equal(rebuilds(), 1);
  await control.refresh();
  assert.equal(rebuilds(), 1, "unchanged confirmation must skip a rebuild");
  control.ui.busy.add("f1"); await control.refresh();
  assert.equal(rebuilds(), 2, "Set membership must invalidate the render key");
  control.ui.busy.add("banner"); await control.refresh();
  assert.equal(rebuilds(), 3);
  control.ui.busy.delete("f1"); await control.refresh();
  assert.equal(rebuilds(), 4);
  control.handlers.onConfirmDelete(null);
  assert.equal(control.ui.confirmFolderId, null); assert.equal(rebuilds(), 5);
  assert.equal(ff.calls.some(call => call.api === "runtime.sendMessage" && call.args[0].type === "blank-and-close"), false,
    "confirmation must never send the page-close message");
});

for (const hold of ["drag", "edit", "action"]) {
  test(`saved confirmation plumbing preserves the ${hold} hold and refreshes once on release`, async () => {
    const { ff, node, control } = await controller();
    const rebuilds = countRebuilds(node);
    let release, running;
    if (hold === "drag") control.handlers.onDragState(true);
    else if (hold === "edit") control.handlers.onEditState(true);
    else {
      const update = ff.browser.tabGroups.update;
      ff.browser.tabGroups.update = async (...args) => {
        await new Promise(resolve => { release = resolve; });
        return update(...args);
      };
      running = control.handlers.onRename(101, "Action rename");
    }
    control.handlers.onConfirmDelete("f1");
    assert.equal(control.ui.confirmFolderId, "f1"); assert.equal(rebuilds(), 0);
    await ff.browser.tabs.update(23, { url: `https://example.com/${hold}-confirm` });
    await flush(ff);
    assert.equal(rebuilds(), 0);
    if (hold === "drag") control.handlers.onDragState(false);
    else if (hold === "edit") control.handlers.onEditEnd();
    else { release(); await running; }
    await flush(ff);
    assert.equal(rebuilds(), 1);
    assert.equal(control.ui.confirmFolderId, "f1");
  });
}

// The shared fake does not implement Firefox's optional onUpdated filter.
// Preserve its queued delivery, adding only the filter at this API boundary.
function filteredTabUpdates(ff) {
  const event = ff.browser.tabs.onUpdated;
  const add = event.addListener;
  event.addListener = (listener, filter) => add((id, changes, tab) => {
    if (!filter?.properties || filter.properties.some(key => key in changes)) listener(id, changes, tab);
  });
}

async function controller(set = setup()) {
  const ff = createFirefox(set);
  filteredTabUpdates(ff);
  const node = await root();
  const { createController } = await import("../../extension/src/main.js");
  const control = createController(node, ff.browser);
  await control.refresh();
  await flush(ff); // Drain the one-time reconcile completion before interaction assertions.
  return { ff, node, control };
}
async function flush(ff) {
  await ff.settle();
  await nextFrame();
  await nextFrame();
}

function countRebuilds(node) {
  let count = 0;
  const replace = node.replaceChildren.bind(node);
  node.replaceChildren = (...children) => { count++; replace(...children); };
  return () => count;
}

test("review important 1: status-only tab update bursts do not read or redraw", async () => {
  const { ff, node } = await controller();
  const rebuilds = countRebuilds(node);
  ff.calls.length = 0;
  for (let i = 0; i < 30; i++) ff.fire("tabs.onUpdated", 23, { status: i % 2 ? "complete" : "loading" });
  await flush(ff);
  assert.equal(rebuilds(), 0, "status updates must not rebuild the board");
  assert.equal(ff.calls.filter(call => call.api === "windows.getAll").length, 0, "filtered events must not read");
});

test("review important 1: unchanged board events keep existing row nodes", async () => {
  const { ff, node } = await controller();
  const row = node.querySelector('[data-tab-id="23"]');
  const rebuilds = countRebuilds(node);
  ff.fire("tabs.onMoved", 23, { windowId: 2, fromIndex: 3, toIndex: 3 });
  await flush(ff);
  assert.equal(node.querySelector('[data-tab-id="23"]'), row, "an identical model must retain node identity");
  assert.equal(rebuilds(), 0);
});

test("review important 1: unsupported update filter falls back and keeps irrelevant nodes", async () => {
  const ff = createFirefox(setup());
  const event = ff.browser.tabs.onUpdated, add = event.addListener;
  let rejectedFilter;
  event.addListener = (listener, filter) => {
    if (filter) { rejectedFilter = filter; throw new Error("Filter unavailable"); }
    add(listener);
  };
  const node = await root();
  const { createController } = await import("../../extension/src/main.js");
  const warnings = [], warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const control = createController(node, ff.browser);
    await control.refresh();
    await flush(ff);
    assert.deepEqual(rejectedFilter, { properties: ["favIconUrl", "groupId", "hidden", "pinned", "title", "url"] });
    assert.ok(warnings.some(args => args[0].startsWith("Foxy:")));
    await ff.browser.tabs.update(23, { url: "https://example.com/unfiltered" });
    await flush(ff);
    const row = node.querySelector('[data-tab-id="23"]');
    assert.equal(row.querySelector(".row-label").textContent, "https://example.com/unfiltered");
    const rebuilds = countRebuilds(node);
    for (let i = 0; i < 30; i++) ff.fire("tabs.onUpdated", 23, { status: "loading", audible: true });
    await flush(ff);
    assert.equal(rebuilds(), 0);
    assert.equal(node.querySelector('[data-tab-id="23"]'), row);
  } finally { console.warn = warn; }
});

test("review important 1: failed fallback registration is caught, logged and re-read", async () => {
  const ff = createFirefox(setup());
  ff.browser.tabs.onUpdated.addListener = () => { throw new Error("Event unavailable"); };
  const node = await root();
  const { createController } = await import("../../extension/src/main.js");
  const warnings = [], warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    createController(node, ff.browser);
    await flush(ff);
    assert.ok(warnings.length >= 2);
    assert.ok(warnings.every(args => args[0].startsWith("Foxy:")));
    assert.ok(node.querySelector('[data-tab-id="23"]'), "re-read after subscription failure");
  } finally { console.warn = warn; }
});

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

test("controller retains grid and row scroll and focus through rebuild", async () => {
  const set = setup();
  for (let i = 0; i < 30; i++) set.tabs.push({ id: 1000 + i, windowId: 1, groupId: 101, title: `Tab ${i}` });
  const { ff, node, control } = await controller(set);
  node.style.width = "900px";
  const row = node.querySelector('[data-tab-id="1000"]');
  row.focus({ preventScroll: true });
  node.querySelector('.rows[data-group-id="101"]').scrollTop = 120;
  node.querySelector(".grid").scrollTop = 90;
  await ff.browser.tabGroups.update(201, { title: "Rebuild while a row is focused" });
  await control.refresh();
  assert.ok(node.querySelector('[data-tab-id="1000"]') !== row, "exercise a real rebuild");
  assert.equal(node.querySelector(".grid").scrollTop, 90);
  assert.equal(node.querySelector('.rows[data-group-id="101"]').scrollTop, 120);
  assert.equal(node.querySelector(".grid").hasAttribute("data-scroll-start"), true, "fade must reflect restored scroll before the next event");
  assert.equal(node.querySelector('.rows[data-group-id="101"]').hasAttribute("data-scroll-start"), true);
  assert.equal(document.activeElement.dataset.tabId, "1000");
  const close = node.querySelector('[data-group-id="101"] .column-close');
  close.focus({ preventScroll: true });
  await ff.browser.tabGroups.update(201, { title: "Rebuild while a group control is focused" });
  await control.refresh();
  assert.ok(node.querySelector('[data-group-id="101"] .column-close') !== close);
  assert.equal(document.activeElement.className, "column-close");
  await flush(ff);
});

test("review important 2: multi-step drop renders once after dragend and completion", async () => {
  const { ff, node, control } = await controller();
  const rebuilds = countRebuilds(node);
  const intermediate = [];
  const move = ff.browser.tabs.move, group = ff.browser.tabs.group;
  for (const [name, api] of [["move", move], ["group", group]]) {
    ff.browser.tabs[name] = async (...args) => {
      const result = await api(...args);
      await flush(ff);
      intermediate.push(rebuilds());
      return result;
    };
  }
  control.handlers.onDragState(true);
  const dropping = control.handlers.onTabDrop(21, { zone: "group", groupId: 101, slot: 0 });
  control.handlers.onDragState(false);
  try {
    await dropping;
    await flush(ff);
    assert.ok(intermediate.length >= 2, "exercise separate adoption and grouping calls");
    assert.ok(intermediate.every(count => count === 0), `intermediate rebuilds: ${intermediate}`);
    assert.equal(rebuilds(), 1, "only the final board should render");
    assert.ok(node.querySelector('.column[data-group-id="101"] [data-tab-id="21"]'));
  } finally { ff.browser.tabs.move = move; ff.browser.tabs.group = group; }
});

test("review important 2: overlapping actions remain held until the last action settles", async () => {
  const { ff, node, control } = await controller();
  const rebuilds = countRebuilds(node);
  const update = ff.browser.tabGroups.update;
  let release;
  ff.browser.tabGroups.update = async (...args) => {
    const result = await update(...args);
    await new Promise(resolve => { release = resolve; });
    return result;
  };
  const renaming = control.handlers.onRename(101, "Changed while held");
  await Promise.resolve(); await Promise.resolve();
  try {
    await control.handlers.onCloseTab(14);
    await flush(ff);
    assert.equal(rebuilds(), 0, "the shorter action must not release the longer one");
  } finally { release(); await renaming; ff.browser.tabGroups.update = update; }
  await flush(ff);
  assert.equal(rebuilds(), 1);
  assert.equal(node.querySelector('[data-tab-id="14"]'), null);
  assert.equal(node.querySelector('[data-group-id="101"] .group-name').textContent, "Changed while held");
});

for (const [tabId, nextId, child] of [[23, 32, false], [32, 23, false], [11, 21, true], [12, 15, false]]) {
  test(`review minor 3: disappearing row ${tabId} focuses its zone neighbour ${nextId}`, async () => {
    const set = setup();
    set.tabs.splice(2, 0, { id: 15, windowId: 1, groupId: 101, title: "Next group member" });
    for (const tab of set.tabs) tab.lastAccessed = 1000 / tab.windowId;
    const { ff, node } = await controller(set);
    const row = node.querySelector(`[data-tab-id="${tabId}"]`);
    const target = child ? row.querySelector(".row-close") : row;
    target.focus({ preventScroll: true });
    assert.equal(document.activeElement, target, "focus the original row/control before removal");
    await ff.browser.tabs.remove(tabId);
    await flush(ff);
    assert.equal(document.activeElement, node.querySelector(`[data-tab-id="${nextId}"] .row-open`),
      `focus the same-zone neighbour; active=${document.activeElement.className}:${document.activeElement.dataset.tabId}`);
  });
}

for (const selector of [".grid", '.fixed .rows[data-zone="pinned"]', '.fixed .rows[data-zone="tabs"]']) {
  test(`review minor 3: focused scroll container ${selector} survives a rebuild`, async () => {
    const { ff, node } = await controller();
    const original = node.querySelector(selector);
    original.focus({ preventScroll: true });
    assert.equal(document.activeElement, original);
    await ff.browser.tabGroups.update(201, { title: "Force a real rebuild" });
    await flush(ff);
    assert.ok(node.querySelector(selector) !== original);
    assert.equal(document.activeElement, node.querySelector(selector), "restore the focused scroll container");
  });
}

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

test("review round 2: a favicon event during an in-flight read gets a second read", async () => {
  const { ff, node } = await controller();
  const query = ff.browser.tabs.query;
  const icon = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6" fill="gray"/></svg>';
  let currentIcon;
  let release, markStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  let first = true;
  ff.browser.tabs.query = async options => {
    const snapshot = await query(options);
    // The fake has no favicon-write API. Keep its real tab snapshot and events,
    // supplying only this browser-owned field at the query boundary.
    snapshot.find(tab => tab.id === 23).favIconUrl = currentIcon;
    if (first) { first = false; markStarted(); await gate; }
    return snapshot;
  };
  ff.calls.length = 0;
  try {
    await ff.browser.tabs.update(23, { url: "https://example.com/title-before-icon" });
    await ff.settle();
    await started;
    currentIcon = icon;
    ff.fire("tabs.onUpdated", 23, { favIconUrl: icon });
    await ff.settle();
    // Resolve the old read before the favicon event's queued frame executes.
    release();
    await flush(ff);
    assert.equal(ff.calls.filter(call => call.api === "windows.getAll").length, 2,
      "the event delivered during a read must trigger a second read");
    assert.equal(node.querySelector('[data-tab-id="23"] img')?.getAttribute("src"), icon,
      "the second read must draw the newest favicon");
  } finally { release(); ff.browser.tabs.query = query; await flush(ff); }
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

  await flush(ff);
});

test("review important 3: new-group edit ID holds refreshes until onEditEnd", async () => {
  const { ff, node, control } = await controller();
  await control.handlers.onTabDrop(23, { zone: "new-group" });
  await flush(ff);
  assert.ok(control.ui.editGroupId != null);
  assert.ok(node.querySelector(`.column[data-group-id="${control.ui.editGroupId}"]`), "introduce the new column before holding its editor");
  const row = node.querySelector('[data-tab-id="14"]');
  const rebuilds = countRebuilds(node);
  ff.calls.length = 0;
  await ff.browser.tabs.update(14, { url: "https://example.com/during-new-group-edit" });
  await flush(ff);
  await control.refresh();
  assert.equal(node.querySelector('[data-tab-id="14"]'), row, "editGroupId alone must preserve the editor DOM");
  assert.equal(rebuilds(), 0);
  assert.equal(ff.calls.filter(call => call.api === "windows.getAll").length, 0);
  control.handlers.onEditState(true);
  control.handlers.onEditEnd();
  await flush(ff);
  assert.equal(control.ui.editGroupId, null);
  assert.equal(control.ui.editing, false);
  assert.equal(rebuilds(), 1, "release coalesced editor updates once");
  assert.equal(node.querySelector('[data-tab-id="14"] .row-label').textContent, "https://example.com/during-new-group-edit");
});

test("review round 2: a group gone before the final drop read never holds an editor", async () => {
  const { ff, node, control } = await controller();
  const group = ff.browser.tabs.group;
  let vanishedId;
  ff.browser.tabs.group = async options => {
    vanishedId = await group(options);
    // Another browser action removes the new group before the drop returns.
    await ff.browser.tabs.ungroup(options.tabIds);
    return vanishedId;
  };
  try {
    const result = await control.handlers.onTabDrop(23, { zone: "new-group" });
    await flush(ff);
    assert.equal(result.ok, true);
    assert.equal(node.querySelector(`.column[data-group-id="${vanishedId}"]`), null);
    assert.equal(control.ui.editGroupId, null, "a missing column must not publish an editor ID");
    const rebuilds = countRebuilds(node);
    ff.calls.length = 0;
    await ff.browser.tabs.update(14, { url: "https://example.com/no-vanished-editor" });
    await flush(ff);
    assert.equal(rebuilds(), 1, "later changes must not be held by the vanished editor");
    assert.equal(ff.calls.filter(call => call.api === "windows.getAll").length, 1);
    assert.equal(node.querySelector('[data-tab-id="14"] .row-label').textContent,
      "https://example.com/no-vanished-editor");
  } finally { ff.browser.tabs.group = group; await flush(ff); }
});

test("review round 2: removing the edited group clears both edit holds and refreshes once", async () => {
  const { ff, node, control } = await controller();
  await control.handlers.onTabDrop(23, { zone: "new-group" });
  await flush(ff);
  const editId = control.ui.editGroupId;
  assert.ok(node.querySelector(`.column[data-group-id="${editId}"]`));
  control.handlers.onEditState(true);
  const row = node.querySelector('[data-tab-id="14"]');
  const rebuilds = countRebuilds(node);
  await ff.browser.tabs.ungroup(13); // A different group's removal must not end this editor.
  await flush(ff);
  assert.equal(control.ui.editGroupId, editId);
  assert.equal(control.ui.editing, true);
  assert.equal(node.querySelector('[data-tab-id="14"]'), row);
  assert.equal(rebuilds(), 0);
  ff.calls.length = 0;
  await ff.browser.tabs.ungroup(23);
  await ff.browser.tabs.update(14, { url: "https://example.com/edited-group-removed" });
  await flush(ff);
  assert.equal(control.ui.editGroupId, null, "the removed group's editor must release its ID hold");
  assert.equal(control.ui.editing, false, "the removed group's active editor must also end");
  assert.equal(node.querySelector(`.column[data-group-id="${editId}"]`), null);
  assert.ok(node.querySelector('.rows[data-zone="tabs"] [data-tab-id="23"]'));
  assert.equal(node.querySelector('[data-tab-id="14"] .row-label').textContent,
    "https://example.com/edited-group-removed");
  assert.equal(rebuilds(), 1, "coalesce removal and pending changes into one rebuild");
  assert.equal(ff.calls.filter(call => call.api === "windows.getAll").length, 1);
});

for (const dragging of [false, true]) {
  test(`review round 2: tab events release a missing edited group without a group removal signal${dragging ? " after dragend" : ""}`, async () => {
    const ff = createFirefox(setup());
    filteredTabUpdates(ff);
    // Exercise a browser that delivers only the tab events for this removal.
    ff.browser.tabGroups.onRemoved.addListener = () => {};
    const node = await root();
    const { createController } = await import("../../extension/src/main.js");
    const control = createController(node, ff.browser);
    await control.refresh();
    await control.handlers.onTabDrop(23, { zone: "new-group" });
    await flush(ff);
    const editId = control.ui.editGroupId;
    assert.ok(node.querySelector(`.column[data-group-id="${editId}"]`));
    control.handlers.onEditState(true);
    const rebuilds = countRebuilds(node);
    ff.calls.length = 0;
    if (dragging) control.handlers.onDragState(true);
    await ff.browser.tabs.ungroup(23);
    await ff.browser.tabs.update(14, { url: "https://example.com/tab-only-group-removal" });
    await flush(ff);
    if (dragging) {
      assert.equal(control.ui.editGroupId, editId, "even existence checks must wait for dragend");
      assert.equal(rebuilds(), 0);
      assert.equal(ff.calls.filter(call => call.api === "tabGroups.query").length, 0);
      control.handlers.onDragState(false);
      await flush(ff);
    }
    assert.equal(control.ui.editGroupId, null, "the next read attempt must detect the missing edited group");
    assert.equal(control.ui.editing, false);
    assert.equal(node.querySelector(`.column[data-group-id="${editId}"]`), null);
    assert.equal(node.querySelector('[data-tab-id="14"] .row-label').textContent,
      "https://example.com/tab-only-group-removal");
    assert.equal(rebuilds(), 1);
    assert.equal(ff.calls.filter(call => call.api === "windows.getAll").length, 1,
      "existence checks must not produce an intermediate board read");
  });
}

test("review round 2: failed group-removal registration is logged and tab events still release the editor", async () => {
  const ff = createFirefox(setup());
  filteredTabUpdates(ff);
  ff.browser.tabGroups.onRemoved.addListener = () => { throw new Error("Removal event unavailable"); };
  const node = await root();
  const { createController } = await import("../../extension/src/main.js");
  const warnings = [], warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const control = createController(node, ff.browser);
    await flush(ff);
    assert.ok(warnings.some(args => args[0].startsWith("Foxy:")));
    assert.ok(node.querySelector('[data-tab-id="23"]'), "subscription failure must still schedule a read");
    await control.handlers.onTabDrop(23, { zone: "new-group" });
    await flush(ff);
    const editId = control.ui.editGroupId;
    assert.ok(node.querySelector(`.column[data-group-id="${editId}"]`));
    const rebuilds = countRebuilds(node);
    ff.calls.length = 0;
    await ff.browser.tabs.ungroup(23);
    await flush(ff);
    assert.equal(control.ui.editGroupId, null);
    assert.equal(node.querySelector(`.column[data-group-id="${editId}"]`), null);
    assert.ok(node.querySelector('.rows[data-zone="tabs"] [data-tab-id="23"]'));
    assert.equal(rebuilds(), 1);
    assert.equal(ff.calls.filter(call => call.api === "windows.getAll").length, 1);
  } finally { console.warn = warn; }
});

for (const failures of [1, Infinity]) {
  test(`review round 2: ${failures === 1 ? "transient" : "persistent"} editor-existence failures are logged and retried once`, async () => {
    const { ff, node, control } = await controller();
    await control.handlers.onTabDrop(23, { zone: "new-group" });
    await flush(ff);
    const editId = control.ui.editGroupId;
    control.handlers.onEditState(true);
    const row = node.querySelector('[data-tab-id="14"]');
    const rebuilds = countRebuilds(node);
    const query = ff.browser.tabGroups.query;
    let attempts = 0;
    ff.browser.tabGroups.query = async options => {
      if (++attempts <= failures) throw new Error("Existence read interrupted");
      return query(options);
    };
    const warnings = [], warn = console.warn;
    console.warn = (...args) => warnings.push(args);
    ff.calls.length = 0;
    try {
      await control.refresh();
      await flush(ff);
      await nextFrame();
      assert.equal(attempts, 2, "an existence failure gets one bounded retry, not a frame loop");
      assert.equal(warnings.length, failures === 1 ? 1 : 2);
      assert.ok(warnings.every(args => args[0].startsWith("Foxy:")));
      assert.equal(control.ui.editGroupId, editId, "a failed query must not discard a valid editor");
      assert.equal(control.ui.editing, true);
      assert.equal(node.querySelector('[data-tab-id="14"]'), row);
      assert.equal(rebuilds(), 0);
      assert.equal(ff.calls.filter(call => call.api === "windows.getAll").length, 0);
      ff.browser.tabGroups.query = query;
      await ff.browser.tabs.ungroup(23);
      await flush(ff);
      assert.equal(control.ui.editGroupId, null, "a later removal must recover from query failures");
      assert.equal(control.ui.editing, false);
      assert.equal(rebuilds(), 1);
      assert.equal(ff.calls.filter(call => call.api === "windows.getAll").length, 1);
    } finally { ff.browser.tabGroups.query = query; console.warn = warn; await flush(ff); }
  });
}

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
  // Change the live state without delivering its event: the release itself
  // must request a new read rather than allowing the old snapshot to render.
  await ff.browser.tabs.update(23, { url: "https://example.com/short-edit" });
  ff.calls.length = 0;
  control.handlers.onEditState(true);
  control.handlers.onEditEnd();
  release(); await reading;
  await nextFrame(); await nextFrame();
  assert.ok(node.querySelector('[data-tab-id="23"]') !== old, "changed snapshot needs a replacement even without events");
  assert.equal(node.querySelector('[data-tab-id="23"] .row-label').textContent, "https://example.com/short-edit");
  assert.equal(ff.calls.filter(call => call.api === "windows.getAll").length, 1);
  ff.browser.tabs.query = query;
  await flush(ff);
});

test("missing and broken favicons use the globe at the same 16px size", async () => {
  const node = await draw();
  const globe = node.querySelector('[data-tab-id="12"] .icon');
  assert.ok(globe.classList.contains("icon-none"));
  assert.equal(globe.offsetWidth, 16);
  const ff = createFirefox(setup());
  const model = await board(ff);
  model.columns[0].rows[0].icon = "data:image/png;base64,AAAA";
  const { renderBoard } = await import("./view.js");
  renderBoard(node, model, { editGroupId: null }, {});
  const image = node.querySelector('[data-tab-id="12"] img');
  await new Promise(resolve => image.addEventListener("error", resolve, { once: true }));
  assert.ok(node.querySelector('[data-tab-id="12"] .icon-none'));
});

for (const closingGroup of [false, true]) {
  test(`review minor 1: ${closingGroup ? "close group" : "close tab"} preserves cached self when getCurrent is unavailable`, async () => {
    const set = setup();
    if (closingGroup) set.tabs.find(tab => tab.id === 99).groupId = 101;
    const { ff, control } = await controller(set);
    const getCurrent = ff.browser.tabs.getCurrent, warn = console.warn;
    const warnings = [];
    ff.browser.tabs.getCurrent = async () => undefined;
    console.warn = (...args) => warnings.push(args);
    try {
      if (closingGroup) await control.handlers.onCloseGroup(101);
      else await control.handlers.onCloseTab(99);
      const tabs = await ff.browser.tabs.query({});
      assert.ok(tabs.some(tab => tab.id === 99), "the cached page must never be removed by a close handler");
      if (closingGroup) {
        assert.equal(tabs.find(tab => tab.id === 99).groupId, -1);
        assert.equal(tabs.some(tab => tab.id === 12), false, "close the other group members");
      }
      await control.handlers.onCloseTab(99);
      assert.ok((await ff.browser.tabs.query({})).some(tab => tab.id === 99),
        "a failed refresh must not discard the known self ID for the next close");
      assert.ok(warnings.every(args => args[0].startsWith("Foxy:")));
    } finally {
      ff.browser.tabs.getCurrent = getCurrent;
      await flush(ff);
      console.warn = warn;
    }
  });
}

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
    assert.equal(ff.calls.filter(call => call.api === "runtime.sendMessage" && call.args[0].type === "blank-and-close").length, 0);
  } finally { console.warn = warn; }
  await flush(ff);
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
    assert.equal(ff.calls.filter(call => call.api === "runtime.sendMessage" && call.args[0].type === "blank-and-close").length, 1);
    win.history.pushState(null, "");
    ff.calls.length = 0;
    await control.handlers.onOpen({ id: 21, windowId: 2, pinned: true });
    const pin = await ff.browser.tabs.get(21);
    assert.equal(pin.windowId, 1);
    assert.equal(pin.active, true);
    assert.equal(pin.pinned, true);
    assert.equal(ff.calls.filter(call => call.api === "runtime.sendMessage" && call.args[0].type === "blank-and-close").length, 0);
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


// Legacy tab-board tests should not exercise the absent saved-background error path.
test("fix r1: legacy render controller helper reads without background warnings", async () => {
  const warn = console.warn, warnings = [];
  console.warn = (...args) => warnings.push(args);
  try { await controller(); assert.deepEqual(warnings, []); }
  finally { console.warn = warn; }
});
