import { test, assert, fixture } from "./harness.js";

async function clock() {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/extension/newtab.css";
  await new Promise(resolve => { link.onload = resolve; document.head.append(link); });
  const time = document.createElement("time");
  time.className = "clock-time";
  fixture().append(time);
  const main = await import("../../extension/src/main.js");
  assert.equal(typeof main.renderTime, "function", "clock renderer must expose an independently positionable colon");
  return { time, renderTime: main.renderTime };
}

test("clock size reaches the calibrated clamp ends in actual Firefox viewports", async () => {
  for (const [width, expectedSize] of [[800, 96.8], [1600, 176]]) {
    const frame = document.createElement("iframe");
    frame.style.cssText = `width:${width}px;height:300px;border:0`;
    frame.srcdoc = '<link rel="stylesheet" href="/extension/newtab.css"><time class="clock-time">0124</time>';
    await new Promise(resolve => { frame.onload = resolve; fixture().append(frame); });
    try {
      await frame.contentDocument.fonts.load(`600 ${expectedSize}px "Foxy Serif"`);
      const time = frame.contentDocument.querySelector("time");
      assert.ok(Math.abs(parseFloat(frame.contentWindow.getComputedStyle(time).fontSize) - expectedSize) < 0.1);
      const widths = [...time.textContent].map((_, i) => {
        const range = frame.contentDocument.createRange();
        range.setStart(time.firstChild, i); range.setEnd(time.firstChild, i + 1);
        return range.getBoundingClientRect().width;
      });
      assert.ok(Math.max(...widths) - Math.min(...widths) < 0.05, "lining digits need equal tabular advances");
    } finally { frame.remove(); }
  }
});

test("clock updates preserve the formatted time while isolating its centred colon", async () => {
  const { time, renderTime } = await clock();
  for (const value of ["12:24", "14:54", "02:04", "23:59"]) {
    renderTime(time, value);
    assert.equal(time.textContent, value);
    assert.equal(time.dataset.lead, value[0]);
    assert.deepEqual([...time.children].map(child => child.textContent), [value.slice(0, 2), ":", value.slice(3)]);
    assert.equal(time.querySelectorAll(".clock-colon").length, 1, "ticks must not accumulate colons");
  }
});

test("clock uses bundled semibold upright lining tabular figures and an independently raised colon", async () => {
  const { time, renderTime } = await clock();
  renderTime(time, "12:24");
  await document.fonts.load('600 176px "Foxy Serif"');
  assert.ok(document.fonts.check('600 176px "Foxy Serif"'));
  const style = getComputedStyle(time);
  assert.equal(style.fontFamily, '"Foxy Serif", serif');
  assert.equal(style.fontWeight, "600");
  assert.equal(style.fontStyle, "normal");
  assert.equal(style.fontVariantNumeric, "lining-nums tabular-nums");
  const colon = getComputedStyle(time.querySelector(".clock-colon"));
  assert.equal(colon.display, "inline-block");
  assert.equal(colon.textIndent, "0px", "the lead-digit correction must not distort the colon slot");
  for (const size of [96.8, 176]) {
    time.style.fontSize = `${size}px`;
    const shift = new DOMMatrix(getComputedStyle(time.querySelector(".clock-colon")).transform);
    assert.ok(shift.m41 >= 0.35 && shift.m41 <= 0.8, "equal colon ink bearings need the measured subpixel rightward correction");
    assert.ok(Math.abs(shift.m42 + size * 0.134) < 0.1, "colon ink must keep its measured digit-midpoint correction");
  }
});
