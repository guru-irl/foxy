// Open-Meteo forecast reply shaped like `timeformat=unixtime`, `timezone=auto`.
// `start` is the location's local midnight of the first day, in Unix seconds.
export function forecastJson({ start = 1790985600, offset = 3600, temp = 14.4 } = {}) {
  const hours = Array.from({ length: 168 }, (_, i) => start - offset + i * 3600);
  const codes = [0, 1, 2, 3, 45, 51, 61, 80, 71, 95];
  const days = Array.from({ length: 7 }, (_, i) => start - offset + i * 86400);
  return {
    latitude: 38.72, longitude: -9.14, timezone: "Europe/Lisbon", utc_offset_seconds: offset,
    current: { time: start - offset + 13 * 3600 + 900, interval: 900, temperature_2m: temp,
      apparent_temperature: temp - 2.1, weather_code: 2, is_day: 1, wind_speed_10m: 18.7,
      relative_humidity_2m: 71, precipitation: 0.2 },
    hourly: {
      time: hours,
      temperature_2m: hours.map((_, i) => Math.round((10 + 6 * Math.sin((i % 24 - 9) / 24 * 2 * Math.PI)) * 10) / 10),
      weather_code: hours.map((_, i) => codes[i % codes.length]),
      precipitation_probability: hours.map((_, i) => (i * 7) % 100),
      is_day: hours.map((_, i) => (i % 24 >= 7 && i % 24 < 19 ? 1 : 0)),
    },
    daily: {
      time: days,
      weather_code: [2, 61, 3, 0, 80, 71, 95],
      temperature_2m_max: [17.2, 15.1, 13.8, 19.4, 16, 9.5, 14.2],
      temperature_2m_min: [8.4, 9.2, 6.1, 10.3, 7.7, 1.2, 5.5],
      sunrise: days.map(day => day + 7 * 3600 + 1800),
      sunset: days.map(day => day + 19 * 3600),
    },
  };
}

export const GEOCODING = { results: [
  { name: "Lisbon", latitude: 38.7223, longitude: -9.1393, country: "Portugal", admin1: "Lisbon" },
  { name: "Lisbon", latitude: 44.21, longitude: -71.91, country: "United States", admin1: "New Hampshire" },
  { name: "Lisbon", latitude: 40.77, longitude: -80.77, country: "United States", admin1: "Ohio" },
] };

export const REVERSE = { city: "Lisbon", locality: "Lisbon", principalSubdivision: "Lisbon", countryName: "Portugal" };

/** A fetch that answers from fixtures and records every requested URL. */
export function fakeFetch({ forecast = forecastJson(), fail = false } = {}) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push(String(url));
    if (options?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (typeof fail === "function" ? fail(String(url)) : fail) throw new TypeError("NetworkError when attempting to fetch resource.");
    const host = new URL(url).host;
    const body = host === "api.open-meteo.com" ? forecast
      : host === "geocoding-api.open-meteo.com" ? GEOCODING
      : host === "api.bigdatacloud.net" ? REVERSE : null;
    return { ok: body !== null, status: body ? 200 : 404, json: async () => structuredClone(body) };
  };
  fetch.calls = calls;
  return fetch;
}

/** navigator.geolocation stand-in: a position, or an error code (1 denied, 2 unavailable, 3 timeout). */
export function fakeGeolocation({ lat = 38.71567, lon = -9.13789, error } = {}) {
  const geolocation = {
    calls: 0,
    getCurrentPosition(success, failure) {
      geolocation.calls++;
      queueMicrotask(() => error
        ? failure?.({ code: error, message: "fake" })
        : success({ coords: { latitude: lat, longitude: lon, accuracy: 20 }, timestamp: Date.now() }));
    },
  };
  return geolocation;
}
