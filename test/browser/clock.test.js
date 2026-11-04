import { test, assert, fixture, nextFrame } from "./harness.js";
import { renderBoard } from "./view.js";
import { DEFAULT_SETTINGS, DEFAULT_DEVICE } from "../../extension/src/settings/store.js";

async function clock(w = 3, h = 2, cell = 80) {
  const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/extension/newtab.css";
  await new Promise(resolve => { link.onload = resolve; document.head.append(link); });
  const node = document.createElement("div"); node.className = "board"; node.style.cssText = "width:1600px;height:700px";
  fixture().append(node);
  const { updateClock, renderTime } = await import("../../extension/src/main.js");
  renderBoard(node, { columns: [], pinned: [], tabs: [], saved: [] }, {}, {}, {
    boxes: [{ id: "clock", width: w * ((cell === "S" ? 48 : cell) + 16) - 16, height: h * ((cell === "S" ? 48 : cell) + 16) - 16 }], device: { ...DEFAULT_DEVICE, cellSize: cell === "S" ? "S" : "custom", customCell: cell === "S" ? 80 : cell },
  });
  await document.fonts.ready; await nextFrame();
  return { node, time: node.querySelector(".clock-time"), date: node.querySelector(".clock-date"), updateClock, renderTime };
}

const sizes = ["S", 80, 112, 144].flatMap(cell => [[3, 2], [5, 2], [3, 3]].map(([w, h]) => [cell, w, h]));
sizes.push([80, 8, 4]);
for (const [cell, w, h] of sizes) {
  test(`clock tile ${cell} ${w}x${h}: time and longest date fit all padded content edges`, async () => {
    const { node, time, date, updateClock } = await clock(w, h, cell);
    for (const format of ["24", "12"]) {
      for (const hour of [0, 1, 12, 23]) {
        updateClock(node, { ...DEFAULT_SETTINGS, timeFormat: format }, new Date(2026, 8, 30, hour, 59));
        const tile = time.closest(".tile"), bounds = tile.getBoundingClientRect();
        const style = getComputedStyle(tile);
        for (const side of ["Top", "Right", "Bottom", "Left"]) assert.equal(style[`padding${side}`], "16px");
        assert.equal(date.textContent, "WEDNESDAY, 30 SEPTEMBER");
        const content = { left: bounds.left + 16, right: bounds.right - 16, top: bounds.top + 16, bottom: bounds.bottom - 16 };
        for (const element of [time, date].filter(element => getComputedStyle(element).display !== "none")) {
          const range = document.createRange(); range.selectNodeContents(element);
          const text = range.getBoundingClientRect();
          assert.ok(text.left >= content.left - 0.5 && text.right <= content.right + 0.5,
            `${element.className} must fit horizontally: ${element.textContent}`);
          // Range.top includes the font's unused ascent above the line box.
          assert.ok(element.getBoundingClientRect().top >= content.top - 0.5 && text.bottom <= content.bottom + 0.5,
            `${element.className} must fit vertically: ${element.textContent}`);
        }
        assert.ok(parseFloat(getComputedStyle(time).fontSize) <= (tile.clientHeight - 32) * 0.7 + 0.5);
        assert.ok(parseFloat(getComputedStyle(time).fontSize) > 20, "time must scale, not remain a small fixed label");
      }
    }
    assert.equal(getComputedStyle(time.closest(".tile")).containerType, "size");
  });
}

// The final reviewer's minimum-clock probe measured a 6.9 px S date.
// Missing either width or height guard leaves an unreadable label visible.
for (const [cell, w, h, visible] of [["S", 3, 2, false], ["S", 3, 3, false], ["S", 5, 2, false],
  ["S", 5, 3, true], [80, 3, 2, true], [144, 3, 2, true]]) {
  test(`clock ${cell} ${w}x${h} ${visible ? "shows a readable date" : "hides the date below 10 px"} and keeps time`, async () => {
    const { node, time, date, updateClock } = await clock(w, h, cell);
    for (const format of ["24", "12"]) {
      updateClock(node, { ...DEFAULT_SETTINGS, timeFormat: format }, new Date(2026, 8, 30, 23, 59));
      assert.equal(getComputedStyle(date).display !== "none", visible);
      assert.equal(date.textContent, "WEDNESDAY, 30 SEPTEMBER");
      if (visible) assert.ok(parseFloat(getComputedStyle(date).fontSize) >= 10, "visible date must be readable");
      else assert.equal(date.getBoundingClientRect().height, 0, "hidden date takes no space");
      assert.equal(getComputedStyle(time).display, "block");
      assert.ok(time.getBoundingClientRect().height > 20, "time stays visible");
      assert.equal(time.textContent, format === "24" ? "23:59" : "11:59 PM");
    }
  });
}

test("clock updates retain the formatted time and isolate its colon", async () => {
  const { time, renderTime } = await clock();
  for (const value of ["12:24", "14:54", "02:04", "23:59", "1:05 PM", "12:05 AM"]) {
    renderTime(time, value);
    assert.equal(time.textContent, value);
    assert.equal(time.hasAttribute("data-lead"), false, "clock text needs no unused first-digit styling hook");
    const [hours, minutes] = value.split(":");
    assert.deepEqual([...time.children].map(child => child.textContent), [hours, ":", minutes]);
    assert.equal(time.querySelectorAll(".clock-colon").length, 1);
    assert.equal(time.getAttribute("aria-label"), value);
  }
});

test("clock settings show 13:05 or 1:05 PM, an ISO time value, and an optional Sans date", async () => {
  const { node, time, date, updateClock } = await clock();
  const now = new Date(2026, 9, 3, 13, 5);
  updateClock(node, DEFAULT_SETTINGS, now);
  assert.equal(time.textContent, "13:05"); assert.equal(time.getAttribute("datetime"), "13:05");
  assert.equal(date.textContent, "SATURDAY, 3 OCTOBER"); assert.equal(date.hidden, false);
  assert.ok(getComputedStyle(date).fontFamily.includes("Foxy Sans"));
  updateClock(node, { ...DEFAULT_SETTINGS, timeFormat: "12", showDate: false }, now);
  assert.equal(time.textContent, "1:05 PM"); assert.equal(time.getAttribute("datetime"), "13:05"); assert.equal(date.hidden, true);
  for (const [hour, text] of [[0, "12:05 AM"], [12, "12:05 PM"]]) {
    updateClock(node, { ...DEFAULT_SETTINGS, timeFormat: "12" }, new Date(2026, 9, 3, hour, 5)); assert.equal(time.textContent, text);
  }
});

test("clock uses bundled bold upright lining tabular figures and the raised colon", async () => {
  const { time, renderTime } = await clock(); renderTime(time, "12:24");
  const style = getComputedStyle(time);
  // Firefox 159 drops the quotes from computed family names; compare without them.
  assert.equal(style.fontFamily.replaceAll('"', ""), "Foxy Serif, serif"); assert.equal(style.fontWeight, "700");
  assert.equal(style.fontStyle, "normal"); assert.equal(style.fontVariantNumeric, "lining-nums tabular-nums");
  assert.equal(style.whiteSpace, "nowrap");
  const colon = getComputedStyle(time.querySelector(".clock-colon"));
  assert.equal(colon.display, "inline-block"); assert.equal(colon.textIndent, "0px");
  const shift = new DOMMatrix(colon.transform), size = parseFloat(style.fontSize);
  assert.ok(Math.abs(shift.m42 + size * 0.134) < 0.1);
  const range = document.createRange(); const widths = [];
  time.textContent = "0124";
  for (let i = 0; i < 4; i++) { range.setStart(time.firstChild, i); range.setEnd(time.firstChild, i + 1); widths.push(range.getBoundingClientRect().width); }
  assert.ok(Math.max(...widths) - Math.min(...widths) < 0.05);
});
