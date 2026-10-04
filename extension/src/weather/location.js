// Where the weather is for. Coordinates are rounded to 2 decimals (about 1 km)
// before they leave this module, so no request carries a precise position.

export const roundCoord = value => Math.round(value * 100) / 100 + 0;

export const placeKey = ({ lat, lon }) => `${roundCoord(lat)},${roundCoord(lon)}`;

const finite = (value, limit) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;

/** Device setting `weatherPlace`: "auto" (geolocation) or a place chosen by search. */
export function validPlace(value) {
  if (value === "auto") return true;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof value.name === "string" && value.name.trim().length > 0 && value.name.length <= 200
    && finite(value.lat, 90) && finite(value.lon, 180);
}

/** The current position, rounded; or why there is none. Never prompts (manifest permission). */
export function locate(geolocation, { timeout = 15000 } = {}) {
  if (!geolocation?.getCurrentPosition) return Promise.resolve({ error: "denied" });
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ error: "unavailable" }), timeout + 1000);
    const done = value => { clearTimeout(timer); resolve(value); };
    try {
      geolocation.getCurrentPosition(
        position => done({ lat: roundCoord(position.coords.latitude), lon: roundCoord(position.coords.longitude) }),
        error => done({ error: error?.code === 1 ? "denied" : "unavailable" }),
        { enableHighAccuracy: false, maximumAge: 30 * 60000, timeout },
      );
    } catch { done({ error: "unavailable" }); }
  });
}

export async function getJson(fetch, url, ms = 10000) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

/** Open-Meteo geocoding: up to 5 places for a city name. */
export async function searchPlaces(query, fetch) {
  const name = String(query ?? "").trim();
  if (name.length < 2 || !fetch) return [];
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.search = new URLSearchParams({ name, count: "5", language: "en", format: "json" });
  const reply = await getJson(fetch, url.href);
  const results = Array.isArray(reply?.results) ? reply.results : [];
  return results.filter(result => typeof result?.name === "string" && finite(result.latitude, 90) && finite(result.longitude, 180))
    .slice(0, 5).map(result => ({
      name: result.name.slice(0, 200),
      detail: [result.admin1, result.country].filter(part => typeof part === "string" && part && part !== result.name).join(", "),
      lat: roundCoord(result.latitude), lon: roundCoord(result.longitude),
    }));
}

/** BigDataCloud's free client reverse geocoder: a place name, or null. */
export async function reverseName(coords, fetch) {
  try {
    const url = new URL("https://api.bigdatacloud.net/data/reverse-geocode-client");
    url.search = new URLSearchParams({ latitude: roundCoord(coords.lat), longitude: roundCoord(coords.lon), localityLanguage: "en" });
    const reply = await getJson(fetch, url.href);
    const name = [reply?.city, reply?.locality, reply?.principalSubdivision].find(part => typeof part === "string" && part.trim());
    return name ? name.trim().slice(0, 200) : null;
  } catch { return null; }
}
