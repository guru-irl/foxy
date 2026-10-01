import { test, assert, fixture, nextFrame, dispatchDrag } from "./harness.js";
import { renderBoard, updateScrollEdges } from "../../extension/src/board/render.js";

let css;
async function draw({ width = 900, height = 180, groups = 3, count = 20 } = {}, handlers = {}) {
  css ??= new Promise(resolve => {
    const link = document.createElement("link"); link.rel = "stylesheet";
    link.href = "/extension/newtab.css"; link.onload = resolve; document.head.append(link);
  });
  await css;
  const root = document.createElement("div"); root.className = "board";
  root.style.cssText = `width:${width}px;height:${height}px`;
  fixture().append(root);
  const rows = Array.from({ length: count }, (_, i) => ({ id: i + 1, windowId: 1, title: `Tab ${i}`, url: "https://example.com/" }));
  const sections = [{ current: true, windowId: 1, rows }];
  const model = { pinned: sections, tabs: sections,
    columns: Array.from({ length: groups }, (_, i) => ({ id: 101 + i, windowId: 1, current: true, title: `Group ${i}`, color: "gray", apiColor: "grey", rows })),
    saved: Array.from({ length: count }, (_, i) => ({ folderId: `saved-${i}`, title: `Saved ${i}`, count: 1, color: "gray", cantReopen: [] })),
    missing: [], windowOrder: [1] };
  renderBoard(root, model, { editGroupId: null }, handlers);
  await nextFrame(); await nextFrame();
  return { root, model };
}

function edges(el, start, end) {
  assert.equal(el.hasAttribute("data-scroll-start"), start, `${el.className} start edge`);
  assert.equal(el.hasAttribute("data-scroll-end"), end, `${el.className} end edge`);
  const mask = getComputedStyle(el).maskImage;
  if (start || end) {
    assert.ok(mask.includes("linear-gradient"), "scroll hints must mask the content, not paint an overlay");
    assert.ok(mask.includes("24px"), "fade must cover 24px");
  } else assert.equal(mask, "none", "unscrollable content must not be masked");
  assert.equal(getComputedStyle(el).boxShadow, "none");
}

async function scroll(el, axis, value) {
  el[axis] = value;
  await nextFrame(); await nextFrame();
}

test("horizontal strip fades only the edges with hidden content and clears on resize", async () => {
  const { root } = await draw(); const strip = root.querySelector(".strip");
  edges(strip, false, true);
  await scroll(strip, "scrollLeft", 100); edges(strip, true, true);
  await scroll(strip, "scrollLeft", strip.scrollWidth); edges(strip, true, false);
  await scroll(strip, "scrollLeft", 0); edges(strip, false, true);
  root.style.width = "2400px";
  await nextFrame(); await nextFrame(); edges(strip, false, false);
  root.style.width = "900px";
  await nextFrame(); await nextFrame(); edges(strip, false, true);
});

for (const selector of ['.rows[data-zone="pinned"]', '.rows[data-zone="tabs"]', '.rows[data-zone="group"]', '.rows[data-zone="saved"]']) {
  test(`${selector} fades top and bottom only while more rows are hidden`, async () => {
    const { root } = await draw(); const rows = root.querySelector(selector);
    edges(rows, false, true);
    await scroll(rows, "scrollTop", 64); edges(rows, true, true);
    await scroll(rows, "scrollTop", rows.scrollHeight); edges(rows, true, false);
    await scroll(rows, "scrollTop", 0); edges(rows, false, true);
    root.style.height = "1000px";
    await nextFrame(); await nextFrame(); edges(rows, false, false);
  });
}

test("even one pixel of hidden row content gets an edge hint", async () => {
  const { root } = await draw({ height: 1000 });
  const rows = root.querySelector('.rows[data-zone="pinned"]');
  rows.style.flex = "none";
  rows.style.height = `${rows.scrollHeight - 1}px`;
  await nextFrame(); await nextFrame();
  assert.equal(rows.scrollHeight - rows.clientHeight, 1);
  edges(rows, false, true);
  await scroll(rows, "scrollTop", 1); edges(rows, true, false);
});

for (const [selector, axis, dimension] of [[".rows[data-zone='pinned']", "scrollTop", "height"], [".strip", "scrollLeft", "width"]]) {
  test(`${dimension} with a fractional container size clears the end fade at the scroll maximum`, async () => {
    const { root } = await draw({ height: 600 });
    // Fractional scaling reproduces Firefox's subpixel scroll maximum on a
    // 1x headless display, as on a zoomed or scaled user display.
    root.style.zoom = "1.25";
    const container = root.querySelector(selector);
    container.style.flex = "none";
    container.style[dimension] = "300.4px";
    await nextFrame(); await nextFrame();
    edges(container, false, true);
    await scroll(container, axis, 10000);
    edges(container, true, false);
  });
}

test("scroll edge refresh reads every container before writing any edge attributes", async () => {
  const { root } = await draw();
  const containers = [...root.querySelectorAll(".strip, .rows")];
  const operations = [];
  const properties = ["scrollLeft", "scrollTop", "scrollWidth", "clientWidth", "scrollHeight", "clientHeight"];
  try {
    for (const node of containers) {
      for (const property of properties) {
        let prototype = node, descriptor;
        while (!(descriptor = Object.getOwnPropertyDescriptor(prototype, property))) prototype = Object.getPrototypeOf(prototype);
        Object.defineProperty(node, property, { configurable: true, get() {
          operations.push("read"); return descriptor.get.call(this);
        } });
      }
      node.toggleAttribute = function (...args) {
        operations.push("write"); return Element.prototype.toggleAttribute.apply(this, args);
      };
    }
    updateScrollEdges(root);
    assert.equal(operations.filter(op => op === "read").length, containers.length * 3);
    assert.equal(operations.filter(op => op === "write").length, containers.length * 2);
    assert.ok(operations.lastIndexOf("read") < operations.indexOf("write"), "geometry must be batched before attribute writes");
  } finally {
    for (const node of containers) {
      for (const property of properties) delete node[property];
      delete node.toggleAttribute;
    }
  }
});

for (const sourceSelector of [".row", ".column-header"]) {
  test(`dragging a ${sourceSelector} disables all scroll masks until dragend`, async () => {
    const states = [];
    const { root } = await draw({}, { onDragState: active => states.push(active) });
    const containers = [...root.querySelectorAll(".strip, .rows")];
    const before = containers.map(node => getComputedStyle(node).maskImage);
    assert.ok(before.every(mask => mask.includes("linear-gradient")));
    const source = root.querySelector(sourceSelector);
    const dataTransfer = new DataTransfer();
    dispatchDrag("dragstart", source, { dataTransfer });
    try {
      assert.deepEqual(states, [true]);
      for (const node of containers) assert.equal(getComputedStyle(node).maskImage, "none", "drop lines must not be faded during drag");
    } finally { dispatchDrag("dragend", source, { dataTransfer }); }
    assert.deepEqual(states, [true, false]);
    assert.deepEqual(containers.map(node => getComputedStyle(node).maskImage), before);
  });
}

test("short lists and a fitting strip never acquire a fade", async () => {
  const { root } = await draw({ width: 1800, height: 600, groups: 1, count: 1 });
  for (const el of root.querySelectorAll(".strip, .rows")) edges(el, false, false);
});

test("new render recalculates fades instead of retaining old edge states", async () => {
  const { root, model } = await draw();
  const old = root.querySelector(".strip"); await scroll(old, "scrollLeft", 100);
  renderBoard(root, { ...model, columns: [] }, { editGroupId: null }, {});
  root.style.width = "1800px"; root.style.height = "1000px";
  await nextFrame(); await nextFrame();
  for (const el of root.querySelectorAll(".strip, .rows")) edges(el, false, false);
});

test("masked scrolled rows still accept a drag and show its insertion line", async () => {
  const drops = []; const { root } = await draw({}, { onTabDrop: (...args) => drops.push(args) });
  const list = root.querySelector('.rows[data-zone="pinned"]');
  await scroll(list, "scrollTop", 64); edges(list, true, true);
  const row = list.querySelector('[data-tab-id="4"]'), r = row.getBoundingClientRect();
  const dataTransfer = new DataTransfer(); dataTransfer.setData("application/x-foxy-tab", "10");
  const over = dispatchDrag("dragover", row, { dataTransfer, clientX: r.left + 20, clientY: r.top + 8 });
  assert.ok(over.defaultPrevented);
  const line = list.querySelector(".drop-line"); assert.ok(line);
  assert.equal(getComputedStyle(line).pointerEvents, "none");
  assert.equal(line.getBoundingClientRect().height, 2);
  dispatchDrag("drop", row, { dataTransfer, clientX: r.left + 20, clientY: r.top + 8 });
  assert.deepEqual(drops, [[10, { zone: "pinned", slot: 3, tabId: 10 }]]);
  assert.equal(list.querySelector(".drop-line"), null);
});

for (const [scheme, expected] of [["dark", "rgba(22, 22, 24, 0.6)"], ["light", "rgba(246, 246, 247, 0.7)"]]) {
  test(`glass cards have the requested ${scheme} transparency`, async () => {
    const { root } = await draw(); root.style.colorScheme = scheme;
    assert.equal(getComputedStyle(root.querySelector(".column")).backgroundColor, expected);
  });
}
