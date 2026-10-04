import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { forecastJson, fakeFetch, fakeGeolocation } from "./fakes/weather.js";
import { condition, GLYPHS } from "../extension/src/weather/codes.js";
import { roundCoord, validPlace, locate, searchPlaces, reverseName } from "../extension/src/weather/location.js";
import { forecastUrl, parseForecast, temperature, wind, updatedAgo, isFresh, loadWeather, REFRESH_MS, CACHE_KEY,
  upcomingHours, upcomingDays } from "../extension/src/weather/data.js";

const NOW = (1790985600 - 3600 + 13 * 3600 + 1200) * 1000; // 13:20 local on the fixture's first day

function decimals(url) {
  const params = new URL(url).searchParams;
  return ["latitude", "longitude"].map(key => params.get(key));
}

test("coordinates are rounded to 2 decimals", () => {
  assert.equal(roundCoord(53.34567), 53.35);
  assert.equal(roundCoord(-6.26789), -6.27);
  assert.equal(roundCoord(-0.001), 0);
  assert.ok(Object.is(roundCoord(-0.001), 0), "no negative zero in URLs");
});

test("forecast URL asks Open-Meteo for current, 24 h and 7 day data with rounded coordinates", () => {
  const url = new URL(forecastUrl({ lat: 53.34567, lon: -6.26789 }));
  assert.equal(url.origin + url.pathname, "https://api.open-meteo.com/v1/forecast");
  assert.deepEqual(decimals(url), ["53.35", "-6.27"]);
  const p = url.searchParams;
  assert.equal(p.get("timezone"), "auto");
  assert.equal(p.get("timeformat"), "unixtime");
  assert.equal(p.get("forecast_days"), "7");
  for (const key of ["temperature_2m", "apparent_temperature", "weather_code", "is_day", "wind_speed_10m",
    "relative_humidity_2m", "precipitation"]) assert.ok(p.get("current").split(",").includes(key), key);
  for (const key of ["temperature_2m", "weather_code", "precipitation_probability", "is_day"]) {
    assert.ok(p.get("hourly").split(",").includes(key), key);
  }
  for (const key of ["weather_code", "temperature_2m_max", "temperature_2m_min", "sunrise", "sunset"]) {
    assert.ok(p.get("daily").split(",").includes(key), key);
  }
  assert.equal(url.search.includes("key"), false, "no API key");
});

test("parseForecast reads current, hourly and daily data in Unix ms", () => {
  const data = parseForecast(forecastJson());
  assert.deepEqual(data.current, { time: (1790985600 - 3600 + 13 * 3600 + 900) * 1000, temp: 14.4, feels: 14.4 - 2.1,
    code: 2, isDay: true, wind: 18.7, humidity: 71, precipitation: 0.2 });
  assert.equal(data.offset, 3600);
  assert.equal(data.hourly.length, 168);
  assert.deepEqual(data.hourly[13], { time: (1790985600 - 3600 + 13 * 3600) * 1000, temp: data.hourly[13].temp,
    code: forecastJson().hourly.weather_code[13], pop: 91, isDay: true });
  assert.equal(data.daily.length, 7);
  assert.deepEqual(data.daily[0], { time: (1790985600 - 3600) * 1000, code: 2, min: 8.4, max: 17.2,
    sunrise: (1790985600 - 3600 + 7.5 * 3600) * 1000, sunset: (1790985600 - 3600 + 19 * 3600) * 1000 });
});

for (const [name, mutate] of [
  ["no current block", json => { delete json.current; }],
  ["a non-numeric temperature", json => { json.current.temperature_2m = "warm"; }],
  ["hourly arrays of different lengths", json => { json.hourly.weather_code.pop(); }],
  ["no daily block", json => { json.daily = null; }],
  ["a non-object reply", () => "nope"],
]) {
  test(`parseForecast rejects ${name}`, () => {
    const json = forecastJson();
    const result = mutate(json);
    assert.throws(() => parseForecast(result ?? json), TypeError);
  });
}

test("hours start at the current hour and run for 24; days start today", () => {
  const data = parseForecast(forecastJson());
  const hours = upcomingHours(data, NOW);
  assert.equal(hours.length, 24);
  assert.equal(hours[0].time, (1790985600 - 3600 + 13 * 3600) * 1000);
  const days = upcomingDays(data, NOW);
  assert.equal(days.length, 7);
  assert.equal(upcomingDays(data, NOW + 2 * 86400000).length, 5, "an old cache shows the days that remain");
});

test("temperatures and wind convert to the chosen unit", () => {
  assert.equal(temperature(14.4, "C"), 14);
  assert.equal(temperature(14.6, "C"), 15);
  assert.equal(temperature(-0.4, "C"), 0);
  assert.ok(Object.is(temperature(-0.4, "C"), 0), "no -0°");
  assert.equal(temperature(0, "F"), 32);
  assert.equal(temperature(100, "F"), 212);
  assert.equal(temperature(-40, "F"), -40);
  assert.equal(temperature(14.4, "F"), 58);
  assert.deepEqual(wind(18.7, "C"), { value: 19, unit: "km/h" });
  assert.deepEqual(wind(18.7, "F"), { value: 12, unit: "mph" });
});

test("updatedAgo reads in minutes, hours and days", () => {
  assert.equal(updatedAgo(30 * 1000), "Updated just now");
  assert.equal(updatedAgo(5 * 60000), "Updated 5 min ago");
  assert.equal(updatedAgo(2 * 3600000 + 10 * 60000), "Updated 2 h ago");
  assert.equal(updatedAgo(3 * 86400000), "Updated 3 d ago");
});

test("cache is fresh for 15 minutes for the same place only", () => {
  const cache = { want: "auto", fetchedAt: NOW, data: {} };
  assert.equal(REFRESH_MS, 15 * 60000);
  assert.equal(isFresh(cache, "auto", NOW + REFRESH_MS - 1), true);
  assert.equal(isFresh(cache, "auto", NOW + REFRESH_MS), false);
  assert.equal(isFresh(cache, "53.35,-6.27", NOW), false);
  assert.equal(isFresh(null, "auto", NOW), false);
  assert.equal(isFresh({ ...cache, fetchedAt: NOW + 60000 }, "auto", NOW), false, "a cache from the future is not trusted");
});

test("WMO codes map to labels and the in-house glyphs", () => {
  const cases = [[0, true, "Clear", "clear-day"], [0, false, "Clear", "clear-night"], [1, true, "Mainly clear", "partly-day"],
    [2, false, "Partly cloudy", "partly-night"], [3, true, "Overcast", "cloudy"], [45, true, "Fog", "fog"],
    [48, true, "Fog", "fog"], [53, true, "Drizzle", "drizzle"], [57, true, "Freezing drizzle", "drizzle"],
    [61, true, "Light rain", "rain"], [65, true, "Heavy rain", "rain"], [67, true, "Freezing rain", "rain"],
    [73, true, "Snow", "snow"], [77, true, "Snow grains", "snow"], [80, true, "Light showers", "showers"],
    [82, true, "Heavy showers", "showers"], [86, true, "Snow showers", "snow"], [95, true, "Thunderstorm", "thunder"],
    [99, true, "Thunderstorm with hail", "thunder"], [12345, true, "Unknown", "cloudy"]];
  for (const [code, day, label, glyph] of cases) assert.deepEqual(condition(code, day), { label, glyph }, `code ${code}`);
  for (const name of ["clear-day", "clear-night", "partly-day", "partly-night", "cloudy", "fog", "drizzle", "rain",
    "snow", "showers", "thunder"]) assert.ok(Array.isArray(GLYPHS[name]) && GLYPHS[name].length, name);
});

test("validPlace accepts auto or a named place with coordinates", () => {
  assert.equal(validPlace("auto"), true);
  assert.equal(validPlace({ name: "Dublin", lat: 53.33, lon: -6.25 }), true);
  for (const bad of ["", "home", null, [], { name: "", lat: 1, lon: 1 }, { name: "X", lat: 91, lon: 0 },
    { name: "X", lat: 0, lon: 181 }, { name: "X", lat: "1", lon: 0 }, { name: "X".repeat(201), lat: 0, lon: 0 },
    { name: "X", lat: NaN, lon: 0 }]) assert.equal(validPlace(bad), false, JSON.stringify(bad));
});

test("locate rounds the position and reports denial or missing geolocation", async () => {
  assert.deepEqual(await locate(fakeGeolocation()), { lat: 53.35, lon: -6.27 });
  assert.deepEqual(await locate(fakeGeolocation({ error: 1 })), { error: "denied" });
  assert.deepEqual(await locate(fakeGeolocation({ error: 3 })), { error: "unavailable" });
  assert.deepEqual(await locate(undefined), { error: "denied" });
  const silent = { getCurrentPosition() {} };
  assert.deepEqual(await locate(silent, { timeout: 5 }), { error: "unavailable" });
});

test("searchPlaces uses Open-Meteo geocoding and rounds results", async () => {
  const fetch = fakeFetch();
  const places = await searchPlaces("  Dublin ", fetch);
  assert.equal(fetch.calls.length, 1);
  const url = new URL(fetch.calls[0]);
  assert.equal(url.origin + url.pathname, "https://geocoding-api.open-meteo.com/v1/search");
  assert.equal(url.searchParams.get("name"), "Dublin");
  assert.equal(url.searchParams.get("count"), "5");
  assert.deepEqual(places[0], { name: "Dublin", detail: "Leinster, Ireland", lat: 53.33, lon: -6.25 });
  assert.equal(places.length, 3);
  assert.deepEqual(await searchPlaces(" ", fetch), []);
  assert.deepEqual(await searchPlaces("x", fetch), []);
  assert.equal(fetch.calls.length, 1, "no request below two characters");
  const nothing = async () => ({ ok: true, json: async () => ({}) });
  assert.deepEqual(await searchPlaces("Nowhere", nothing), []);
});

test("reverseName asks BigDataCloud's client endpoint with rounded coordinates", async () => {
  const fetch = fakeFetch();
  assert.equal(await reverseName({ lat: 53.34567, lon: -6.26789 }, fetch), "Dublin");
  const url = new URL(fetch.calls[0]);
  assert.equal(url.origin + url.pathname, "https://api.bigdatacloud.net/data/reverse-geocode-client");
  assert.deepEqual(decimals(url), ["53.35", "-6.27"]);
  assert.equal(await reverseName({ lat: 1, lon: 1 }, fakeFetch({ fail: true })), null);
});

function deps(overrides = {}) {
  const ff = createFirefox();
  return { ff, api: ff.browser, fetch: fakeFetch(), geolocation: fakeGeolocation(), place: "auto", now: NOW, ...overrides };
}

test("loadWeather with auto location fetches, names the place and caches with a timestamp", async () => {
  const d = deps();
  const state = await loadWeather(d);
  assert.equal(state.status, "ok");
  assert.equal(state.stale, false);
  assert.equal(state.place, "Dublin");
  assert.equal(state.fetchedAt, NOW);
  assert.equal(state.data.current.temp, 14.4);
  assert.equal(d.fetch.calls.length, 2);
  for (const url of d.fetch.calls) assert.deepEqual(decimals(url), ["53.35", "-6.27"]);
  const stored = (await d.api.storage.local.get(CACHE_KEY))[CACHE_KEY];
  assert.deepEqual(stored, { want: "auto", key: "53.35,-6.27", place: "Dublin", fetchedAt: NOW, data: state.data });
});

test("a fresh cache is used without geolocation or requests", async () => {
  const d = deps();
  await loadWeather(d);
  const again = deps({ api: d.api, now: NOW + REFRESH_MS - 1000 });
  const state = await loadWeather(again);
  assert.equal(state.status, "ok");
  assert.equal(state.fetchedAt, NOW);
  assert.equal(again.fetch.calls.length, 0);
  assert.equal(again.geolocation.calls, 0);
});

test("an old cache is refreshed; the place name is reused for the same rounded position", async () => {
  const d = deps();
  await loadWeather(d);
  const later = deps({ api: d.api, now: NOW + REFRESH_MS });
  const state = await loadWeather(later);
  assert.equal(state.fetchedAt, NOW + REFRESH_MS);
  assert.deepEqual(later.fetch.calls.map(url => new URL(url).host), ["api.open-meteo.com"]);
  assert.equal(state.place, "Dublin");
});

test("offline: cached data comes back marked stale, and nothing cached is an error", async () => {
  const d = deps();
  await loadWeather(d);
  const offline = deps({ api: d.api, now: NOW + 2 * 3600000, fetch: fakeFetch({ fail: true }) });
  const state = await loadWeather(offline);
  assert.equal(state.status, "ok");
  assert.equal(state.stale, true);
  assert.equal(state.fetchedAt, NOW);
  assert.equal(updatedAgo(offline.now - state.fetchedAt), "Updated 2 h ago");
  const empty = deps({ fetch: fakeFetch({ fail: true }) });
  assert.deepEqual(await loadWeather(empty), { status: "error", want: "auto" });
  const bad = deps({ fetch: fakeFetch({ forecast: { nope: true } }) });
  assert.equal((await loadWeather(bad)).status, "error");
});

test("geolocation denied or missing gives the set-a-location state without any request", async () => {
  for (const geolocation of [fakeGeolocation({ error: 1 }), undefined]) {
    const d = deps({ geolocation });
    assert.deepEqual(await loadWeather(d), { status: "no-place", want: "auto" });
    assert.equal(d.fetch.calls.length, 0);
    assert.deepEqual(await d.api.storage.local.get(CACHE_KEY), {});
  }
});

test("a chosen place skips geolocation and uses its rounded coordinates and name", async () => {
  const place = { name: "Berlin", lat: 52.524371, lon: 13.410534 };
  const d = deps({ place });
  const state = await loadWeather(d);
  assert.equal(d.geolocation.calls, 0);
  assert.deepEqual(d.fetch.calls.map(url => new URL(url).host), ["api.open-meteo.com"]);
  assert.deepEqual(decimals(d.fetch.calls[0]), ["52.52", "13.41"]);
  assert.equal(state.place, "Berlin");
  assert.equal(state.want, "52.52,13.41");
  // A cache for another place is not fresh for this one.
  const auto = deps({ api: d.api });
  await loadWeather(auto);
  assert.equal(auto.fetch.calls.length, 2);
});

test("force refreshes even a fresh cache", async () => {
  const d = deps();
  await loadWeather(d);
  const forced = deps({ api: d.api, now: NOW + 1000, force: true });
  await loadWeather(forced);
  assert.equal(forced.fetch.calls.filter(url => url.includes("open-meteo")).length, 1);
});
