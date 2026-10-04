import { test, assert, fixture, nextFrame } from "./harness.js";
import { renderBoard } from "./view.js";

let css;
async function draw(device, width, height = 320) {
  css ??= new Promise(resolve => {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/extension/newtab.css";
    link.onload = resolve; document.head.append(link);
  });
  await css; await document.fonts.ready;
  const root = document.createElement("div"); root.className = "board";
  root.style.cssText = `width:${width}px;height:${height}px;--row:${device.density === "compact" ? 24 : 32}px`;
  fixture().append(root);
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, windowId: 1, title: `Tab ${i + 1}` }));
  renderBoard(root, { columns: [], pinned: [], saved: [], missing: [], windowOrder: [1],
    tabs: [{ current: true, windowId: 1, rows }] }, {}, {}, { device,
    synced: { railCells: 2, showClock: false, showPinned: false, showSaved: false } });
  await nextFrame(); await nextFrame();
  return root;
}
function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= 0.5, `${message}: ${actual} vs ${expected}`);
}

// A zero or cell-based height floor either overlaps contents or overgrows the rail.
for (const [density, floor, rowHeight] of [["normal", 128, 32], ["compact", 112, 24]]) {
  for (const height of [56, 104]) {
    test(`${density} rail at requested height ${height} fits its title, one row and gear`, async () => {
      const root = await draw({ cellSize: "S", density }, 944, height);
      const rail = root.querySelector(".rail"), title = rail.querySelector(".column-title");
      const list = rail.querySelector(".rows"), first = list.querySelector(".row");
      const gear = rail.querySelector(".settings-gear").getBoundingClientRect();
      near(root.getBoundingClientRect().height, floor, "content-based board floor");
      near(rail.getBoundingClientRect().bottom, root.getBoundingClientRect().bottom, "rail fills the board");
      assert.ok(title.getBoundingClientRect().bottom <= first.getBoundingClientRect().top + 0.5,
        "the title does not cover the first row");
      assert.ok(list.getBoundingClientRect().height >= rowHeight - 0.5, "one full tab row fits");
      assert.ok(first.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom + 0.5,
        "the first tab is fully visible");
      near(list.getBoundingClientRect().bottom + 16, gear.top, "list ends above the gear");
      assert.ok(title.getBoundingClientRect().bottom <= gear.top, "gear never covers the title");
    });
  }
}

// A full title without clipping would push past the two-cell rail at either minimum target size.
for (const [name, device, width, railWidth] of [
  ["S", { cellSize: "S", density: "normal" }, 944, 112],
  ["custom 40", { cellSize: "custom", customCell: 40, density: "compact" }, 824, 96],
]) {
  test(`two-cell ${name} rail ellipsizes its heading and ends above the inset gear`, async () => {
    const root = await draw(device, width), rail = root.querySelector(".rail");
    const heading = rail.querySelector("h2"), list = rail.querySelector(".rows"), gear = rail.querySelector(".settings-gear");
    assert.equal(heading.textContent, "UNGROUPED TABS");
    near(rail.getBoundingClientRect().width, railWidth, "two target cells");
    assert.equal(getComputedStyle(heading).textOverflow, "ellipsis");
    assert.equal(getComputedStyle(heading).overflowX, "hidden");
    assert.equal(getComputedStyle(heading).whiteSpace, "nowrap");
    assert.ok(heading.scrollWidth > heading.clientWidth, "the full title is clipped at this width");
    assert.equal(rail.scrollWidth, rail.clientWidth, "heading does not overflow the rail");
    assert.ok(gear, "gear belongs to the rail, not a separate board cell");
    const box = rail.getBoundingClientRect(), g = gear.getBoundingClientRect();
    near(box.bottom, root.getBoundingClientRect().bottom, "full-height rail");
    near(g.right + 8, box.right, "padding inset right"); near(g.bottom + 8, box.bottom, "padding inset bottom");
    near(list.getBoundingClientRect().bottom + 16, g.top, "rows stop one gap above the gear");
    near(g.width, 32, "fixed gear width"); near(g.height, 32, "fixed gear height");
    assert.equal(getComputedStyle(gear).borderRadius, "50%");
    assert.equal(getComputedStyle(gear).boxShadow, "none");
    assert.equal(getComputedStyle(gear).borderTopWidth, "0px");
    assert.equal(list.hasAttribute("data-scroll-end"), true);
    assert.ok(getComputedStyle(list).maskImage.includes("24px"));
    list.scrollTop = list.scrollHeight;
    await nextFrame(); await nextFrame();
    assert.equal(list.hasAttribute("data-scroll-end"), false, "end fade clears at the last tab");
    assert.equal(list.hasAttribute("data-scroll-start"), true);
    near(list.lastElementChild.getBoundingClientRect().bottom, list.getBoundingClientRect().bottom, "last tab is fully reachable");
    near(gear.getBoundingClientRect().top, g.top, "scrolling does not move the gear");
  });
}
