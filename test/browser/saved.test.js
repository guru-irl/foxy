import { test, assert, fixture, dispatchDrag, withPseudoState } from "./harness.js";
import { buildBoard } from "../../extension/src/board/model.js";
import { renderBoard } from "./view.js";

const entries = () => [
  { folderId: "f1", title: "<b>Dev server</b>", color: "red", count: 4, cantReopen: ["about:config", "file:///x"] },
  { folderId: "f2", title: "", color: "grey", count: 0, cantReopen: [] },
  { folderId: "f3", title: "  Coverage  ", color: "green", count: 2, cantReopen: [] },
];
let css;
async function draw({ saved = entries(), missing = [], ui = {}, handlers = {} } = {}) {
  css ??= new Promise(resolve => {
    const link = document.createElement("link");
    link.rel = "stylesheet"; link.href = "/extension/newtab.css"; link.onload = resolve;
    document.head.append(link);
  });
  await css; await document.fonts.ready;
  const page = document.createElement("main"); page.className = "page";
  const root = document.createElement("div"); root.className = "board"; root.style.height = "400px";
  page.style.width = "1600px";
  page.append(root); fixture().append(page);
  const board = buildBoard({ windows: [{ id: 1, type: "normal" }], currentWindowId: 1,
    groups: [{ id: 10, windowId: 1, title: "Open group", color: "blue" }],
    tabs: [{ id: 1, windowId: 1, index: 0, groupId: 10, title: "Member" }], saved, missing });
  renderBoard(root, board, ui, handlers);
  return { root, page, board, ui, handlers };
}
const row = (root, id = "f1") => root.querySelector(`[data-folder-id="${id}"]`);
const key = (node, value, extra = {}) => node.dispatchEvent(new KeyboardEvent("keydown", {
  key: value, bubbles: true, cancelable: true, ...extra,
}));

test("SAVED is absent with empty lists and a grid tile with entries", async () => {
  const empty = await draw({ saved: [] });
  assert.equal(empty.page.querySelector(".saved"), null);
  assert.equal(empty.page.querySelector(".banner"), null);
  const { root } = await draw();
  assert.deepEqual([...root.querySelectorAll(".tile")].map(el => el.dataset.kind), ["clock", "pinned", "group", "saved"]);
  assert.equal(root.querySelector('.tile[data-kind="saved"] h2').textContent, "SAVED");
  assert.equal(root.lastElementChild.dataset.zone, "tabs");
});

// Normalizing titles/API colour in the model, parsing labels or dropping metadata fails here.
test("SAVED rows retain literal titles, API identities, count and blocked URL details", async () => {
  const { root } = await draw();
  assert.deepEqual([...root.querySelectorAll(".saved-row")].map(el => el.dataset.folderId), ["f1", "f2", "f3"]);
  const first = row(root), unnamed = row(root, "f2");
  assert.equal(first.dataset.color, "red"); assert.equal(unnamed.dataset.color, "grey");
  assert.equal(first.querySelector(".row-label").textContent, "<b>Dev server</b>");
  assert.equal(first.querySelectorAll("b").length, 0);
  assert.equal(first.querySelector(".saved-count").textContent, "4");
  assert.equal(first.querySelector(".cant-reopen").textContent, "2 CAN'T REOPEN");
  assert.equal(first.querySelector(".cant-reopen").title, "about:config\nfile:///x");
  assert.equal(unnamed.querySelector(".cant-reopen"), null);
  assert.equal(unnamed.querySelector(".row-label").textContent, "UNNAMED");
  assert.equal(row(root, "f3").querySelector(".row-label").textContent, "  Coverage  ");
  assert.equal(first.title, "<b>Dev server</b>");
  const open = first.querySelector(".row-open"), remove = first.querySelector(".saved-delete");
  assert.equal(open.parentElement, remove.parentElement, "activation and delete must be siblings, not nested controls");
  assert.equal(first.getAttribute("role"), null);
  assert.equal(open.tabIndex, 0); assert.equal(remove.tabIndex, -1);
  assert.equal(open.getAttribute("aria-label"), "Open saved group: <b>Dev server</b>, 4 bookmarks, 2 can't reopen");
  assert.equal(unnamed.querySelector(".row-open").getAttribute("aria-label"), "Open saved group: Unnamed, 0 bookmarks");
  assert.equal(row(root, "f3").querySelector(".row-open").getAttribute("aria-label"), "Open saved group:   Coverage  , 2 bookmarks");
  assert.equal(remove.getAttribute("aria-label"), "Delete saved group: <b>Dev server</b>");
  assert.equal(first.draggable, false);
});

test("malformed saved replies render safe defaults and omit entries without folder IDs", async () => {
  const malformed = [null, {}, { folderId: "partial", title: 42, count: "4", cantReopen: null }];
  const { root, page } = await draw({ saved: malformed, missing: malformed });
  assert.equal(root.querySelectorAll(".saved-row").length, 1);
  assert.equal(row(root, "partial").querySelector(".row-label").textContent, "UNNAMED");
  assert.equal(row(root, "partial").querySelector(".saved-count").textContent, "0");
  assert.equal(row(root, "partial").querySelector(".cant-reopen"), null);
  assert.equal(row(root, "partial").dataset.color, "grey");
  assert.equal(page.querySelector(".banner-text").textContent, "1 GROUP DIDN'T COME BACK");
});

for (const [count, text] of [[1, "1 GROUP DIDN'T COME BACK"], [3, "3 GROUPS DIDN'T COME BACK"]]) {
  test(`banner reports ${count} missing groups above grid and rail and routes both actions`, async () => {
    const calls = [];
    const { page, root } = await draw({ missing: entries().slice(0, count), handlers: {
      onRestoreAll: () => calls.push("restore"), onDismissMissing: () => calls.push("dismiss"),
    } });
    const banner = page.querySelector(".banner");
    assert.ok(banner, "missing groups need a banner");
    assert.equal(banner.getAttribute("role"), "status");
    assert.equal(banner.previousElementSibling, null);
    assert.equal(banner.nextElementSibling, root);
    assert.equal(banner.querySelector(".banner-text").textContent, text);
    assert.equal(banner.querySelector(".banner-restore").textContent, "RESTORE ALL");
    assert.equal(banner.querySelector(".banner-dismiss").textContent, "DISMISS");
    assert.deepEqual([...banner.children].map(node => node.className),
      ["banner-text", "banner-separator", "banner-restore", "banner-separator", "banner-dismiss"]);
    for (const separator of banner.querySelectorAll(".banner-separator")) {
      assert.equal(separator.tagName, "SPAN"); assert.equal(separator.textContent, "·");
      assert.equal(separator.getAttribute("aria-hidden"), "true");
    }
    for (const button of banner.querySelectorAll("button")) {
      const style = getComputedStyle(button);
      assert.equal(style.paddingInlineStart, style.paddingInlineEnd);
      assert.ok(parseFloat(style.paddingInlineStart) > 0, "pill fills need padding on both sides");
      assert.equal(getComputedStyle(button, "::before").content, "none");
    }
    banner.querySelector(".banner-restore").click(); banner.querySelector(".banner-dismiss").click();
    assert.deepEqual(calls, ["restore", "dismiss"]);
  });
}

test("confirmation is folder-keyed across renders and pointer/focus departure cancels it", async () => {
  const calls = [], ui = { confirmFolderId: "f2" };
  const { root, board, handlers } = await draw({ ui, handlers: { onConfirmDelete: id => calls.push(id) } });
  assert.equal(root.querySelectorAll(".confirming").length, 1);
  assert.equal(row(root, "f2").querySelector(".saved-delete").textContent, "DELETE?");
  assert.equal(row(root).querySelector(".saved-delete").textContent, "×");
  renderBoard(root, board, ui, handlers);
  assert.equal(row(root, "f2").querySelector(".saved-delete").textContent, "DELETE?");
  row(root).dispatchEvent(new MouseEvent("mouseleave"));
  assert.deepEqual(calls, [], "leaving a different entry must not cancel the confirm");
  row(root, "f2").dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: row(root, "f2").querySelector(".saved-delete") }));
  assert.deepEqual(calls, [], "moving within the row must keep confirmation");
  row(root, "f2").dispatchEvent(new MouseEvent("mouseleave"));
  assert.deepEqual(calls, [null]);
  calls.length = 0;
  row(root, "f2").dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: row(root).querySelector(".row-open") }));
  assert.deepEqual(calls, [null]);
});

test("SAVED keyboard open/delete and DELETE? activation never cross-trigger", async () => {
  const calls = [], ui = { confirmFolderId: null };
  const { root, board } = await draw({ ui });
  const handlers = { onOpenSaved: id => calls.push(["open", id]), onDeleteSaved: id => calls.push(["delete", id]),
    onConfirmDelete: id => { calls.push(["confirm", id]); ui.confirmFolderId = id; renderBoard(root, board, ui, handlers); } };
  renderBoard(root, board, ui, handlers);
  row(root).click();
  key(row(root).querySelector(".row-open"), "Enter");
  key(row(root).querySelector(".row-open"), " ");
  const repeatTarget = row(root).querySelector(".row-open");
  const repeat = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true });
  repeatTarget.dispatchEvent(repeat);
  assert.equal(repeat.defaultPrevented, true, "native repeated Enter must not synthesize an extra activation click");
  assert.deepEqual(calls, [["open", "f1"], ["open", "f1"], ["open", "f1"]]);
  row(root).querySelector(".saved-delete").click();
  assert.equal(row(root).querySelector(".saved-delete").textContent, "DELETE?");
  key(row(root).querySelector(".saved-delete"), "Enter");
  assert.deepEqual(calls.slice(3), [["confirm", "f1"]], "rapid keyboard activation must not confirm");
  await new Promise(resolve => setTimeout(resolve, 410));
  key(row(root).querySelector(".saved-delete"), "Enter");
  assert.deepEqual(calls.slice(3), [["confirm", "f1"], ["delete", "f1"]]);
  ui.confirmFolderId = null; renderBoard(root, board, ui, handlers); calls.length = 0;
  const open = row(root, "f2").querySelector(".row-open"); open.focus(); key(open, "Delete");
  assert.equal(document.activeElement, row(root, "f2").querySelector(".saved-delete"));
  key(document.activeElement, "Escape");
  key(row(root, "f3").querySelector(".row-open"), "Backspace");
  assert.deepEqual(calls, [["confirm", "f2"], ["confirm", null], ["confirm", "f3"]]);
});

test("busy SAVED row and banner reject pointer and keyboard actions without disabling neighbours", async () => {
  const calls = [];
  const { root, page } = await draw({ missing: entries(), ui: { busy: new Set(["f1", "banner"]), confirmFolderId: "f1" },
    handlers: { onOpenSaved: id => calls.push(id), onDeleteSaved: id => calls.push(id), onConfirmDelete: id => calls.push(id),
      onRestoreAll: () => calls.push("restore"), onDismissMissing: () => calls.push("dismiss") } });
  const busy = row(root), banner = page.querySelector(".banner");
  for (const el of [busy, banner]) {
    assert.ok(el.classList.contains("busy"));
    assert.equal(getComputedStyle(el).opacity, "0.5");
    assert.equal(getComputedStyle(el).pointerEvents, "none");
    for (const button of el.querySelectorAll("button")) {
      assert.equal(button.disabled, false);
      assert.equal(button.getAttribute("aria-disabled"), "true");
      button.click(); key(button, "Enter"); key(button, " ");
    }
  }
  busy.click(); key(busy.querySelector(".row-open"), "Delete");
  assert.deepEqual(calls, []);
  row(root, "f2").click(); assert.deepEqual(calls, ["f2"]);
});

// Native disabled controls cannot regain focus after the saved DOM rebuild.
for (const selector of [".row-open", ".saved-delete", ".banner-restore", ".banner-dismiss"]) {
  test(`${selector} keeps keyboard focus when becoming busy and rejects activation`, async () => {
    const calls = [], ui = { busy: new Set(), confirmFolderId: "f1" };
    const { root, page, board, handlers } = await draw({ missing: entries(), ui, handlers: {
      onOpenSaved: () => calls.push("open"), onDeleteSaved: () => calls.push("delete"),
      onConfirmDelete: () => calls.push("confirm"), onRestoreAll: () => calls.push("restore"),
      onDismissMissing: () => calls.push("dismiss"),
    } });
    const find = () => selector.startsWith(".banner") ? page.querySelector(selector) : row(root).querySelector(selector);
    find().focus();
    ui.busy.add(selector.startsWith(".banner") ? "banner" : "f1");
    renderBoard(root, board, ui, handlers);
    const control = find();
    assert.equal(document.activeElement, control, "busy controls must keep keyboard focus");
    control.click(); key(control, "Enter"); key(control, " "); key(control, "Delete");
    assert.deepEqual(calls, []);
    ui.busy.clear(); renderBoard(root, board, ui, handlers);
    assert.equal(document.activeElement, find());
    assert.equal(find().getAttribute("aria-disabled"), "false");
  });
}

test("banner text and actions leave equal padding beside both separators", async () => {
  const { page } = await draw({ missing: entries() });
  for (const item of page.querySelectorAll(".banner-text, .banner-restore, .banner-dismiss")) {
    const style = getComputedStyle(item);
    assert.equal(style.paddingInlineStart, "8px");
    assert.equal(style.paddingInlineEnd, "8px");
  }
});

for (const scheme of ["light", "dark"]) {
  test(`SAVED and banner obey glass, palette and upright typography rules in ${scheme}`, async () => {
    const { root, page } = await draw({ missing: entries(), ui: { confirmFolderId: "f3" } });
    page.style.colorScheme = scheme;
    const banner = page.querySelector(".banner"), column = root.querySelector(".saved");
    for (const el of [banner, column, ...page.querySelectorAll(".saved-row, .saved-row button, .banner button")]) {
      const style = getComputedStyle(el);
      assert.equal(style.borderTopWidth, "0px"); assert.equal(style.outlineStyle, "none"); assert.equal(style.boxShadow, "none");
      assert.ok(style.fontFamily.includes("Foxy Sans"));
    }
    assert.equal(column.offsetWidth, 272);
    for (const el of root.querySelectorAll(".saved-row")) assert.equal(el.offsetHeight, 32);
    assert.equal(getComputedStyle(column.querySelector("h2")).fontStyle, "normal");
    assert.equal(getComputedStyle(root.querySelector(".group-name")).fontStyle, "oblique 10deg");
    assert.equal(getComputedStyle(banner).paddingBlockStart, "8px");
    assert.equal(getComputedStyle(banner).paddingInlineStart, "16px");
    assert.equal(getComputedStyle(banner).backgroundColor, getComputedStyle(column).backgroundColor);
    const unnamed = row(root, "f2").querySelector(".row-label");
    assert.equal(getComputedStyle(unnamed).color, getComputedStyle(banner.querySelector(".banner-text")).color);
    assert.equal(getComputedStyle(row(root).querySelector(".dot")).width, "12px");
    assert.ok(getComputedStyle(row(root).querySelector(".dot")).boxShadow !== "none");
    assert.equal(getComputedStyle(row(root).querySelector(".saved-count")).fontVariantNumeric, "tabular-nums");
    assert.equal(getComputedStyle(row(root).querySelector(".cant-reopen")).fontWeight, "700");
    assert.equal(getComputedStyle(row(root, "f3").querySelector(".saved-delete")).color,
      getComputedStyle(row(root).querySelector(".dot")).getPropertyValue("--g2").trim());
    const remove = row(root).querySelector(".saved-delete");
    assert.equal(getComputedStyle(remove).opacity, "0");
    withPseudoState([row(root)], "hover", () => assert.equal(getComputedStyle(remove).opacity, "1"));
    row(root).querySelector(".row-open").focus();
    assert.equal(document.activeElement, row(root).querySelector(".row-open"));
    // Inactive headless Firefox records activeElement without :focus-within.
    withPseudoState([row(root)], "focus-within", () => assert.equal(getComputedStyle(remove).opacity, "1"));
  });
}

// Titles share .column-title with ordinary drop headings: SAVED must be excluded explicitly.
test("tab drag rejects every SAVED surface and clears old feedback", async () => {
    const calls = [];
    const { root } = await draw({ handlers: { onTabDrop: (...args) => calls.push(args) } });
    const source = root.querySelector("[data-tab-id]");
    const dt = dispatchDrag("dragstart", source).dataTransfer;
    try {
      for (const selector of [".saved", ".saved .column-title", ".saved .rows", ".saved-row", ".saved-row .dot"]) {
        const valid = root.querySelector('.rows[data-zone="tabs"]');
        const target = root.querySelector(selector), bounds = target.getBoundingClientRect();
        dispatchDrag("dragover", valid, { dataTransfer: dt, clientX: bounds.right, clientY: bounds.top });
        assert.ok(root.querySelector(".drop-line"), "exercise clearing a previous valid marker");
        const event = dispatchDrag("dragover", target, { dataTransfer: dt, clientX: bounds.left + 10, clientY: bounds.top + 10 });
        assert.equal(event.defaultPrevented, false); assert.equal(dt.dropEffect, "none");
        assert.equal(root.querySelector(".drop-line, .drop-target"), null);
        dispatchDrag("drop", target, { dataTransfer: dt });
      }
      assert.deepEqual(calls, []);
    } finally { dispatchDrag("dragend", source, { dataTransfer: dt }); }
});

test("SAVED never starts a tab drag", async () => {
  const calls = [];
  const { root } = await draw({ handlers: { onDragState: value => calls.push(value) } });
  const dt = dispatchDrag("dragstart", row(root)).dataTransfer;
  assert.deepEqual(calls, []);
  assert.equal(dt.types.length, 0); assert.equal(row(root).classList.contains("dragging"), false);
});

test("busy membership blocks double activation immediately, before the next render", async () => {
  const calls = [], ui = { busy: new Set() };
  const { root, page } = await draw({ missing: entries(), ui, handlers: {
    onOpenSaved: id => { calls.push(id); ui.busy.add(id); },
    onRestoreAll: () => { calls.push("banner"); ui.busy.add("banner"); },
    onDismissMissing: () => calls.push("dismiss"),
  } });
  row(root).click(); row(root).click(); key(row(root).querySelector(".row-open"), "Enter");
  const restore = page.querySelector(".banner-restore"); restore.click(); restore.click();
  page.querySelector(".banner-dismiss").click();
  assert.deepEqual(calls, ["f1", "banner"]);
});

for (const selector of [".row-open", ".saved-delete"]) {
  test(`SAVED ${selector} retains focus and confirmation through a rebuild and falls back on removal`, async () => {
    const calls = [], ui = { confirmFolderId: "f2" };
    const { root, board, handlers } = await draw({ ui, handlers: { onConfirmDelete: id => calls.push(id) } });
    const original = row(root, "f2").querySelector(selector);
    original.focus(); assert.equal(document.activeElement, original);
    renderBoard(root, board, ui, handlers);
    assert.equal(document.activeElement, row(root, "f2").querySelector(selector));
    assert.ok(document.activeElement !== original);
    assert.equal(row(root, "f2").querySelector(".saved-delete").textContent, "DELETE?");
    assert.deepEqual(calls, [], "a rebuild must not act like leaving the confirming row");
    const remaining = board.saved.filter(group => group.folderId !== "f2");
    renderBoard(root, { ...board, saved: remaining }, ui, handlers);
    assert.equal(document.activeElement, row(root, "f3").querySelector(".row-open"));
    renderBoard(root, { ...board, saved: [] }, ui, handlers);
    assert.equal(document.activeElement, root.querySelector(".grid"));
  });
}

for (const selector of [".banner-restore", ".banner-dismiss"]) {
  test(`${selector} retains focus across refresh and falls back when the banner disappears`, async () => {
    const { root, page, board } = await draw({ saved: [], missing: entries() });
    const original = page.querySelector(selector); original.focus();
    renderBoard(root, { ...board, missing: entries().slice(0, 1) }, {}, {});
    assert.equal(document.activeElement, page.querySelector(selector));
    assert.ok(document.activeElement !== original);
    renderBoard(root, { ...board, missing: [] }, {}, {});
    assert.equal(document.activeElement, root.querySelector(".grid"));
  });
}

// Replacing a live status node or its text re-announces an unchanged count.
test("unchanged missing count reuses the status banner without text mutations and updates its actions", async () => {
  const calls = [];
  const { root, page, board } = await draw({ missing: entries(), handlers: { onRestoreAll: () => calls.push("old") } });
  const original = page.querySelector(".banner"), text = original.querySelector(".banner-text");
  const observer = new MutationObserver(() => {});
  observer.observe(original, { childList: true, characterData: true, subtree: true });
  const ui = { busy: new Set(["banner"]) };
  const handlers = { onRestoreAll: () => calls.push("new"), onDismissMissing: () => calls.push("dismiss") };
  renderBoard(root, { ...board, saved: board.saved.slice(1), missing: entries().reverse() }, ui, handlers);
  assert.equal(page.querySelector(".banner"), original, "unchanged count must reuse the live status node");
  assert.equal(original.querySelector(".banner-text"), text);
  assert.equal(observer.takeRecords().length, 0, "unrelated refresh must not rewrite status text");
  original.querySelector(".banner-restore").click();
  assert.deepEqual(calls, []);
  renderBoard(root, board, { busy: new Set() }, handlers);
  original.querySelector(".banner-restore").click(); original.querySelector(".banner-dismiss").click();
  assert.deepEqual(calls, ["new", "dismiss"], "reused controls must use current UI and callbacks");
  assert.equal(observer.takeRecords().length, 0);
  observer.disconnect();
});

test("banner is updated once and removed when missing becomes empty", async () => {
  const { root, page, board } = await draw({ missing: entries() });
  renderBoard(root, board, {}, {});
  assert.equal(page.querySelectorAll(".banner").length, 1);
  renderBoard(root, { ...board, missing: [] }, {}, {});
  assert.equal(page.querySelector(".banner"), null);
});


test("single bookmark uses a singular accessible label", async () => {
  const { root } = await draw({ saved: [{ folderId: "f1", title: "One", color: "grey", count: 1 }] });
  assert.equal(row(root).querySelector(".row-open").getAttribute("aria-label"), "Open saved group: One, 1 bookmark");
});

test("banner actions expose busy state without suppressing the status live region", async () => {
  const { page } = await draw({ missing: entries(), ui: { busy: new Set(["banner"]) } });
  const banner = page.querySelector(".banner");
  assert.equal(banner.hasAttribute("aria-busy"), false);
  for (const button of banner.querySelectorAll("button")) assert.equal(button.getAttribute("aria-busy"), "true");
});
