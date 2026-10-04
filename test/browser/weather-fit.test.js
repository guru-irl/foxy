// Weather tile sizing: real text boxes (Range rects) against the element and
// the tile, for the sizes where the reading, the pills and the day bars are
// tightest. Cells: S (48 px), custom 40 to 43 px and custom 240 px.
import { test, assert, fixture } from "./harness.js";
import { forecastJson } from "../fakes/weather.js";
import { parseForecast } from "../../extension/src/weather/data.js";
import { weatherTile, renderWeather } from "../../extension/src/tiles/weather.js";

const NOW = (1790985600 - 3600 + 13 * 3600 + 1200) * 1000;
const ok = (json = {}) => ({ status: "ok", stale: false, want: "auto", key: "53.35,-6.27", place: "Dublin",
  fetchedAt: NOW, data: parseForecast(forecastJson(json)) });

let css;
async function styles() {
  css ??= new Promise(resolve => {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/extension/newtab.css";
    link.onload = resolve; document.head.append(link);
  });
  await css; await document.fonts.ready;
}

const shown = node => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden"
  && getComputedStyle(node).display !== "none";

/** Tiles of w x h cells, painted with `state`; removed by the harness fixture. */
async function tiles(cell, sizes, state, settings = {}, scheme = "dark") {
  await styles();
  const host = document.createElement("div");
  host.style.cssText = `position:relative;width:4000px;height:3000px;color-scheme:${scheme}`;
  fixture().append(host);
  return sizes.map(([w, h]) => {
    const node = weatherTile(); node.classList.add("tile");
    node.style.cssText = `position:absolute;left:0;top:0;width:${w * cell + (w - 1) * 16}px;height:${h * cell + (h - 1) * 16}px`;
    host.append(node);
    renderWeather(node, state, settings, NOW);
    return [`${w}x${h}@${cell}`, node];
  });
}

// Every shown element inside the tile; every text run inside its element's
// content box (no clipping, no ellipsis, no spill).
function problems(tile, label) {
  const out = [], box = tile.getBoundingClientRect();
  for (const node of tile.querySelectorAll(".weather-body *")) {
    if (!shown(node) || node.closest(".weather-hours > *") || (node.closest("svg") && node.tagName !== "svg")) continue;
    const r = node.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const name = node.className.baseVal ?? node.className;
    if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) {
      out.push(`${label} OUT .${name} (${Math.round(r.left - box.left)},${Math.round(r.top - box.top)},${Math.round(r.right - box.left)},${Math.round(r.bottom - box.top)}) of ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
    const cs = getComputedStyle(node);
    const left = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
    const right = r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
    for (const child of node.childNodes) {
      if (child.nodeType !== 3 || !child.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(child);
      const rects = [...range.getClientRects()];
      if (rects.some(t => t.right > right + 0.05 || t.left < left - 0.05)) {
        out.push(`${label} TEXT .${name} "${child.textContent}" ${(Math.max(...rects.map(t => t.right)) - Math.min(...rects.map(t => t.left))).toFixed(1)} in ${(right - left).toFixed(1)}`);
      }
      if (rects.some(t => t.left < box.left - 0.5 || t.right > box.right + 0.5 || t.top < box.top - 0.5 || t.bottom > box.bottom + 0.5)) {
        out.push(`${label} TEXT OUT OF TILE .${name} "${child.textContent}"`);
      }
    }
  }
  return out;
}

/** The text a reader sees in `node`: text runs that are laid out. */
function visibleText(node) {
  const parts = [];
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const range = document.createRange(); range.selectNodeContents(walker.currentNode);
    if (range.getClientRects().length) parts.push(walker.currentNode.textContent);
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

const tall3 = [5, 6, 7, 8, 9, 10, 11, 12].map(h => [3, h]);

test("tall tiles 260 to 300 px wide (5 columns at 40 px) stack the summary and fit", async () => {
  const found = [];
  for (const [state, settings] of [[ok(), {}], [ok({ temp: 38.4 }), { tempUnit: "F" }], [ok({ temp: -12.6 }), {}]]) {
    for (const [label, node] of await tiles(40, [[5, 5], [5, 8], [5, 9], [5, 12]], state, settings)) {
      found.push(...problems(node, label).filter(line => !/weather-place/.test(line)));
    }
  }
  assert.ok(!found.length, found.join("\n"));
}, { timeout: 20000 });

for (const cell of [48, 40, 240]) {
  test(`the temperature fits 3-column tiles 5 to 12 rows tall at cell ${cell}: 14° and 101°F`, async () => {
    const found = [];
    for (const [state, settings, text] of [[ok(), {}, "14°"], [ok({ temp: 38.4 }), { tempUnit: "F" }, "101°"], [ok({ temp: -12.6 }), {}, "-13°"]]) {
      for (const [label, node] of await tiles(cell, tall3, state, settings)) {
        assert.equal(node.querySelector(".weather-temp").textContent, text);
        found.push(...problems(node, `${label} ${text}`).filter(line => !/weather-place/.test(line)));
      }
    }
    assert.ok(!found.length, found.join("\n"));
  }, { timeout: 20000 });
}

test("the temperature scales with the tile width below 260 px; wide tiles keep the full size", async () => {
  const [[, narrow], [, wide]] = await tiles(48, [[3, 6], [6, 6]], ok());
  assert.ok(parseFloat(getComputedStyle(narrow.querySelector(".weather-temp")).fontSize) < 56);
  assert.equal(getComputedStyle(wide.querySelector(".weather-temp")).fontSize, "56px");
  // Medium tier too: 101°F with the glyph at the narrowest medium widths.
  const found = [];
  for (const cell of [48, 40, 43]) {
    for (const [label, node] of await tiles(cell, [[3, 2], [3, 3], [3, 4], [4, 2], [4, 3]], ok({ temp: 38.4 }), { tempUnit: "F" })) {
      found.push(...problems(node, label).filter(line => !/weather-place/.test(line)));
    }
  }
  assert.ok(!found.length, found.join("\n"));
}, { timeout: 20000 });

test("below 80 px wide RETRY is a small round icon button labelled Retry; wider tiles keep the RETRY pill", async () => {
  const found = [];
  for (const cell of [48, 40]) {
    for (const [label, node] of await tiles(cell, [[1, 1], [1, 2], [1, 3], [1, 8]], { status: "error", want: "auto" })) {
      const retry = node.querySelector("button.weather-retry");
      assert.equal(retry.getAttribute("aria-label"), "Retry");
      const box = retry.getBoundingClientRect();
      assert.ok(Math.abs(box.width - box.height) < 0.5 && box.width <= 28, `${label} round: ${box.width}x${box.height}`);
      assert.equal(getComputedStyle(retry).borderRadius, "50%");
      assert.ok(shown(retry.querySelector("svg.weather-retry-glyph")), `${label} shows the retry glyph`);
      assert.equal(visibleText(retry), "", `${label} shows no text`);
      found.push(...problems(node, label));
    }
  }
  for (const [label, node] of await tiles(48, [[2, 2], [5, 5]], { status: "error", want: "auto" })) {
    const retry = node.querySelector("button.weather-retry");
    assert.equal(visibleText(retry), "RETRY", label);
    assert.ok(!shown(retry.querySelector("svg")), `${label} has no glyph`);
    assert.equal(getComputedStyle(retry).borderRadius, "999px");
    found.push(...problems(node, label));
  }
  assert.ok(!found.length, found.join("\n"));
});

test("narrow Allow pill: the word Allow under a small cloud, labelled Allow weather; the text always fits", async () => {
  const found = [];
  for (const cell of [48, 40, 41, 42, 43]) {
    for (const [label, node] of await tiles(cell, [[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [3, 1], [3, 2], [5, 5]], { status: "consent", want: "auto" })) {
      const allow = node.querySelector("button.weather-allow");
      assert.ok(shown(allow), `${label} shows the pill`);
      assert.equal(allow.getAttribute("aria-label"), "Allow weather");
      const narrow = node.getBoundingClientRect().width < 100;
      assert.equal(visibleText(allow), narrow ? "Allow" : "Allow weather", label);
      assert.equal(shown(allow.querySelector("svg.weather-allow-glyph")), narrow, `${label} cloud glyph only when narrow`);
      assert.equal(getComputedStyle(allow).borderRadius, "999px");
      for (const part of [allow, ...allow.querySelectorAll("*")]) assert.equal(getComputedStyle(part).textOverflow, "clip");
      found.push(...problems(node, label));
    }
  }
  assert.ok(!found.length, found.join("\n"));
}, { timeout: 20000 });

test("daily range bars keep a visible width in 3-column tiles and day names do not spill", async () => {
  const found = [];
  for (const cell of [48, 40]) {
    // From 460 px tall: 8 rows at S, 9 at 40 px.
    for (const [label, node] of await tiles(cell, (cell === 48 ? [8, 9, 10, 12] : [9, 10, 12]).map(h => [3, h]), ok({ temp: 38.4 }), { tempUnit: "F" })) {
      assert.ok(shown(node.querySelector(".weather-days")), `${label} shows the days`);
      const bars = [...node.querySelectorAll(".weather-bar")];
      assert.equal(bars.length, 7);
      for (const bar of bars) assert.ok(bar.getBoundingClientRect().width >= 20, `${label} bar ${bar.getBoundingClientRect().width}px`);
      found.push(...problems(node, label).filter(line => !/weather-place/.test(line)));
    }
  }
  assert.ok(!found.length, found.join("\n"));
});
