import { test, assert, fixture, nextFrame } from "./harness.js";
import { renderBoard } from "./view.js";
import { createBoardFirefox } from "./controller.js";
import { DEFAULT_SETTINGS, DEFAULT_DEVICE } from "../../extension/src/settings/store.js";
import { renderSettings, settingActions } from "../../extension/src/settings/pane.js";
import { createController } from "../../extension/src/main.js";
import { forecastJson, fakeFetch, fakeGeolocation, GEOCODING } from "../fakes/weather.js";
import { parseForecast, REFRESH_MS } from "../../extension/src/weather/data.js";
import { showWeatherState, startWeather } from "../../extension/src/tiles/weather.js";

const NOW = (1790985600 - 3600 + 13 * 3600 + 1200) * 1000;
const SYNCED = { ...DEFAULT_SETTINGS, showWeather: true, showClock: false, showPinned: false, showSaved: false };
const okState = (extra = {}) => ({ status: "ok", stale: false, want: "auto", key: "53.35,-6.27", place: "Dublin",
  fetchedAt: NOW, data: parseForecast(forecastJson()), ...extra });

let css;
async function styles() {
  css ??= new Promise(resolve => {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/extension/newtab.css";
    link.onload = resolve; document.head.append(link);
  });
  await css; await document.fonts.ready;
}

async function tile(w, h, state = okState(), { scheme = "dark", synced = SYNCED, now = NOW } = {}) {
  await styles();
  const node = document.createElement("div"); node.className = "board";
  node.style.cssText = `width:1600px;height:900px;color-scheme:${scheme}`;
  fixture().append(node);
  renderBoard(node, { columns: [], pinned: [], tabs: [], saved: [] }, {}, {}, {
    boxes: [{ id: "weather", width: w * 64 - 16, height: h * 64 - 16 }], synced, device: { ...DEFAULT_DEVICE, cellSize: "S" },
  });
  showWeatherState(node, state, synced, now);
  await nextFrame();
  return node.querySelector(".tile.weather");
}

const shown = node => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
const parts = weather => Object.fromEntries(["glyph", "temp", "condition", "place", "range", "hours", "days"]
  .map(name => [name, shown(weather.querySelector(`.weather-${name}`))]));

function inside(weather) {
  const box = weather.getBoundingClientRect();
  for (const node of weather.querySelectorAll(".weather-body *")) {
    if (!shown(node) || node.closest(".weather-hours > *, .tile-resize")) continue;
    const rect = node.getBoundingClientRect();
    assert.ok(rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5 && rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5,
      `${node.className.baseVal ?? node.className} (${rect.left},${rect.top},${rect.right},${rect.bottom}) must fit the tile (${box.left},${box.top},${box.right},${box.bottom})`);
  }
}

const tiers = {
  small: { glyph: true, temp: true, condition: false, place: false, range: false, hours: false, days: false },
  medium: { glyph: true, temp: true, condition: true, place: true, range: true, hours: false, days: false },
  tall: { glyph: true, temp: true, condition: true, place: true, range: true, hours: true, days: false },
  taller: { glyph: true, temp: true, condition: true, place: true, range: true, hours: true, days: true },
};
for (const [w, h, tier] of [[1, 1, "small"], [2, 2, "small"], [3, 2, "medium"], [5, 2, "medium"], [5, 5, "tall"],
  [5, 8, "taller"], [8, 10, "taller"], [2, 8, "small"]]) {
  for (const scheme of ["dark", "light"]) {
    test(`weather ${w}x${h} at S (${scheme}) shows the ${tier} tier and fits`, async () => {
      const weather = await tile(w, h, okState(), { scheme });
      assert.equal(getComputedStyle(weather).containerType, "size");
      assert.deepEqual(parts(weather), tiers[tier]);
      inside(weather);
      assert.equal(weather.querySelector(".weather-temp").textContent, "14°");
      if (tiers[tier].hours) assert.equal(weather.querySelectorAll(".weather-hour").length, 24);
      if (tiers[tier].days) assert.equal(weather.querySelectorAll(".weather-day").length, 7);
      const style = getComputedStyle(weather);
      assert.equal(style.borderTopWidth, "0px"); assert.equal(style.boxShadow, "none");
      // Neutral text: equal red, green and blue.
      const [r, g, b] = getComputedStyle(weather.querySelector(".weather-temp")).color.match(/\d+/g).map(Number);
      assert.ok(r === g && g === b, `temperature colour must be neutral: ${r},${g},${b}`);
    });
  }
}

test("every weather text uses Foxy Sans; Foxy Serif is for the clock only", async () => {
  for (const [w, h] of [[1, 1], [3, 2], [5, 8]]) {
    const weather = await tile(w, h);
    for (const node of [weather, ...weather.querySelectorAll(".weather-body *")]) {
      if (node instanceof SVGElement || !shown(node)) continue;
      const family = getComputedStyle(node).fontFamily.replaceAll('"', "");
      assert.ok(family.startsWith("Foxy Sans") && !family.includes("Serif"), `${w}x${h} .${node.className}: ${family}`);
    }
  }
});

test("medium tier shows condition, place and high / low; tall adds the hourly strip from now", async () => {
  const weather = await tile(5, 5);
  assert.equal(weather.querySelector(".weather-condition").textContent, "Partly cloudy");
  assert.equal(weather.querySelector(".weather-place").textContent, "Dublin");
  assert.equal(weather.querySelector(".weather-range").textContent.replace(/\s+/g, " ").trim(), "17° / 8°");
  const hours = [...weather.querySelectorAll(".weather-hour-time")].map(n => n.textContent);
  assert.equal(hours[0], "Now"); assert.equal(hours[1], "14"); assert.equal(hours[11], "00");
  const strip = weather.querySelector(".weather-hours");
  assert.ok(strip.scrollWidth > strip.clientWidth, "hourly strip scrolls sideways");
  assert.equal(getComputedStyle(strip).overflowX, "auto");
  assert.ok(strip.hasAttribute("data-scroll-end"), "edge fade marker at the end");
});

test("no details row when the forecast has no feels-like, wind, humidity or precipitation", async () => {
  const state = okState();
  state.data = { ...state.data, current: { ...state.data.current, feels: null, wind: null, humidity: null, precipitation: null } };
  const weather = await tile(5, 8, state);
  assert.equal(weather.querySelector(".weather-details"), null);
  assert.ok(weather.querySelector(".weather-hours"), "the strip still renders");
});

test("the longest condition fits whole in 3- and 4-column tiles, in Fahrenheit", async () => {
  for (const [w, h] of [[3, 3], [4, 4], [4, 6]]) {
    const state = okState();
    state.data = { ...state.data, current: { ...state.data.current, code: 99 } };
    const weather = await tile(w, h, state, { synced: { ...SYNCED, tempUnit: "F" } });
    const label = weather.querySelector(".weather-condition");
    assert.equal(label.textContent, "Thunderstorm, hail");
    assert.ok(label.scrollWidth <= label.clientWidth, `${w}x${h}: ${label.scrollWidth} > ${label.clientWidth}`);
  }
});

test("Fahrenheit converts every temperature on the tile", async () => {
  const weather = await tile(5, 8, okState(), { synced: { ...SYNCED, tempUnit: "F" } });
  assert.equal(weather.querySelector(".weather-temp").textContent, "58°");
  assert.ok(weather.querySelector(".weather-details").textContent.includes("mph"));
  assert.equal(weather.querySelector(".weather-day .weather-day-max").textContent, "63°");
});

test("today's range bar has a dot for the current temperature; other days have none", async () => {
  const weather = await tile(5, 8);
  const days = weather.querySelectorAll(".weather-day");
  assert.equal(days[0].querySelector(".weather-day-name").textContent, "Today");
  assert.equal(days[1].querySelector(".weather-day-name").textContent, "Sun");
  assert.ok(shown(days[0].querySelector(".weather-bar-now")));
  assert.equal(days[1].querySelector(".weather-bar-now"), null);
  const bar = days[0].querySelector(".weather-bar").getBoundingClientRect(), dot = days[0].querySelector(".weather-bar-now").getBoundingClientRect();
  assert.ok(dot.left >= bar.left - 4 && dot.right <= bar.right + 4);
});

test("stale data says when it was updated", async () => {
  const weather = await tile(5, 5, okState({ stale: true }), { now: NOW + 2 * 3600000 + 60000 });
  assert.equal(weather.querySelector(".weather-updated").textContent, "Updated 2 h ago");
  assert.ok(shown(weather.querySelector(".weather-updated")));
  const fresh = await tile(5, 5);
  assert.equal(shown(fresh.querySelector(".weather-updated")), false);
});

test("no place: a short message and no data", async () => {
  for (const [w, h] of [[1, 1], [5, 5]]) {
    const weather = await tile(w, h, { status: "no-place", want: "auto" });
    assert.equal(weather.dataset.state, "no-place");
    assert.equal(weather.querySelector(".weather-message").textContent, "Set a location in Settings");
    assert.equal(weather.querySelector(".weather-temp"), null);
    inside(weather);
  }
});

test("error with nothing cached: a message and a retry button that refreshes", async () => {
  const weather = await tile(5, 5, { status: "error", want: "auto" });
  assert.equal(weather.querySelector(".weather-message").textContent, "Weather is unavailable");
  const retry = weather.querySelector("button.weather-retry");
  assert.ok(shown(retry)); assert.equal(retry.textContent, "RETRY");
  assert.equal(getComputedStyle(retry).borderRadius, "999px");
});

test("consent: an Allow weather pill and nothing else, at any size", async () => {
  for (const [w, h] of [[1, 1], [2, 2], [3, 2], [5, 5]]) {
    const weather = await tile(w, h, { status: "consent", want: "auto" });
    assert.equal(weather.dataset.state, "consent");
    const allow = weather.querySelector("button.weather-allow");
    assert.ok(shown(allow), `${w}x${h} shows the pill`);
    assert.equal(allow.textContent, "Allow weather");
    assert.equal(allow.getAttribute("aria-label"), "Allow weather");
    assert.equal(getComputedStyle(allow).borderRadius, "999px");
    assert.equal(weather.querySelector(".weather-temp"), null);
    inside(weather);
  }
});

test("controller: without locationInfo nothing is located or fetched; the pill asks from the click, then loads", async () => {
  const deps = weatherDeps({ dataCollection: [] }), node = await withTile(deps);
  const control = startWeather(node, deps);
  try {
    control.wake(); await settle();
    control.wake(true); await settle();
    assert.equal(node.querySelector(".weather").dataset.state, "consent");
    assert.deepEqual(deps.fetch.calls, []);
    assert.equal(deps.geolocation.calls, 0);
    const before = deps.ff.calls.length;
    deps.ff.withUserInput(() => node.querySelector(".weather-allow").click());
    assert.equal(deps.ff.calls[before].api, "permissions.request", "request must run in the click, before any await");
    assert.deepEqual(deps.ff.calls[before].args, [{ permissions: ["geolocation"], data_collection: ["locationInfo"] }],
      "my location: geolocation and locationInfo in one prompt");
    await deps.ff.settle(); await settle();
    assert.equal(node.querySelector(".weather").dataset.state, "ok");
    assert.equal(deps.fetch.calls.filter(url => url.includes("api.open-meteo.com")).length, 1);
  } finally { control.stop(); }
});

test("controller: a refused request keeps the pill and makes no request", async () => {
  const ff = createBoardFirefox({ windows: [{ id: 1, focused: true }], tabs: [], requestGranted: false });
  const deps = weatherDeps({ ff, api: ff.browser }), node = await withTile(deps);
  const control = startWeather(node, deps);
  try {
    control.wake(); await settle();
    ff.withUserInput(() => node.querySelector(".weather-allow").click());
    await ff.settle(); await settle();
    assert.equal(node.querySelector(".weather").dataset.state, "consent");
    assert.deepEqual(deps.fetch.calls, []);
  } finally { control.stop(); }
});

test("controller: revoking locationInfo (about:addons) returns the tile to the pill and stops requests", async () => {
  const deps = weatherDeps(), node = await withTile(deps);
  const control = startWeather(node, deps);
  try {
    control.wake(); await settle();
    assert.equal(node.querySelector(".weather").dataset.state, "ok");
    await deps.api.permissions.remove({ data_collection: ["locationInfo"] });
    await deps.ff.settle(); await settle();
    assert.equal(node.querySelector(".weather").dataset.state, "consent");
    assert.ok(node.querySelector(".weather-allow"));
    const calls = deps.fetch.calls.length;
    deps.advance(REFRESH_MS); control.wake(true); await settle();
    assert.equal(deps.fetch.calls.length, calls);
    assert.equal(node.querySelector(".weather").dataset.state, "consent");
    // Granting it again elsewhere (another page or about:addons) loads without a click here.
    await deps.ff.withUserInput(() => deps.api.permissions.request({ data_collection: ["locationInfo"] }));
    await deps.ff.settle(); await settle();
    assert.equal(node.querySelector(".weather").dataset.state, "ok");
  } finally { control.stop(); }
});

test("controller: a searched city asks only for locationInfo; my location without geolocation shows the pill", async () => {
  const deps = weatherDeps({ dataCollection: [], permissions: [] }), node = await withTile(deps);
  deps.current.device.weatherPlace = { name: "Berlin", lat: 52.52, lon: 13.41 };
  const control = startWeather(node, deps);
  try {
    control.wake(); await settle();
    assert.equal(node.querySelector(".weather").dataset.state, "consent");
    const before = deps.ff.calls.length;
    deps.ff.withUserInput(() => node.querySelector(".weather-allow").click());
    assert.deepEqual(deps.ff.calls[before].args, [{ data_collection: ["locationInfo"] }]);
    await deps.ff.settle(); await settle();
    assert.equal(node.querySelector(".weather").dataset.state, "ok");
    assert.equal(deps.geolocation.calls, 0);
    // Back to my location: geolocation is still missing, so the pill returns and nothing is located.
    deps.current.device.weatherPlace = "auto";
    control.wake(); await settle();
    assert.equal(node.querySelector(".weather").dataset.state, "consent");
    assert.equal(deps.geolocation.calls, 0);
  } finally { control.stop(); }
});

test("controller: revoking geolocation while a city is set keeps the forecast, the cache and the fetch count", async () => {
  const deps = weatherDeps(), node = await withTile(deps);
  deps.current.device.weatherPlace = { name: "Berlin", lat: 52.52, lon: 13.41 };
  const control = startWeather(node, deps);
  try {
    control.wake(); await settle();
    assert.equal(node.querySelector(".weather").dataset.state, "ok");
    const fetched = deps.fetch.calls.length, cached = (await deps.api.storage.local.get("weather")).weather;
    assert.ok(cached, "cached");
    await deps.api.permissions.remove({ permissions: ["geolocation"] });
    await deps.ff.settle(); await settle();
    assert.equal(node.querySelector(".weather").dataset.state, "ok");
    assert.deepEqual((await deps.api.storage.local.get("weather")).weather, cached);
    assert.equal(deps.fetch.calls.length, fetched);
  } finally { control.stop(); }
});

test("controller: revoking clears the cached place and forecast; revoking geolocation matters only for my location", async () => {
  const deps = weatherDeps(), node = await withTile(deps);
  await deps.api.storage.local.set({ deviceSettings: { weatherPlace: { name: "Berlin", lat: 52.52, lon: 13.41 } } });
  const control = startWeather(node, deps);
  try {
    control.wake(); await settle();
    assert.ok((await deps.api.storage.local.get("weather")).weather, "cached");
    await deps.api.permissions.remove({ permissions: ["geolocation"] });
    await deps.ff.settle(); await settle();
    assert.equal(node.querySelector(".weather").dataset.state, "consent", "my location needs geolocation");
    assert.deepEqual(await deps.api.storage.local.get("weather"), {});
    // A city keeps working without geolocation; revoking locationInfo clears it again.
    deps.current.device.weatherPlace = { name: "Berlin", lat: 52.52, lon: 13.41 };
    control.wake(); await settle();
    assert.equal(node.querySelector(".weather").dataset.state, "ok");
    assert.ok((await deps.api.storage.local.get("weather")).weather);
    await deps.api.permissions.remove({ data_collection: ["locationInfo"] });
    await deps.ff.settle(); await settle();
    assert.equal(node.querySelector(".weather").dataset.state, "consent");
    assert.deepEqual(await deps.api.storage.local.get("weather"), {});
    assert.deepEqual((await deps.api.storage.local.get("deviceSettings")).deviceSettings.weatherPlace.name, "Berlin", "the chosen city stays");
  } finally { control.stop(); }
});

test("controller: offline with nothing cached retries every 15 minutes, not on every render", async () => {
  const deps = weatherDeps({ fetch: fakeFetch({ fail: true }) }), node = await withTile(deps);
  deps.current.device.weatherPlace = { name: "Berlin", lat: 52.52, lon: 13.41 };
  const control = startWeather(node, deps);
  const forecasts = () => deps.fetch.calls.filter(url => url.includes("api.open-meteo.com")).length;
  try {
    for (let i = 0; i < 20; i++) { control.wake(); await settle(); }
    assert.equal(node.querySelector(".weather").dataset.state, "error");
    assert.equal(forecasts(), 1);
    deps.advance(REFRESH_MS); control.wake(); await settle();
    assert.equal(forecasts(), 2);
  } finally { control.stop(); }
});

test("controller: a hidden page keeps no refresh timer", async () => {
  let hidden = false;
  const deps = weatherDeps({ hidden: () => hidden }), node = await withTile(deps);
  const realSet = window.setTimeout, realClear = window.clearTimeout, long = new Set(), cleared = new Set();
  window.setTimeout = (fn, ms, ...rest) => { const id = realSet(fn, ms, ...rest); if (ms >= 60000) long.add(id); return id; };
  window.clearTimeout = id => { cleared.add(id); realClear(id); };
  const control = startWeather(node, deps);
  try {
    control.wake(); await settle();
    assert.ok(long.size >= 1, "a refresh timer is set while visible");
    hidden = true; document.dispatchEvent(new Event("visibilitychange"));
    assert.deepEqual([...long].filter(id => !cleared.has(id)), [], "hidden: no pending refresh timer");
  } finally { window.setTimeout = realSet; window.clearTimeout = realClear; control.stop(); }
});

test("hourly strip: a vertical wheel scrolls it sideways only while it can scroll that way; arrow keys scroll it; touch pans it", async () => {
  const weather = await tile(5, 5), strip = weather.querySelector(".weather-hours");
  const wheel = deltaY => { const event = new WheelEvent("wheel", { deltaY, deltaMode: 0, bubbles: true, cancelable: true }); strip.dispatchEvent(event); return event.defaultPrevented; };
  assert.equal(wheel(-60), false, "at the start, scrolling back leaves the wheel to the board");
  assert.equal(wheel(60), true);
  assert.ok(strip.scrollLeft > 0, "scrolled sideways");
  const sideways = new WheelEvent("wheel", { deltaX: 60, deltaY: 10, bubbles: true, cancelable: true });
  strip.dispatchEvent(sideways);
  assert.equal(sideways.defaultPrevented, false, "a sideways wheel stays native");
  strip.scrollLeft = strip.scrollWidth;
  assert.equal(wheel(60), false, "at the end the board scrolls");
  assert.equal(strip.tabIndex, 0);
  strip.scrollLeft = 0; strip.focus();
  strip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  const right = strip.scrollLeft;
  assert.ok(right > 0, "ArrowRight scrolls");
  strip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
  assert.ok(strip.scrollLeft < right, "ArrowLeft scrolls back");
  assert.equal(getComputedStyle(strip).overflowX, "auto");
  assert.equal(getComputedStyle(strip).touchAction, "pan-x");
});

test("accessibility: no label sits on a hidden node; day icons are labelled images", async () => {
  const weather = await tile(5, 8);
  for (const node of weather.querySelectorAll(".weather-body [aria-label]")) assert.ok(!node.closest("[aria-hidden='true']"), `${node.className.baseVal ?? node.className} is hidden`);
  const icon = weather.querySelector(".weather-day .weather-day-glyph");
  assert.equal(icon.getAttribute("role"), "img");
  assert.equal(icon.getAttribute("aria-label"), "Partly cloudy");
});

test("board re-renders keep the hourly strip's scroll and the focus on Allow weather and RETRY", async () => {
  await styles();
  const start = Math.floor(Date.now() / 86400000) * 86400;
  async function board({ dataCollection = ["locationInfo"], fail = false } = {}) {
    const fetch = fakeFetch({ forecast: forecastJson({ start, offset: 0 }), fail });
    const ff = createBoardFirefox({ windows: [{ id: 1, focused: true }], selfTabId: 99, dataCollection, permissions: ["geolocation"],
      tabs: [{ id: 99, windowId: 1 }, { id: 5, windowId: 1, url: "https://a.example/", title: "A" }] });
    await ff.browser.storage.local.set({ deviceSettings: { cellSize: "S", weatherPlace: { name: "Dublin", lat: 53.35, lon: -6.27 } } });
    const node = document.createElement("div"); node.className = "board"; node.style.cssText = "width:1232px;height:900px";
    fixture().append(node);
    const control = createController(node, ff.browser, undefined, { weather: { fetch, geolocation: fakeGeolocation() } });
    await control.refresh();
    const flush = async () => { for (let i = 0; i < 8; i++) { await ff.settle(); await nextFrame(); await settle(); } };
    await flush();
    return { ff, node, flush };
  }
  const ok = await board();
  const strip = ok.node.querySelector(".tile.weather .weather-hours");
  assert.ok(shown(strip) && strip.scrollWidth - strip.clientWidth > 200, "the strip can scroll");
  strip.scrollLeft = 200; strip.dispatchEvent(new Event("scroll"));
  ok.ff.commitExternal(5, "https://b.example/"); await ok.flush();
  const after = ok.node.querySelector(".tile.weather .weather-hours");
  assert.ok(Math.abs(after.scrollLeft - 200) <= 1, `strip scroll kept: ${after.scrollLeft}`);
  // A cache update from another Foxy page repaints the tile and keeps it too.
  const entry = (await ok.ff.browser.storage.local.get("weather")).weather;
  await ok.ff.browser.storage.local.set({ weather: { ...entry, fetchedAt: entry.fetchedAt + 1000 } }); await ok.flush();
  assert.ok(Math.abs(ok.node.querySelector(".tile.weather .weather-hours").scrollLeft - 200) <= 1, "kept after a repaint");
  for (const [setup, selector] of [[{ dataCollection: [] }, ".weather-allow"], [{ fail: true }, ".weather-retry"]]) {
    const { ff, node, flush } = await board(setup);
    const button = node.querySelector(`.tile.weather ${selector}`);
    assert.ok(button, selector);
    button.focus();
    ff.commitExternal(5, `https://c.example/${selector.slice(1)}`); await flush();
    assert.ok(document.activeElement?.matches(`.tile.weather ${selector}`), `${selector} keeps focus: ${document.activeElement?.className}`);
    assert.ok(document.activeElement !== button, "the board was re-rendered");
  }
});

function weatherDeps(overrides = {}) {
  const ff = createBoardFirefox({ windows: [{ id: 1, focused: true }], tabs: [], dataCollection: overrides.dataCollection ?? ["locationInfo"],
    permissions: overrides.permissions ?? ["geolocation"] });
  let now = NOW;
  const settings = { synced: { ...SYNCED }, device: { ...DEFAULT_DEVICE } };
  return { ff, api: ff.browser, fetch: fakeFetch(), geolocation: fakeGeolocation(), settings: () => settings,
    now: () => now, advance: ms => { now += ms; }, hidden: () => false, current: settings, ...overrides };
}
async function withTile(deps) {
  await styles();
  const node = document.createElement("div"); node.className = "board"; node.style.cssText = "width:1600px;height:900px";
  fixture().append(node);
  renderBoard(node, { columns: [], pinned: [], tabs: [], saved: [] }, {}, {}, {
    boxes: [{ id: "weather", width: 304, height: 304 }], synced: deps.current.synced, device: { ...DEFAULT_DEVICE, cellSize: "S" } });
  return node;
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

test("controller fetches once for a visible tile, then again only after 15 minutes", async () => {
  const deps = weatherDeps(), node = await withTile(deps);
  const control = startWeather(node, deps);
  try {
    control.wake(); await settle();
    assert.equal(deps.fetch.calls.filter(url => url.includes("api.open-meteo.com")).length, 1);
    assert.equal(node.querySelector(".weather-temp").textContent, "14°");
    deps.advance(REFRESH_MS - 1000); control.wake(); await settle();
    assert.equal(deps.fetch.calls.filter(url => url.includes("api.open-meteo.com")).length, 1);
    deps.advance(1000); control.wake(); await settle();
    assert.equal(deps.fetch.calls.filter(url => url.includes("api.open-meteo.com")).length, 2);
  } finally { control.stop(); }
});

test("controller: wakes from several renders at once make one request", async () => {
  const deps = weatherDeps(), node = await withTile(deps);
  const control = startWeather(node, deps);
  try {
    control.wake(); control.wake(); control.wake(); await settle();
    assert.equal(deps.fetch.calls.filter(url => url.includes("api.open-meteo.com")).length, 1);
  } finally { control.stop(); }
});

test("controller makes no request while the tile is absent, off, or the page is hidden", async () => {
  const deps = weatherDeps(), empty = document.createElement("div"); fixture().append(empty);
  const node = await withTile(deps);
  const runs = [startWeather(empty, deps)];
  try {
    runs[0].wake(); await settle();
    deps.current.synced.showWeather = false;
    runs.push(startWeather(node, deps)); runs[1].wake(); await settle();
    deps.current.synced.showWeather = true;
    runs.push(startWeather(node, { ...deps, hidden: () => true })); runs[2].wake(); await settle();
    assert.deepEqual(deps.fetch.calls, []);
    assert.equal(deps.geolocation.calls, 0);
    // The same setup with the tile shown on a visible page does fetch.
    runs.push(startWeather(node, deps)); runs[3].wake(); await settle();
    assert.equal(deps.fetch.calls.filter(url => url.includes("api.open-meteo.com")).length, 1);
  } finally { for (const run of runs) run.stop(); }
});

test("controller: denied geolocation shows the set-a-location state without a request", async () => {
  const deps = weatherDeps({ geolocation: fakeGeolocation({ error: 1 }) }), node = await withTile(deps);
  const control = startWeather(node, deps);
  try {
    control.wake(); await settle();
    assert.equal(node.querySelector(".weather").dataset.state, "no-place");
    assert.deepEqual(deps.fetch.calls, []);
  } finally { control.stop(); }
});

test("controller: a new place refreshes at once and retry forces a refresh", async () => {
  const deps = weatherDeps(), node = await withTile(deps);
  const control = startWeather(node, deps);
  try {
    control.wake(); await settle();
    deps.current.device.weatherPlace = { name: "Berlin", lat: 52.52, lon: 13.41 };
    control.wake(); await settle();
    assert.equal(node.querySelector(".weather-place").textContent, "Berlin");
    const before = deps.fetch.calls.length;
    showWeatherState(node, { status: "error", want: "52.52,13.41" }, deps.current.synced, NOW);
    node.querySelector(".weather-retry").click(); await settle();
    assert.equal(deps.fetch.calls.length, before + 1);
  } finally { control.stop(); }
});

test("controller picks up weather another Foxy page cached", async () => {
  const deps = weatherDeps(), node = await withTile(deps);
  const control = startWeather(node, deps);
  try {
    control.wake(); await settle();
    const entry = (await deps.api.storage.local.get("weather")).weather;
    await deps.api.storage.local.set({ weather: { ...entry, fetchedAt: NOW + 60000,
      data: parseForecast(forecastJson({ temp: 3.2 })) } });
    await deps.ff.settle(); await settle();
    assert.equal(node.querySelector(".weather-temp").textContent, "3°");
  } finally { control.stop(); }
});

// Settings pane: units, TILES toggle and the city search.
async function pane(searchPlaces, consent = {}) {
  await styles();
  const container = document.createElement("aside"); container.className = "settings-pane";
  fixture().append(container);
  const changes = [];
  const handlers = { onChange: async (scope, key, value) => { changes.push([scope, key, value]); }, onReset() {}, searchPlaces, ...consent };
  renderSettings(container, { synced: { ...DEFAULT_SETTINGS }, device: { ...DEFAULT_DEVICE }, railMax: 4 }, handlers);
  return { container, changes };
}

test("pane: without locationInfo the city search is an Allow weather pill; granting shows the field, revoking brings the pill back", async () => {
  let allowed = false, watcher = null;
  const asked = [], queries = [];
  const { container } = await pane(async query => { queries.push(query); return []; }, {
    weatherAllowed: async () => allowed,
    allowWeather: () => { asked.push("request"); allowed = true; return Promise.resolve(true); },
    watchWeather: listener => { watcher = listener; return () => {}; },
  });
  await settle();
  const allow = container.querySelector(".weather-search .weather-allow");
  const input = container.querySelector(".weather-search input");
  assert.ok(shown(allow)); assert.equal(allow.textContent, "Allow weather");
  assert.ok(!shown(input), "no search field before the grant");
  allow.click();
  assert.deepEqual(asked, ["request"], "asked from the click");
  await settle();
  assert.ok(shown(input)); assert.ok(!shown(allow));
  input.value = "Dub"; input.dispatchEvent(new Event("input", { bubbles: true }));
  allowed = false; watcher(false); await settle();
  assert.ok(shown(allow)); assert.ok(!shown(input));
  await new Promise(resolve => setTimeout(resolve, 400)); await settle();
  assert.deepEqual(queries, [], "a pending search is dropped after a revoke");
  // Enter while not allowed searches nothing either.
  input.value = "Berlin"; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await settle();
  assert.deepEqual(queries, []);
  allowed = true; watcher(true); await settle();
  assert.ok(shown(input));
});

test("pane: Show weather toggle, temperature unit and a device-only location", async () => {
  const { container, changes } = await pane(async () => []);
  assert.equal(container.querySelector('button[data-key="showWeather"]').getAttribute("aria-checked"), "true");
  container.querySelector('button[data-key="showWeather"]').click();
  container.querySelector('[data-key="tempUnit"] [data-value="F"]').click();
  assert.deepEqual(changes, [["synced", "showWeather", false], ["synced", "tempUnit", "F"]]);
  const titles = [...container.querySelectorAll("h2")].map(n => n.textContent);
  assert.ok(titles.includes("Weather"));
  assert.equal(container.querySelector(".weather-search input").type, "search");
  assert.equal(container.querySelector(".weather-current").textContent, "Current location");
});

test("pane: city search is debounced, lists matches and a click picks one", async () => {
  const queries = [];
  const { container, changes } = await pane(async query => { queries.push(query); return GEOCODING.results.map(r => ({
    name: r.name, detail: `${r.admin1}, ${r.country}`, lat: Math.round(r.latitude * 100) / 100, lon: Math.round(r.longitude * 100) / 100 })); });
  const input = container.querySelector(".weather-search input");
  for (const text of ["D", "Du", "Dub"]) { input.value = text; input.dispatchEvent(new Event("input", { bubbles: true })); }
  assert.deepEqual(queries, []);
  await new Promise(resolve => setTimeout(resolve, 400)); await settle();
  assert.deepEqual(queries, ["Dub"]);
  const options = [...container.querySelectorAll(".weather-results button")];
  assert.equal(options.length, 3);
  assert.equal(options[1].textContent, "DublinCalifornia, United States");
  options[1].click(); await settle();
  assert.deepEqual(changes, [["device", "weatherPlace", { name: "Dublin", lat: 37.7, lon: -121.94 }]]);
  assert.equal(container.querySelectorAll(".weather-results button").length, 0);
});

test("pane: Enter picks the first result; Use my location resets to auto", async () => {
  const { container, changes } = await pane(async () => [{ name: "Berlin", detail: "Germany", lat: 52.52, lon: 13.41 }]);
  const input = container.querySelector(".weather-search input");
  input.value = "Berl"; input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await settle();
  assert.deepEqual(changes, [["device", "weatherPlace", { name: "Berlin", lat: 52.52, lon: 13.41 }]]);
  const asked = [];
  let answer = true;
  renderSettings(container, { synced: { ...DEFAULT_SETTINGS }, device: { ...DEFAULT_DEVICE, weatherPlace: { name: "Berlin", lat: 52.52, lon: 13.41 } }, railMax: 4 },
    { onChange: async (...args) => { changes.push(args); }, onReset() {}, searchPlaces: async () => [],
      allowMyLocation: () => { asked.push(changes.length); return Promise.resolve(answer); } });
  assert.equal(container.querySelector(".weather-current").textContent, "Berlin");
  const auto = container.querySelector(".weather-auto");
  assert.equal(auto.disabled, false);
  answer = false;
  auto.click();
  assert.deepEqual(asked, [1], "the permission prompt is requested synchronously in the click");
  await settle();
  assert.equal(changes.length, 1, "a decline keeps the searched city");
  answer = true;
  auto.click(); await settle();
  assert.deepEqual(changes.at(-1), ["device", "weatherPlace", "auto"]);
});

test("settingActions: my location asks for geolocation and locationInfo in one request", async () => {
  const requests = [];
  const api = { permissions: { request: perms => { requests.push(perms); return Promise.resolve(true); } } };
  assert.equal(await settingActions(api, () => {}).allowMyLocation(), true);
  assert.deepEqual(requests, [{ permissions: ["geolocation"], data_collection: ["locationInfo"] }]);
});

test("board with weather access but no location shows set-a-location and makes no request", async () => {
  await styles();
  const fetch = fakeFetch();
  const ff = createBoardFirefox({ windows: [{ id: 1, focused: true }], tabs: [{ id: 99, windowId: 1 }], selfTabId: 99, dataCollection: ["locationInfo"],
    permissions: ["geolocation"] });
  const node = document.createElement("div"); node.className = "board"; node.style.cssText = "width:1232px;height:800px";
  fixture().append(node);
  const control = createController(node, ff.browser, undefined, { weather: { fetch, geolocation: undefined } });
  await control.refresh();
  for (let i = 0; i < 5; i++) { await ff.settle(); await nextFrame(); await settle(); }
  assert.equal(node.querySelector(".tile.weather")?.dataset.state, "no-place");
  assert.deepEqual(fetch.calls, []);
});

test("board without locationInfo shows the Allow weather pill and never geolocates or fetches", async () => {
  await styles();
  const fetch = fakeFetch(), geolocation = fakeGeolocation();
  const ff = createBoardFirefox({ windows: [{ id: 1, focused: true }], tabs: [{ id: 99, windowId: 1 }], selfTabId: 99 });
  const node = document.createElement("div"); node.className = "board"; node.style.cssText = "width:1232px;height:800px";
  fixture().append(node);
  const control = createController(node, ff.browser, undefined, { weather: { fetch, geolocation } });
  await control.refresh();
  for (let i = 0; i < 5; i++) { await ff.settle(); await nextFrame(); await settle(); }
  assert.equal(node.querySelector(".tile.weather")?.dataset.state, "consent");
  assert.ok(node.querySelector(".tile.weather .weather-allow"));
  assert.deepEqual(fetch.calls, []);
  assert.equal(geolocation.calls, 0);
});

test("weather reorders by its body, but the retry button does not start a widget move", async () => {
  await styles();
  const ff = createBoardFirefox({windows: [{id: 1}], tabs: [{id: 99, windowId: 1}], selfTabId: 99});
  await ff.browser.storage.sync.set({board: {order: [], heights: {}, widgets: [], t: 1},
    settings: {showClock: true, showPinned: false, showSaved: false, showMemory: false, showWeather: true}});
  const node = document.createElement('div'); node.className = 'board'; node.style.cssText = 'width:1600px;height:900px';
  fixture().append(node);
  const control = createController(node, ff.browser, undefined, {weather: {fetch: fakeFetch(), geolocation: fakeGeolocation()}});
  const flush = async () => { for (let i = 0; i < 5; i++) { await ff.settle(); await nextFrame(); } };
  await control.refresh(); await flush(); ff.calls.length = 0;
  const pointer = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true,
    pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y}));
  const press = target => {
    const r = target.getBoundingClientRect(), x = r.left + 2, y = r.top + 2;
    pointer(target, 'pointerdown', x, y); return [x, y];
  };
  showWeatherState(node, {status: 'error', want: 'auto'}, SYNCED, NOW);
  const [rx, ry] = press(node.querySelector('.weather-retry'));
  pointer(document, 'pointermove', rx, ry - 180); pointer(document, 'pointerup', rx, ry - 180); await flush();
  assert.equal(control.ui.layoutDragging, false);
  assert.equal(node.querySelector('.layout-insertion'), null);
  assert.equal(ff.calls.filter(c => c.api === 'storage.sync.set').length, 0);
  showWeatherState(node, okState(), SYNCED, NOW);
  press(node.querySelector('.weather-condition'));
  const r = node.querySelector('.clock').getBoundingClientRect(), x = r.left + 20, y = r.top + 20;
  pointer(document, 'pointermove', x, y); await nextFrame();
  assert.ok(node.querySelector('.layout-insertion'));
  assert.equal(getComputedStyle(node.querySelector('.weather-body')).cursor, 'grab');
  pointer(document, 'pointerup', x, y); await flush();
  assert.deepEqual([...node.querySelectorAll('.widget')].map(w => w.dataset.kind), ['weather', 'clock']);
  assert.deepEqual((await ff.browser.storage.sync.get('board')).board.widgets.map(w => w.kind), ['weather', 'clock', 'pinned', 'memory', 'saved']);
  assert.equal(ff.calls.filter(c => c.api === 'storage.sync.set').length, 1);
});

test("board without weather access shows no weather tile", async () => {
  await styles();
  const ff = createBoardFirefox({ windows: [{ id: 1, focused: true }], tabs: [{ id: 99, windowId: 1 }], selfTabId: 99 });
  const node = document.createElement("div"); node.className = "board"; node.style.cssText = "width:1232px;height:800px";
  fixture().append(node);
  const control = createController(node, ff.browser); await control.refresh();
  for (let i = 0; i < 5; i++) { await ff.settle(); await nextFrame(); }
  assert.ok(node.querySelector(".tile"));
  assert.equal(node.querySelector(".tile.weather"), null);
});

