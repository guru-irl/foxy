import { test, assert, fixture, nextFrame, dispatchDrag } from "./harness.js";
import { createFirefox } from "../fakes/firefox.js";
import { buildBoard } from "../../extension/src/board/model.js";
import { renderBoard } from "../../extension/src/board/render.js";

const setup = () => ({
  windows: [{ id: 1, focused: true }, { id: 2 }], selfTabId: 99,
  groups: [{ id: 101, windowId: 1, title: "First", color: "red" },
    { id: 102, windowId: 1, title: "   ", color: "grey" },
    { id: 201, windowId: 2, title: "Remote", color: "blue" }],
  tabs: [{ id: 11, windowId: 1, pinned: true }, { id: 12, windowId: 1, groupId: 101 },
    { id: 13, windowId: 1, groupId: 101 }, { id: 14, windowId: 1, groupId: 102 },
    { id: 15, windowId: 1 }, { id: 99, windowId: 1, active: true, url: location.origin + location.pathname },
    { id: 21, windowId: 2, pinned: true }, { id: 22, windowId: 2, groupId: 201 },
    { id: 23, windowId: 2 }].map(tab => ({ ...tab, lastAccessed: 100 / tab.windowId })),
});
let css;
async function root() {
  css ??= new Promise(resolve => {
    const link = document.createElement("link");
    link.rel = "stylesheet"; link.href = "/extension/newtab.css"; link.onload = resolve;
    document.head.append(link);
  });
  await css; await document.fonts.ready;
  const node = document.createElement("div");
  node.className = "board"; node.setAttribute("aria-label", "Tab board");
  node.style.width = "1600px"; node.style.height = "500px";
  fixture().append(node);
  return node;
}
async function draw(handlers = {}, ui = {}) {
  const ff = createFirefox(setup()), node = await root();
  const board = buildBoard({ windows: await ff.browser.windows.getAll(), tabs: await ff.browser.tabs.query({}),
    groups: await ff.browser.tabGroups.query({}), currentWindowId: 1, selfTabId: 99 });
  renderBoard(node, board, ui, handlers);
  return node;
}
async function controller(set = setup()) {
  const ff = createFirefox(set), node = await root();
  const { createController } = await import("../../extension/src/main.js");
  const control = createController(node, ff.browser);
  await control.refresh();
  return { ff, node, control };
}
async function flush(ff) { await ff.settle(); await nextFrame(); await nextFrame(); }
const name = (node, id = 101) => node.querySelector(`.column[data-group-id="${id}"] .group-name`);
const key = (node, value) => node.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
function input(node) {
  const field = node.querySelector(".name-editor");
  assert.ok(field instanceof HTMLInputElement, "clicking a group title must open the inline input");
  return field;
}
function rebuilds(node) {
  let count = 0;
  const replace = node.replaceChildren.bind(node);
  node.replaceChildren = (...children) => { count++; replace(...children); };
  return () => count;
}

// Missing trimming, duplicate blur/Enter callbacks or Escape saving fails these.
for (const ending of ["Enter", "Escape", "blur"]) {
  test(`name editor ${ending} ends once and ${ending === "Escape" ? "cancels" : "saves trimmed text"}`, async () => {
    const saved = [], ended = [], states = [];
    const node = await draw({ onRename: (...args) => saved.push(args), onEditEnd: () => ended.push(true),
      onEditState: value => states.push(value) });
    name(node).click();
    const field = input(node);
    assert.equal(document.activeElement, field);
    assert.equal(field.value, "First");
    assert.equal(field.selectionStart, 0); assert.equal(field.selectionEnd, 5);
    field.value = "  New name  ";
    if (ending === "blur") field.blur(); else key(field, ending);
    field.dispatchEvent(new FocusEvent("blur")); key(field, "Enter");
    assert.deepEqual(saved, ending === "Escape" ? [] : [[101, "New name"]]);
    assert.equal(ended.length, 1);
    assert.deepEqual(states, [true]);
    assert.equal(node.querySelector(".name-editor"), null);
    assert.equal(name(node).textContent, ending === "Escape" ? "First" : "New name");
  });
}

test("empty commit remains faint UNNAMED and long editor never widens a column", async () => {
  const saved = [];
  const node = await draw({ onRename: (...args) => saved.push(args) });
  name(node, 102).click();
  const field = input(node), column = field.closest(".column");
  field.value = "Long name ".repeat(100);
  assert.equal(column.offsetWidth, 264);
  assert.ok(field.getBoundingClientRect().right <= column.getBoundingClientRect().right);
  const style = getComputedStyle(field);
  assert.ok(style.fontFamily.includes("Foxy Sans"));
  assert.equal(style.fontWeight, "800"); assert.equal(style.fontStretch, "50%");
  assert.equal(style.borderTopWidth, "0px"); assert.equal(style.outlineStyle, "none"); assert.equal(style.boxShadow, "none");
  field.value = " \t "; key(field, "Enter");
  assert.deepEqual(saved, [[102, ""]]);
  assert.equal(name(node, 102).textContent, "UNNAMED"); assert.ok(name(node, 102).classList.contains("unnamed"));
});

test("title and colour edits are exclusive and each releases its hold once", async () => {
  const ended = [], saved = [];
  const node = await draw({ onEditEnd: () => ended.push(true), onRename: (...args) => saved.push(args) });
  name(node).click(); input(node).value = "Edited";
  node.querySelector('[data-group-id="201"] .dot').click();
  assert.equal(node.querySelectorAll(".name-editor").length, 0);
  assert.equal(node.querySelectorAll(".color-picker").length, 1);
  assert.deepEqual(saved, [[101, "Edited"]]); assert.equal(ended.length, 1);
  name(node, 102).click();
  assert.equal(node.querySelectorAll(".color-picker").length, 0);
  assert.equal(node.querySelectorAll(".name-editor").length, 1);
  assert.equal(ended.length, 2);
  key(input(node), "Escape"); assert.equal(ended.length, 3);
});

// Wrong API spelling/order (gray instead of grey) and inheriting the group's
// palette for every swatch fail these literal picker and computed-style checks.
test("picker offers nine distinct dots in API order and picks green once", async () => {
  const picked = [], ended = [];
  const node = await draw({ onRecolor: (...args) => picked.push(args), onEditEnd: () => ended.push(true) });
  node.querySelector('[data-group-id="101"] .dot').click();
  const picker = node.querySelector(".color-picker");
  assert.ok(picker, "dot click must open the picker under the header");
  const dots = [...picker.querySelectorAll("button.dot")];
  assert.deepEqual(dots.map(dot => dot.dataset.color), ["blue", "cyan", "green", "grey", "orange", "pink", "purple", "red", "yellow"]);
  assert.equal(new Set(dots.map(dot => getComputedStyle(dot).backgroundImage)).size, 9);
  assert.equal(picker.closest(".column").offsetWidth, 264);
  assert.ok(picker.getBoundingClientRect().top >= picker.closest(".column").querySelector("header").getBoundingClientRect().bottom);
  assert.equal(dots.filter(dot => dot.getAttribute("aria-pressed") === "true").length, 1);
  assert.equal(dots.find(dot => dot.getAttribute("aria-pressed") === "true").dataset.color, "red");
  dots[2].click(); dots[2].click();
  assert.deepEqual(picked, [[101, "green"]]); assert.equal(ended.length, 1);
  assert.equal(node.querySelector(".color-picker"), null);
});
for (const ending of ["Escape", "outside click"]) {
  test(`picker ${ending} closes without recolour and restores the dot focus`, async () => {
    const picked = [], ended = [];
    const node = await draw({ onRecolor: (...args) => picked.push(args), onEditEnd: () => ended.push(true) });
    const dot = node.querySelector('[data-group-id="101"] .dot');
    dot.click(); assert.ok(node.querySelector(".color-picker"));
    if (ending === "Escape") key(document.activeElement, "Escape"); else node.querySelector(".new-group").click();
    assert.equal(node.querySelector(".color-picker"), null);
    assert.deepEqual(picked, []); assert.equal(ended.length, 1);
    if (ending === "Escape") assert.equal(document.activeElement, dot);
    key(document, "Escape"); assert.equal(ended.length, 1);
  });
}

for (const ending of ["Enter", "Escape"]) {
  test(`new-group DOM drop opens selected focused input and ${ending} releases one refresh`, async () => {
    const { ff, node, control } = await controller();
    node.querySelector('[data-tab-id="15"]').focus();
    const source = node.querySelector('[data-tab-id="15"]');
    const transfer = dispatchDrag("dragstart", source).dataTransfer;
    dispatchDrag("drop", node.querySelector(".new-group"), { dataTransfer: transfer });
    dispatchDrag("dragend", source, { dataTransfer: transfer });
    await flush(ff);
    const field = input(node), id = (await ff.browser.tabs.get(15)).groupId;
    assert.equal(field.closest(".column").dataset.groupId, String(id));
    assert.equal(document.activeElement, field, "focus restore must not override the new editor");
    assert.equal(field.value, ""); assert.equal(control.ui.editGroupId, id); assert.equal(control.ui.editing, true);
    const count = rebuilds(node);
    await ff.browser.tabs.update(23, { url: "https://example.com/during-edit" }); await flush(ff);
    assert.equal(input(node), field); assert.equal(count(), 0);
    field.value = "  Created  "; key(field, ending); await flush(ff);
    assert.equal((await ff.browser.tabGroups.get(id)).title, ending === "Enter" ? "Created" : "");
    assert.equal(control.ui.editGroupId, null); assert.equal(control.ui.editing, false);
    assert.equal(count(), 1); assert.equal(node.querySelector(".name-editor"), null);
    assert.equal((await ff.browser.tabs.get(99)).url, location.origin + location.pathname);
  });
}

for (const kind of ["name", "colour"]) {
  test(`existing ${kind} editor holds pending events and unrelated removal, then releases once`, async () => {
    const { ff, node, control } = await controller();
    if (kind === "name") name(node).click(); else node.querySelector('[data-group-id="101"] .dot').click();
    const editor = node.querySelector(kind === "name" ? ".name-editor" : ".color-picker");
    assert.ok(editor); assert.equal(control.ui.editGroupId, 101); assert.equal(control.ui.editing, true);
    const count = rebuilds(node);
    await ff.browser.tabs.ungroup(14);
    await ff.browser.tabs.update(23, { url: "https://example.com/pending-edit" });
    await flush(ff); await control.refresh();
    assert.ok(editor.isConnected); assert.equal(count(), 0);
    key(kind === "name" ? editor : document.activeElement, "Escape"); await flush(ff);
    assert.equal(count(), 1); assert.equal(control.ui.editing, false); assert.equal(control.ui.editGroupId, null);
    assert.equal(node.querySelector('[data-tab-id="23"] .row-label').textContent, "https://example.com/pending-edit");
  });
  test(`removing the active existing ${kind} editor's group cleans listeners and releases holds`, async () => {
    const { ff, node, control } = await controller();
    if (kind === "name") name(node).click(); else node.querySelector('[data-group-id="101"] .dot').click();
    assert.ok(node.querySelector(kind === "name" ? ".name-editor" : ".color-picker"));
    const count = rebuilds(node);
    await ff.browser.tabs.remove([12, 13]); await flush(ff);
    assert.equal(control.ui.editing, false); assert.equal(control.ui.editGroupId, null); assert.equal(count(), 1);
    // A stale document listener must not end the newly opened editor.
    name(node, 102).click(); assert.equal(control.ui.editGroupId, 102);
    key(document.activeElement, "Escape"); await flush(ff);
    assert.equal(control.ui.editing, false); assert.equal(control.ui.editGroupId, null);
    assert.equal(ff.errors.length, 0);
  });
}

test("colour selection updates the real group and releases exactly one changed render", async () => {
  const { ff, node, control } = await controller();
  node.querySelector('[data-group-id="101"] .dot').click();
  const picker = node.querySelector(".color-picker"); assert.ok(picker);
  const count = rebuilds(node);
  picker.querySelector('[data-color="grey"]').click(); await flush(ff);
  assert.equal((await ff.browser.tabGroups.get(101)).color, "grey");
  assert.equal(node.querySelector('.column[data-group-id="101"]').dataset.color, "gray");
  assert.equal(control.ui.editing, false); assert.equal(count(), 1);
});

test("row activation and close are keyboard-reachable siblings, and the board is a region", async () => {
  const node = await draw();
  assert.equal(node.getAttribute("role"), "region");
  const row = node.querySelector('[data-tab-id="12"]'), open = row.querySelector(".row-open"), close = row.querySelector(".row-close");
  assert.ok(open instanceof HTMLButtonElement, "tab activation must be a separate button");
  assert.equal(open.parentElement, close.parentElement);
  assert.equal(row.getAttribute("role"), null);
  assert.equal(open.tabIndex, 0); assert.equal(close.tabIndex, 0);
  assert.equal(close.closest('[role="button"]'), null);
  close.focus(); assert.equal(document.activeElement, close);
});

test("remote bring-here has a neutral mask instead of a missing font glyph", async () => {
  const node = await draw(), bring = node.querySelector(".bring-here");
  assert.equal(bring.textContent, "");
  const style = getComputedStyle(bring.querySelector(".bring-icon"));
  assert.ok(style.maskImage.includes("bring-here.svg"));
  assert.equal(style.width, "16px"); assert.equal(style.height, "16px");
  assert.equal(style.boxShadow, "none"); assert.equal(style.outlineStyle, "none");
});

// These already wired action contracts are supplementary integration coverage.
test("row close removes only its tab without activation or closing the page", async () => {
  const { ff, node } = await controller(); ff.calls.length = 0;
  node.querySelector('[data-tab-id="12"] .row-close').click(); await flush(ff);
  assert.equal(ff.layout(1), "P11 | [101: 13] [102: 14] 15 99");
  assert.equal(ff.calls.some(call => call.api === "tabs.update" || call.api === "runtime.sendMessage"), false);
  assert.equal((await ff.browser.tabs.get(99)).active, true);
});
test("header close removes group members but ungroups and preserves the page", async () => {
  const set = setup(); set.tabs.find(tab => tab.id === 99).groupId = 101;
  // Keep group members contiguous in the fake's physical strip.
  set.tabs = [set.tabs[0], set.tabs[1], set.tabs[2], set.tabs[5], set.tabs[3], set.tabs[4], ...set.tabs.slice(6)];
  const { ff, node } = await controller(set);
  node.querySelector('[data-group-id="101"] .column-close').click(); await flush(ff);
  assert.equal(ff.layout(1), "P11 | 99 [102: 14] 15");
  assert.equal((await ff.browser.tabs.get(99)).groupId, -1);
});
test("bring-here moves the group to the current window after its last tab", async () => {
  const { ff, node } = await controller();
  node.querySelector(".bring-here").click(); await flush(ff);
  assert.equal(ff.layout(1), "P11 | [101: 12 13] [102: 14] 15 99 [201: 22]");
  assert.equal(ff.layout(2), "P21 | 23");
  assert.equal(node.querySelector('[data-group-id="201"] .bring-here'), null);
});

test("stale rename logs Foxy and rereads without keeping a hold", async () => {
  const { ff, node, control } = await controller();
  name(node).click(); const field = input(node);
  const warnings = [], warn = console.warn; console.warn = (...args) => warnings.push(args);
  try {
    await ff.browser.tabs.ungroup([12, 13]); // events have not yet been delivered
    field.value = "Gone"; key(field, "Enter"); await flush(ff);
    assert.ok(warnings.some(args => args[0].startsWith("Foxy:")));
    assert.equal(control.ui.editGroupId, null); assert.equal(control.ui.editing, false);
    assert.equal(node.querySelector('.column[data-group-id="101"]'), null);
    assert.ok(ff.calls.some(call => call.api === "windows.getAll"));
    assert.equal(ff.errors.length, 0);
  } finally { console.warn = warn; }
});

// Buttons have UA text-transform:none; replacing the span must not lose caps.
test("renamable group buttons and their input retain capital title typography", async () => {
  const node = await draw();
  const title = name(node);
  assert.equal(getComputedStyle(title).textTransform, "uppercase");
  title.click();
  assert.equal(getComputedStyle(input(node)).textTransform, "uppercase");
  key(input(node), "Escape");
});

test("closing a keyboard-focused row control focuses the next row's open button", async () => {
  const { ff, node } = await controller();
  const close = node.querySelector('[data-tab-id="12"] .row-close');
  close.focus(); close.click(); await flush(ff);
  assert.equal(document.activeElement, node.querySelector('[data-tab-id="13"] .row-open'));
});

test("opening an actual editor invalidates an in-flight snapshot without losing text", async () => {
  const { ff, node, control } = await controller();
  const query = ff.browser.tabs.query;
  let release, first = true;
  ff.browser.tabs.query = async options => {
    const snapshot = await query(options);
    if (first) { first = false; await new Promise(resolve => { release = resolve; }); }
    return snapshot;
  };
  const reading = control.refresh();
  await Promise.resolve(); await Promise.resolve();
  try {
    name(node).click(); const field = input(node); field.value = "In progress";
    await ff.browser.tabs.update(23, { url: "https://example.com/inflight-edit" });
    release(); await reading; await flush(ff);
    assert.equal(input(node), field); assert.equal(field.value, "In progress");
    key(field, "Enter"); await flush(ff);
    assert.equal((await ff.browser.tabGroups.get(101)).title, "In progress");
    assert.equal(node.querySelector('[data-tab-id="23"] .row-label').textContent, "https://example.com/inflight-edit");
  } finally { release?.(); ff.browser.tabs.query = query; key(node.querySelector(".name-editor") ?? node, "Escape"); await flush(ff); }
});
