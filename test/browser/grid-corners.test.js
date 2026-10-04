import { test, assert, fixture, nextFrame, withPseudoState } from "./harness.js";
import { createBoardFirefox } from "./controller.js";
import { createController } from "../../extension/src/main.js";

let css;
const original = { x: 2, y: 2, w: 4, h: 4 };
async function flush(ff) {
  await ff.settle();
  if (document.querySelector(".grid.settling")) await new Promise(resolve => setTimeout(resolve, 330));
  for (let i = 0; i < 5; i++) { await ff.settle(); await nextFrame(); }
}
async function setup({ rect = original, width = 1232, widgets = false,
  neighbour = { x: 2, y: widgets ? 0 : 6, w: 4, h: 2 } } = {}) {
  css ??= new Promise(resolve => {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/extension/newtab.css";
    link.onload = resolve; document.head.append(link);
  });
  await css;
  const ff = createBoardFirefox({ windows: [{ id: 1 }], selfTabId: 99,
    groups: [{ id: 1, windowId: 1, title: "A" }, { id: 2, windowId: 1, title: "B" }],
    tabs: [{ id: 10, windowId: 1, groupId: 1 }, { id: 20, windowId: 1, groupId: 2 }, { id: 99, windowId: 1 }] },
    message => message.type === "foxy:reconcile" ? { ok: true }
      : message.type === "foxy:saved" ? { folders: { 1: "a", 2: "b" }, missing: [],
        saved: widgets ? [{ folderId: "closed", title: "Closed" }] : [] } : undefined);
  // These geometry fixtures use Custom 80, independent of the S default.
  await ff.browser.storage.local.set({ deviceSettings: { cellSize: "custom", customCell: 80 } });
  await ff.browser.storage.sync.set({
    "tile:10:group:a": rect, "tile:10:group:b": neighbour,
    "tile:10:clock": { x: 6, y: 0, w: 4, h: 2 }, "tile:10:pinned": { x: 6, y: 2, w: 4, h: 2 },
    "tile:10:saved": { x: 6, y: 4, w: 4, h: 2 },
    settings: { showClock: widgets, showPinned: widgets, showSaved: widgets },
  });
  await ff.settle();
  const root = document.createElement("div"); root.className = "board";
  root.style.cssText = `width:${width}px;height:900px`; fixture().append(root);
  const control = createController(root, ff.browser);
  await control.refresh(); await flush(ff); ff.calls.length = 0;
  return { ff, root, control };
}
const tile = (root, id = "group:a") => [...root.querySelectorAll(".tile")].find(node => node.dataset.tileId === id);
const rect = node => Object.fromEntries(["x", "y", "w", "h"].map(key => [key, Number(node.style.getPropertyValue(`--${key}`))]));
const box = node => node.getBoundingClientRect();
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.1,
  `${message}: expected ${expected}, got ${actual}`);
// Layout meta keys carry timestamps; tile placement is what these tests assert.
const writes = ff => ff.calls.filter(call => call.api === "storage.sync.set").map(call => Object.fromEntries(Object.entries(call.args[0]).filter(([key]) => !key.startsWith("layout:"))));
function pointer(type, target, coords) {
  assert.ok(target, `missing pointer target for ${type}`);
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1,
    pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, ...coords }));
}
function down(source) {
  assert.ok(source, "missing resize handle");
  const bounds = box(source), start = { clientX: bounds.left + 5, clientY: bounds.top + 6 };
  pointer("pointerdown", source, start); return start;
}
const shifted = (start, x, y) => ({ clientX: start.clientX + x, clientY: start.clientY + y });
function escape() { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); }

// Missing handles, the wrong corner position, a visible dot or a header painted
// above a top handle breaks the real hit test. All four tile kinds are included.
test("all tile kinds have four invisible, pointer-only 16px corners above their headers", async () => {
  const { ff, root } = await setup({ widgets: true });
  assert.deepEqual([...new Set([...root.querySelectorAll(".tile")].map(node => node.dataset.kind))].sort(),
    ["clock", "group", "pinned", "saved"]);
  for (const node of root.querySelectorAll(".tile")) {
    const handles = [...node.querySelectorAll(".tile-resize")];
    assert.equal(handles.length, 4, "each tile needs exactly four handles");
    assert.deepEqual(handles.map(handle => handle.dataset.corner).sort(), ["ne", "nw", "se", "sw"]);
    const card = box(node);
    for (const handle of handles) {
      const corner = handle.dataset.corner, bounds = box(handle), style = getComputedStyle(handle);
      close(bounds.width, 16, `${corner} hit width`); close(bounds.height, 16, `${corner} hit height`);
      close(bounds.left, corner.endsWith("w") ? card.left : card.right - 16, `${corner} left`);
      close(bounds.top, corner.startsWith("n") ? card.top : card.bottom - 16, `${corner} top`);
      assert.equal(style.cursor, ["nw", "se"].includes(corner) ? "nwse-resize" : "nesw-resize");
      assert.equal(style.opacity, "0");
      withPseudoState([node], "hover", () => assert.equal(getComputedStyle(handle).opacity, "0"));
      withPseudoState([node], "focus-within", () => assert.equal(getComputedStyle(handle).opacity, "0"));
      assert.equal(handle.tabIndex, -1); assert.equal(handle.getAttribute("aria-hidden"), "true");
      assert.equal(style.boxShadow, "none"); assert.equal(style.borderTopWidth, "0px"); assert.equal(style.outlineStyle, "none");
      const hit = document.elementFromPoint(bounds.left + 8, bounds.top + 8);
      assert.equal(hit, handle, `${node.dataset.tileId} ${corner} wins hit testing: hit=${hit?.className}, at=${bounds.left + 8},${bounds.top + 8}, viewport=${innerWidth},${innerHeight}`);
    }
  }
  assert.deepEqual(writes(ff), []);
});

// Widening the handles over the whole header would steal this normal move.
test("header drag still starts outside the corner squares", async () => {
  const { ff, root } = await setup();
  const node = tile(root), before = box(node), source = node.querySelector(".column-header");
  const start = { clientX: before.left + 80, clientY: before.top + 12 };
  const hit = document.elementFromPoint(start.clientX, start.clientY);
  assert.ok(source === hit || source.contains(hit)); assert.equal(hit.closest(".tile-resize"), null);
  try {
    pointer("pointerdown", hit, start); pointer("pointermove", document, shifted(start, 37, 21));
    close(box(node).left - before.left, 37, "header free x"); close(box(node).top - before.top, 21, "header free y");
    close(box(node).width, before.width, "header move keeps width");
    assert.ok(root.hasAttribute("data-grid-dragging"));
  } finally { escape(); await flush(ff); }
  assert.deepEqual(writes(ff), []);
});

const corners = [
  { corner: "nw", dx: -1, dy: -1, target: { x: 1, y: 1, w: 5, h: 5 },
    min: { x: 4, y: 4, w: 2, h: 2 }, edge: { x: 0, y: 0, w: 6, h: 6 } },
  { corner: "ne", dx: 1, dy: -1, target: { x: 2, y: 1, w: 5, h: 5 },
    min: { x: 2, y: 4, w: 2, h: 2 }, edge: { x: 2, y: 0, w: 8, h: 6 } },
  { corner: "sw", dx: -1, dy: 1, target: { x: 1, y: 2, w: 5, h: 5 },
    min: { x: 4, y: 2, w: 2, h: 2 }, edge: { x: 0, y: 2, w: 6, h: 25 } },
  { corner: "se", dx: 1, dy: 1, target: { x: 2, y: 2, w: 5, h: 5 },
    min: { x: 2, y: 2, w: 2, h: 2 }, edge: { x: 2, y: 2, w: 8, h: 25 } },
];

// Using the old southeast offsets or pinning the tile to its snapped origin
// moves the wrong edge. Literal rectangles also catch snapping before offset.
for (const { corner, dx, dy, target, min, edge } of corners) {
  for (const end of ["release", "Escape"]) {
    test(`${corner} free follow fixes its opposite corner, snaps and ${end === "release" ? "lands in the outline" : "restores on Escape"}`, async () => {
      const { ff, root, control } = await setup(), node = tile(root), before = box(node);
      const source = node.querySelector(`[data-corner="${corner}"]`), start = down(source);
      try {
        pointer("pointermove", document, shifted(start, dx * 37, dy * 21));
        close(box(node).left, before.left + (dx < 0 ? -37 : 0), "free left");
        close(box(node).top, before.top + (dy < 0 ? -21 : 0), "free top");
        close(box(node).width, before.width + 37, "free width");
        close(box(node).height, before.height + 21, "free height");
        assert.deepEqual(rect(root.querySelector(".drop-outline")), original, "sub-cell target stays snapped");
        const coords = shifted(start, dx * 133, dy * 117);
        pointer("pointermove", document, coords);
        close(box(node).left, before.left + (dx < 0 ? -133 : 0), "free left across snap");
        close(box(node).top, before.top + (dy < 0 ? -117 : 0), "free top across snap");
        close(box(node).width, before.width + 133, "free width across snap");
        close(box(node).height, before.height + 117, "free height across snap");
        const outline = root.querySelector(".drop-outline"), landing = box(outline);
        assert.deepEqual(rect(outline), target);
        assert.deepEqual(rect(tile(root, "group:b")), { x: 2, y: dy > 0 ? 7 : 6, w: 4, h: 2 });
        assert.ok(root.querySelector(".grid").classList.contains("gesturing"));
        assert.ok(root.querySelector(".grid-corners circle"), "reuse gesture dots");
        assert.deepEqual(writes(ff), [], "preview writes nothing");
        if (end === "release") pointer("pointerup", document, coords); else escape();
        for (let i = 0; i < 6; i++) await Promise.resolve();
        assert.equal(control.ui.gridDragging, true, "hold extends through the slide");
        assert.ok(node.classList.contains("sliding"));
        const expectedWrites = end === "Escape" ? [] : [{ "tile:10:group:a": target,
          ...(dy > 0 ? { "tile:10:group:b": { x: 2, y: 7, w: 4, h: 2 } } : {}) }];
        assert.deepEqual(writes(ff), expectedWrites, "release writes before settlement");
        await flush(ff);
        const landed = box(tile(root)), expected = end === "release" ? landing : before;
        for (const key of ["left", "top", "width", "height"]) close(landed[key], expected[key], `landed ${key}`);
        assert.deepEqual(rect(tile(root)), end === "release" ? target : original);
        assert.equal(control.ui.gridDragging, false);
        assert.equal(root.querySelector(".drop-outline"), null);
        assert.deepEqual(writes(ff), expectedWrites);
      } finally { escape(); await flush(ff); }
    });
  }

  // A top/left minimum computed at the moving corner instead of the fixed
  // corner shifts the opposite edge; signed inward deltas also cross it.
  test(`${corner} minimum size is measured from the fixed opposite corner`, async () => {
    const { ff, root } = await setup(), node = tile(root), before = box(node);
    const start = down(node.querySelector(`[data-corner="${corner}"]`));
    try {
      pointer("pointermove", document, shifted(start, -dx * 2000, -dy * 2000));
      close(box(node).width, 176, "minimum pixel width"); close(box(node).height, 176, "minimum pixel height");
      close(dx < 0 ? box(node).right : box(node).left, dx < 0 ? before.right : before.left, "fixed horizontal edge at minimum");
      close(dy < 0 ? box(node).bottom : box(node).top, dy < 0 ? before.bottom : before.top, "fixed vertical edge at minimum");
      assert.deepEqual(rect(root.querySelector(".drop-outline")), min);
      pointer("pointerup", document, shifted(start, -dx * 2000, -dy * 2000)); await flush(ff);
      assert.deepEqual(rect(tile(root)), min);
      assert.deepEqual(writes(ff), [{ "tile:10:group:a": min }]);
    } finally { escape(); await flush(ff); }
  });

  // clampRect applied to a negative origin with the old width shifts the
  // fixed edge instead of shrinking only the moving side at row/column zero.
  test(`${corner} outline clamps to the outer column and row zero without shifting the opposite corner`, async () => {
    const { ff, root } = await setup(), node = tile(root);
    const start = down(node.querySelector(`[data-corner="${corner}"]`));
    const coords = shifted(start, dx * 2000, dy * 2000);
    try {
      pointer("pointermove", document, coords);
      assert.deepEqual(rect(root.querySelector(".drop-outline")), edge);
      assert.deepEqual(writes(ff), []);
      pointer("pointerup", document, coords); await flush(ff);
      assert.deepEqual(rect(tile(root)), edge, "clamped release lands in its target");
      assert.deepEqual(writes(ff), [{ "tile:10:group:a": edge,
        ...(dy > 0 ? { "tile:10:group:b": { x: 2, y: 27, w: 4, h: 2 } } : {}) }]);
    } finally { escape(); await flush(ff); }
  });
}

// All corners share the existing southeast pixel edge clamp, with no bottom
// limit. Clamping the origin without reducing size would shift the fixed edge.
for (const { corner, dx, dy } of corners) {
  test(`${corner} free box clamps to grid edges with its opposite corner fixed`, async () => {
    const { ff, root } = await setup(), node = tile(root), before = box(node);
    const start = down(node.querySelector(`[data-corner="${corner}"]`));
    try {
      pointer("pointermove", document, shifted(start, dx * 500, dy * 300));
      close(box(node).width, dx < 0 ? 560 : 752, "free width capped at columns");
      close(box(node).height, dy < 0 ? 560 : 668, "free height capped only at row zero");
      close(box(node).left, dx < 0 ? 0 : 192, "free left edge");
      close(box(node).top, dy < 0 ? 0 : 192, "free top edge");
      close(dx < 0 ? box(node).right : box(node).left, dx < 0 ? before.right : before.left, "fixed horizontal edge");
      close(dy < 0 ? box(node).bottom : box(node).top, dy < 0 ? before.bottom : before.top, "fixed vertical edge");
    } finally { escape(); await flush(ff); }
  });
}

// Literal neighbours touch the original moving corner but not the start tile.
// North/west growth must still reuse collision slides and held board updates.
for (const { corner, dx, dy, target } of corners) {
  for (const end of ["release", "Escape"]) {
    test(`${corner} neighbours preview only on target changes and updates stay held through ${end}`, async () => {
      const neighbour = { x: dx < 0 ? 0 : 6, y: dy < 0 ? 0 : 6, w: 2, h: 2 };
      const pushed = { ...neighbour, y: dy < 0 ? 6 : 7 };
      const { ff, root, control } = await setup({ neighbour }), node = tile(root), other = tile(root, "group:b");
      const start = down(node.querySelector(`[data-corner="${corner}"]`));
      try {
        pointer("pointermove", document, shifted(start, dx * 133, dy * 117));
        assert.deepEqual(rect(other), pushed, "the neighbour beside the moving corner is pushed");
        assert.equal(getComputedStyle(other).transitionDuration, "0.2s, 0.2s, 0.2s, 0.2s, 0.2s");
        const changes = [], observer = new MutationObserver(records => changes.push(...records));
        observer.observe(other, { attributes: true, attributeFilter: ["style"] });
        observer.observe(root.querySelector(".grid-corners"), { childList: true, subtree: true, attributes: true });
        try {
          pointer("pointermove", document, shifted(start, dx * 140, dy * 123)); await Promise.resolve();
          assert.equal(changes.length, 0, "same target leaves neighbours and dots untouched");
        } finally { observer.disconnect(); }
        await ff.browser.storage.sync.set({ settings: { transparency: "high", showClock: false, showPinned: false, showSaved: false } });
        await flush(ff); ff.calls.length = 0;
        assert.equal(tile(root), node); assert.equal(root.style.getPropertyValue("--card-alpha-dark"), "0.6");
        assert.equal(control.ui.gridDragging, true);
        pointer("pointermove", document, start);
        assert.deepEqual(rect(other), neighbour, "reversing restores the neighbour");
        const coords = shifted(start, dx * 133, dy * 117);
        pointer("pointermove", document, coords);
        assert.deepEqual(rect(other), pushed);
        if (end === "release") pointer("pointerup", document, coords); else escape();
        for (let i = 0; i < 6; i++) await Promise.resolve();
        assert.equal(control.ui.gridDragging, true, "remote render is held through settlement");
        assert.equal(tile(root), node);
        const expected = end === "Escape" ? [] : [{ "tile:10:group:a": target, "tile:10:group:b": pushed }];
        assert.deepEqual(writes(ff), expected, "save happens before the slide ends");
        await flush(ff);
        assert.equal(control.ui.gridDragging, false);
        assert.equal(root.style.getPropertyValue("--card-alpha-dark"), "0.45");
        assert.deepEqual(rect(tile(root, "group:b")), end === "release" ? pushed : neighbour);
        assert.deepEqual(writes(ff), expected);
      } finally { escape(); await flush(ff); }
    });
  }
}

// Rounding against the 96px preset instead of the fractional 96.423px pitch
// picks the wrong side of these half-cell boundaries for every corner.
for (const { corner, dx, dy, target } of corners) {
  test(`${corner} snaps both moving edges at the fractional half-cell boundary`, async () => {
    const { ff, root, control } = await setup({ width: 1237.5 }), node = tile(root);
    close(control.view.cell + 16, 1253.5 / 13, "stretched pitch");
    const start = down(node.querySelector(`[data-corner="${corner}"]`));
    try {
      pointer("pointermove", document, shifted(start, dx * 48.1, dy * 48.1));
      assert.deepEqual(rect(root.querySelector(".drop-outline")), original);
      pointer("pointermove", document, shifted(start, dx * 48.3, dy * 48.3));
      assert.deepEqual(rect(root.querySelector(".drop-outline")), target);
      pointer("pointerup", document, shifted(start, dx * 48.3, dy * 48.3)); await flush(ff);
      assert.deepEqual(rect(tile(root)), target);
    } finally { escape(); await flush(ff); }
  });

  test(`${corner} clock minimum is three columns from its fixed edge`, async () => {
    const { ff, root } = await setup({ widgets: true }), node = tile(root, "clock"), before = box(node);
    const start = down(node.querySelector(`[data-corner="${corner}"]`));
    try {
      pointer("pointermove", document, shifted(start, -dx * 2000, -dy * 2000));
      close(box(node).width, 272, "clock pixel minimum"); close(box(node).height, 176, "clock height minimum");
      close(dx < 0 ? box(node).right : box(node).left, dx < 0 ? before.right : before.left, "fixed clock edge");
      const expected = { x: dx < 0 ? 7 : 6, y: 0, w: 3, h: 2 };
      assert.deepEqual(rect(root.querySelector(".drop-outline")), expected);
      pointer("pointerup", document, shifted(start, -dx * 2000, -dy * 2000)); await flush(ff);
      assert.deepEqual(rect(tile(root, "clock")), expected);
      assert.deepEqual(writes(ff), [{ "tile:10:clock": expected }]);
    } finally { escape(); await flush(ff); }
  });

  test(`${corner} one-column grid caps its minimum without moving the opposite corner`, async () => {
    const { ff, root } = await setup({ width: 272 }), node = tile(root), before = box(node);
    assert.equal(controlCols(root), 1);
    const start = down(node.querySelector(`[data-corner="${corner}"]`));
    try {
      pointer("pointermove", document, shifted(start, -dx * 2000, -dy * 2000));
      close(box(node).width, 80, "one-column pixel minimum"); close(box(node).height, 176, "pixel minimum height");
      close(box(node).left, before.left, "capped minimum left"); close(box(node).right, before.right, "capped minimum right");
      const expected = { x: 0, y: dy < 0 ? 4 : 2, w: 1, h: 2 };
      assert.deepEqual(rect(root.querySelector(".drop-outline")), expected);
      pointer("pointerup", document, shifted(start, -dx * 2000, -dy * 2000)); await flush(ff);
      assert.deepEqual(rect(tile(root)), expected);
    } finally { escape(); await flush(ff); }
  });
}
function controlCols(root) { return Number(root.querySelector(".grid").style.getPropertyValue("--cols")); }
