// Weather data: Open-Meteo forecast, parsing, units and the shared cache in
// storage.local. Every dependency (fetch, clock, geolocation) is passed in.
import { roundCoord, placeKey, locate, reverseName, getJson } from "./location.js";

export const REFRESH_MS = 15 * 60000;
export const CACHE_KEY = "weather";

export function forecastUrl(coords) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: roundCoord(coords.lat), longitude: roundCoord(coords.lon),
    current: "temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,relative_humidity_2m,precipitation",
    hourly: "temperature_2m,weather_code,precipitation_probability,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset",
    timezone: "auto", timeformat: "unixtime", forecast_days: "7",
  });
  return url.href;
}

const number = value => typeof value === "number" && Number.isFinite(value);
const optional = value => (number(value) ? value : null);
function series(block, keys) {
  if (block === null || typeof block !== "object" || !Array.isArray(block.time) || !block.time.every(number)) {
    throw new TypeError("Forecast series missing");
  }
  for (const key of keys) {
    if (!Array.isArray(block[key]) || block[key].length !== block.time.length) throw new TypeError(`Forecast ${key} missing`);
  }
  return block.time.map((time, i) => [time * 1000, i]);
}

/** Open-Meteo reply to plain data with Unix ms times; throws TypeError when malformed. */
export function parseForecast(json) {
  if (json === null || typeof json !== "object") throw new TypeError("Forecast is not an object");
  const c = json.current;
  if (c === null || typeof c !== "object" || ![c.time, c.temperature_2m, c.weather_code].every(number)) {
    throw new TypeError("Forecast current missing");
  }
  const h = json.hourly, d = json.daily;
  const hourly = series(h, ["temperature_2m", "weather_code", "precipitation_probability", "is_day"])
    .filter(([, i]) => number(h.temperature_2m[i]) && number(h.weather_code[i]))
    .map(([time, i]) => ({ time, temp: h.temperature_2m[i], code: h.weather_code[i],
      pop: optional(h.precipitation_probability[i]), isDay: h.is_day[i] !== 0 }));
  const daily = series(d, ["weather_code", "temperature_2m_max", "temperature_2m_min", "sunrise", "sunset"])
    .filter(([, i]) => [d.weather_code[i], d.temperature_2m_max[i], d.temperature_2m_min[i]].every(number))
    .map(([time, i]) => ({ time, code: d.weather_code[i], min: d.temperature_2m_min[i], max: d.temperature_2m_max[i],
      sunrise: number(d.sunrise[i]) ? d.sunrise[i] * 1000 : null, sunset: number(d.sunset[i]) ? d.sunset[i] * 1000 : null }));
  return {
    offset: number(json.utc_offset_seconds) ? json.utc_offset_seconds : 0,
    current: { time: c.time * 1000, temp: c.temperature_2m, feels: optional(c.apparent_temperature), code: c.weather_code,
      isDay: c.is_day !== 0, wind: optional(c.wind_speed_10m), humidity: optional(c.relative_humidity_2m),
      precipitation: optional(c.precipitation) },
    hourly, daily,
  };
}

/** 24 hours from the current hour. */
export function upcomingHours(data, now) {
  return data.hourly.filter(hour => hour.time + 3600000 > now).slice(0, 24);
}

/** Up to 7 days from today at the location. */
export function upcomingDays(data, now) {
  return data.daily.filter(day => day.time + 86400000 > now).slice(0, 7);
}

export function temperature(celsius, unit) {
  return Math.round(unit === "F" ? celsius * 9 / 5 + 32 : celsius) + 0;
}

export function wind(kmh, unit) {
  return unit === "F" ? { value: Math.round(kmh / 1.609344), unit: "mph" } : { value: Math.round(kmh), unit: "km/h" };
}

export function updatedAgo(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `Updated ${hours} h ago` : `Updated ${Math.floor(hours / 24)} d ago`;
}

export function isFresh(cache, want, now) {
  return !!cache && cache.want === want && cache.fetchedAt <= now && now - cache.fetchedAt < REFRESH_MS;
}

export const wantOf = place => (place && place !== "auto" ? placeKey(place) : "auto");

export function validCache(value) {
  return value !== null && typeof value === "object" && typeof value.want === "string" && number(value.fetchedAt)
    && typeof value.key === "string" && (value.place === null || typeof value.place === "string")
    && value.data !== null && typeof value.data === "object" && typeof value.data.current === "object"
    && Array.isArray(value.data.hourly) && Array.isArray(value.data.daily);
}

export async function readCache(api) {
  try {
    const value = (await api.storage.local.get(CACHE_KEY))[CACHE_KEY];
    return validCache(value) ? value : null;
  } catch (error) {
    console.warn("Foxy: could not read weather", error);
    return null;
  }
}

/**
 * One refresh. States: ok (data, maybe stale), no-place (no position and no
 * chosen place: no request is made), error (nothing to show).
 */
export async function loadWeather({ api, fetch, geolocation, place = "auto", now, force = false }) {
  const want = wantOf(place);
  const cache = await readCache(api);
  const cached = cache?.want === want ? cache : null;
  if (!force && isFresh(cached, want, now)) return { status: "ok", stale: false, ...cached };
  let coords, name = null;
  if (want === "auto") {
    const found = await locate(geolocation);
    if (found.error) {
      return found.error !== "denied" && cached ? { status: "ok", stale: true, ...cached } : { status: "no-place", want };
    }
    coords = found;
  } else {
    coords = { lat: roundCoord(place.lat), lon: roundCoord(place.lon) };
    name = place.name;
  }
  const key = placeKey(coords);
  let data;
  try { data = parseForecast(await getJson(fetch, forecastUrl(coords))); }
  catch (error) {
    console.warn("Foxy: could not load weather", error);
    return cached ? { status: "ok", stale: true, ...cached } : { status: "error", want };
  }
  if (want === "auto") name = cached?.key === key && cached.place ? cached.place : await reverseName(coords, fetch);
  const entry = { want, key, place: name, fetchedAt: now, data };
  try { await api.storage.local.set({ [CACHE_KEY]: entry }); }
  catch (error) { console.warn("Foxy: could not save weather", error); }
  return { status: "ok", stale: false, ...entry };
}
