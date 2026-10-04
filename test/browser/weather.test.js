import { test, assert, fixture, nextFrame } from "./harness.js";
import { renderBoard } from "./view.js";
import { createBoardFirefox } from "./controller.js";
import { DEFAULT_SETTINGS, DEFAULT_DEVICE } from "../../extension/src/settings/store.js";
import { renderSettings } from "../../extension/src/settings/pane.js";
import { createController } from "../../extension/src/main.js";
import { forecastJson, fakeFetch, fakeGeolocation, GEOCODING } from "../fakes/weather.js";
import { parseForecast, REFRESH_MS } from "../../extension/src/weather/data.js";
import { showWeatherState, startWeather } from "../../extension/src/tiles/weather.js";
import { attachGridDrag } from "../../extension/src/grid/drag.js";

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
    layout: [{ id: "weather", x: 0, y: 0, w, h }], synced, device: { ...DEFAULT_DEVICE, cellSize: "S" },
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

test("medium tier shows condition, place and high / low; tall adds the hourly strip from now", async () => {
  const weather = await tile(5, 5);
  assert.equal(weather.querySelector(".weather-condition").textContent, "Partly cloudy");
  assert.equal(weather.querySelector(".weather-place").textContent, "Dublin");
  assert.equal(weather.querySelector(".weather-range").textContent.replace(/\s+/g, " ").trim(), "17° 8°");
  const hours = [...weather.querySelectorAll(".weather-hour-time")].map(n => n.textContent);
  assert.equal(hours[0], "Now"); assert.equal(hours[1], "14"); assert.equal(hours[11], "00");
  const strip = weather.querySelector(".weather-hours");
  assert.ok(strip.scrollWidth > strip.clientWidth, "hourly strip scrolls sideways");
  assert.equal(getComputedStyle(strip).overflowX, "auto");
  assert.ok(strip.hasAttribute("data-scroll-end"), "edge fade marker at the end");
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

function weatherDeps(overrides = {}) {
  const ff = createBoardFirefox({ windows: [{ id: 1, focused: true }], tabs: [] });
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
    layout: [{ id: "weather", x: 0, y: 0, w: 5, h: 5 }], synced: deps.current.synced, device: { ...DEFAULT_DEVICE, cellSize: "S" } });
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
async function pane(searchPlaces) {
  await styles();
  const container = document.createElement("aside"); container.className = "settings-pane";
  fixture().append(container);
  const changes = [];
  const handlers = { onChange: async (scope, key, value) => { changes.push([scope, key, value]); }, onReset() {}, searchPlaces };
  renderSettings(container, { synced: { ...DEFAULT_SETTINGS }, device: { ...DEFAULT_DEVICE }, railMax: 4 }, handlers);
  return { container, changes };
}

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
  renderSettings(container, { synced: { ...DEFAULT_SETTINGS }, device: { ...DEFAULT_DEVICE, weatherPlace: { name: "Berlin", lat: 52.52, lon: 13.41 } }, railMax: 4 },
    { onChange: async (...args) => { changes.push(args); }, onReset() {}, searchPlaces: async () => [] });
  assert.equal(container.querySelector(".weather-current").textContent, "Berlin");
  const auto = container.querySelector(".weather-auto");
  assert.equal(auto.disabled, false);
  auto.click(); await settle();
  assert.deepEqual(changes.at(-1), ["device", "weatherPlace", "auto"]);
});

test("board with weather access but no location shows set-a-location and makes no request", async () => {
  await styles();
  const fetch = fakeFetch();
  const ff = createBoardFirefox({ windows: [{ id: 1, focused: true }], tabs: [{ id: 99, windowId: 1 }], selfTabId: 99 });
  const node = document.createElement("div"); node.className = "board"; node.style.cssText = "width:1232px;height:800px";
  fixture().append(node);
  const control = createController(node, ff.browser, undefined, { weather: { fetch, geolocation: undefined } });
  await control.refresh();
  for (let i = 0; i < 5; i++) { await ff.settle(); await nextFrame(); await settle(); }
  assert.equal(node.querySelector(".tile.weather")?.dataset.state, "no-place");
  assert.deepEqual(fetch.calls, []);
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

test("the tile moves by its empty space; the retry button does not start a move", async () => {
  await styles();
  const node = document.createElement("div"); node.className = "board"; node.style.cssText = "width:1600px;height:900px";
  fixture().append(node);
  const view = renderBoard(node, { columns: [], pinned: [], tabs: [], saved: [] }, {}, {}, {
    layout: [{ id: "weather", x: 0, y: 0, w: 5, h: 5 }], synced: SYNCED, device: { ...DEFAULT_DEVICE, cellSize: "S" } });
  const states = [];
  const detach = attachGridDrag(node, { view: () => view, onState: (active, id) => states.push([active, id]),
    onPreview() {}, onCommit() {}, onCancel() {}, onRail() {}, canCommit: async () => true });
  try {
    const press = target => {
      const box = target.getBoundingClientRect();
      for (const type of ["pointerdown", "pointerup"]) {
        target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse",
          isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: box.left + 2, clientY: box.top + 2 }));
      }
    };
    showWeatherState(node, { status: "error", want: "auto" }, SYNCED, NOW);
    press(node.querySelector(".weather-retry")); await settle();
    assert.deepEqual(states, []);
    showWeatherState(node, okState(), SYNCED, NOW);
    press(node.querySelector(".weather-condition")); await settle();
    assert.deepEqual(states[0], [true, "weather"]);
    assert.equal(getComputedStyle(node.querySelector(".weather-body")).cursor, "grab");
  } finally { detach(); }
});
