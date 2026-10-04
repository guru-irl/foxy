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

// One left-aligned column (3.3.1): place, reading, summary, details, hours, days.

/** The user's reading: Yelahanka, 23°, overcast, 30° / 21°, feels like 25°, wind 8 km/h, humidity 84 %. */
function yelahanka() {
  const json = forecastJson();
  Object.assign(json.current, { temperature_2m: 23.2, apparent_temperature: 25.1, weather_code: 3, wind_speed_10m: 8.2,
    relative_humidity_2m: 84, precipitation: 0 });
  json.daily.temperature_2m_max[0] = 30.1; json.daily.temperature_2m_min[0] = 21.2;
  return { ...ok(), place: "Yelahanka", data: parseForecast(json) };
}

/** Tiles of exact pixel sizes. */
async function boxes(sizes, state = ok(), settings = {}) {
  await styles();
  const host = document.createElement("div");
  host.style.cssText = "position:relative;width:4000px;height:3000px;color-scheme:dark";
  fixture().append(host);
  return sizes.map(([w, h]) => {
    const node = weatherTile(); node.classList.add("tile");
    node.style.cssText = `position:absolute;left:0;top:0;width:${w}px;height:${h}px`;
    host.append(node);
    renderWeather(node, state, settings, NOW);
    return [`${w}x${h}px`, node];
  });
}

const SECTIONS = ["top", "now", "summary", "details", "hours", "days"];
const sections = node => SECTIONS.map(name => [name, node.querySelector(`.weather-${name}`)]).filter(([, part]) => shown(part));
const names = node => sections(node).map(([name]) => name).join(" ");

/** The tile's content box: inside the body's padding. */
function content(node) {
  const body = node.querySelector(".weather-body"), r = body.getBoundingClientRect(), cs = getComputedStyle(body);
  return { left: r.left + parseFloat(cs.paddingLeft), right: r.right - parseFloat(cs.paddingRight),
    top: r.top + parseFloat(cs.paddingTop), bottom: r.bottom - parseFloat(cs.paddingBottom) };
}

/** The right edge of the laid-out text inside `node`. */
function textRight(node) {
  let right = -Infinity;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const range = document.createRange(); range.selectNodeContents(walker.currentNode);
    for (const rect of range.getClientRects()) right = Math.max(right, rect.right);
  }
  return right;
}

test("the user's 5 x 4 tile at S shows the hourly strip, fully inside the tile; 4 x 4 too", async () => {
  for (const [label, node] of await tiles(48, [[5, 4], [4, 4]], yelahanka())) {
    const strip = node.querySelector(".weather-hours");
    assert.ok(shown(strip), `${label} shows the strip: ${names(node)}`);
    const r = strip.getBoundingClientRect(), box = content(node);
    assert.ok(r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5,
      `${label} strip (${r.left},${r.top},${r.right},${r.bottom}) inside (${box.left},${box.top},${box.right},${box.bottom})`);
    assert.ok(shown(node.querySelector(".weather-summary")), `${label} keeps the summary`);
    const found = problems(node, label);
    assert.ok(!found.length, found.join("\n"));
  }
});

test("summary and details start at the place's left edge, as one column", async () => {
  const all = [...await tiles(48, [[5, 4], [5, 6], [6, 10]], yelahanka()), ...await tiles(120, [[2, 2], [3, 3], [3, 4]], yelahanka())];
  for (const [label, node] of all) {
    const left = node.querySelector(".weather-place").getBoundingClientRect().left;
    for (const name of ["now", "summary", "details", "hours"]) {
      const part = node.querySelector(`.weather-${name}`);
      if (name === "summary" || (name === "details" && !/5x4@48|2x2@120/.test(label))) assert.ok(shown(part), `${label} shows .weather-${name}`);
      if (!shown(part)) continue;
      const at = part.getBoundingClientRect().left;
      assert.ok(Math.abs(at - left) <= 0.5, `${label} .weather-${name} left ${at} vs place ${left}`);
    }
    // The condition is the first thing on its line.
    const condition = node.querySelector(".weather-condition").getBoundingClientRect().left;
    assert.ok(Math.abs(condition - left) <= 0.5, `${label} condition left ${condition} vs place ${left}`);
  }
});

test("nothing in the summary or the reading is right-aligned against the tile", async () => {
  const all = [...await tiles(48, [[5, 3], [5, 4], [5, 6], [6, 10], [8, 4]], yelahanka()), ...await tiles(120, [[2, 2], [3, 3]], yelahanka())];
  for (const [label, node] of all) {
    const box = content(node);
    for (const name of ["summary", "now", "details"]) {
      const part = node.querySelector(`.weather-${name}`);
      if (!shown(part)) continue;
      const cs = getComputedStyle(part);
      assert.ok(!["right", "end"].includes(cs.textAlign), `${label} .weather-${name} text-align ${cs.textAlign}`);
      assert.ok(!["flex-end", "end", "right", "space-between"].includes(cs.justifyContent), `${label} .weather-${name} justify-content ${cs.justifyContent}`);
      assert.ok(textRight(part) < box.right - 8, `${label} .weather-${name} text ends at ${textRight(part)}, pinned to ${box.right}`);
    }
    // Feels like moved to the details line.
    assert.equal(node.querySelector(".weather-summary").textContent.includes("Feels"), false, label);
  }
});

test("the summary reads condition, high / low and the details start with feels like", async () => {
  const [[, node]] = await tiles(48, [[5, 6]], yelahanka());
  assert.equal(visibleText(node.querySelector(".weather-summary")), "Overcast · 30° / 21°");
  assert.equal(visibleText(node.querySelector(".weather-details")), "Feels like 25° · Wind 8 km/h · Humidity 84 %");
  const muted = getComputedStyle(node.querySelector(".weather-lo")).color, text = getComputedStyle(node.querySelector(".weather-hi")).color;
  assert.ok(muted !== text, "the low is muted");
  assert.equal(getComputedStyle(node.querySelector(".weather-condition")).color, text, "the condition is in the text colour");
});

test("consecutive sections are evenly spaced; spare height collects at the bottom", async () => {
  const all = [...await tiles(48, [[3, 3], [4, 4], [5, 3], [5, 4], [5, 5], [5, 6], [6, 8], [6, 10], [3, 8], [10, 12]], yelahanka()),
    ...await tiles(120, [[2, 2], [3, 3], [3, 4]], yelahanka()), ...await tiles(40, [[4, 3], [5, 5], [5, 9]], yelahanka())];
  for (const [label, node] of all) {
    const parts = sections(node).map(([name, part]) => [name, part.getBoundingClientRect()]);
    const gaps = parts.slice(1).map(([name, r], i) => [`${parts[i][0]}>${name}`, r.top - parts[i][1].bottom]);
    assert.ok(gaps.length >= 2, `${label} has sections: ${names(node)}`);
    for (const [pair, gap] of gaps) assert.ok(Math.abs(gap - gaps[0][1]) <= 1, `${label} ${pair} gap ${gap} vs ${gaps[0][0]} ${gaps[0][1]}`);
    const box = content(node);
    assert.ok(Math.abs(parts[0][1].top - box.top) <= 0.5, `${label} starts at the top`);
    if (!parts.some(([name]) => name === "days")) assert.ok(parts.at(-1)[1].bottom <= box.bottom + 0.5, `${label} ends inside`);
  }
});

test("as the height shrinks, the details hide first, then the strip, then the summary", async () => {
  const found = [], bounds = {};
  // Every third height, plus each step and the pixel below it.
  const steps = [110, 142, 158, 236, 252, 264, 280, 360, 376, 388, 404, 416, 432, 444, 460, 472, 488];
  const heights = [...new Set([...Array.from({ length: 134 }, (_, i) => 100 + 3 * i), ...steps, ...steps.map(h => h - 1)])].sort((a, b) => a - b);
  for (const width of [176, 240, 304, 600]) {
    const nodes = await boxes(heights.map(h => [width, h]), yelahanka());
    for (const [label, node] of nodes) {
      const has = Object.fromEntries(SECTIONS.map(name => [name, shown(node.querySelector(`.weather-${name}`))]));
      if (has.details && !has.hours) found.push(`${label} details without the strip`);
      if (has.hours && !has.summary) found.push(`${label} strip without the summary`);
      if (has.days && !has.details) found.push(`${label} days without the details`);
      found.push(...problems(node, label));
      const box = content(node), last = sections(node).filter(([name]) => name !== "days").at(-1)[1].getBoundingClientRect();
      if (last.bottom > box.bottom + 0.5) found.push(`${label} ${names(node)} ends ${last.bottom - box.bottom} px below the padding`);
      const h = node.getBoundingClientRect().height;
      for (const name of ["summary", "hours", "details", "days"]) if (has[name]) bounds[`${width}:${name}`] ??= h;
      const days = [...node.querySelectorAll(".weather-day")].filter(shown).length;
      if (has.days && days < 3) found.push(`${label} shows ${days} days`);
    }
    fixture().replaceChildren();
  }
  for (const width of [176, 240, 304, 600]) {
    assert.ok(bounds[`${width}:summary`] < bounds[`${width}:hours`] && bounds[`${width}:hours`] < bounds[`${width}:details`],
      `${width}: ${JSON.stringify(bounds)}`);
    if (width >= 220) assert.ok(bounds[`${width}:hours`] <= 240, `${width}: the strip shows at 240 px: ${bounds[`${width}:hours`]}`);
  }
  assert.ok(!found.length, found.slice(0, 40).join("\n"));
}, { timeout: 120000 });

test("size sweep: 1 x 1 to 10 x 12 at S, custom 40, 120 and 240 never clip or spill", async () => {
  const found = [], sizes = [];
  for (let w = 1; w <= 10; w++) for (let h = 1; h <= 12; h++) sizes.push([w, h]);
  for (const cell of [48, 40, 120, 240]) {
    for (const [state, settings, tag] of [[yelahanka(), {}, "C"], [ok({ temp: 38.4 }), { tempUnit: "F" }, "F"]].slice(0, cell === 48 ? 2 : 1)) {
      for (const [label, node] of await tiles(cell, sizes, state, settings)) found.push(...problems(node, `${label} ${tag}`));
      fixture().replaceChildren();
    }
  }
  assert.ok(!found.length, found.slice(0, 40).join("\n"));
}, { timeout: 120000 });

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
