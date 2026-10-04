// Weather tile: rendering (container queries pick the tier in CSS) and the
// refresh loop. Network, clock, geolocation and visibility are injected.
import { condition, GLYPHS } from "../weather/codes.js";
import { loadWeather, readCache, wantOf, validCache, temperature, wind, updatedAgo, upcomingHours, upcomingDays,
  hourLabel, dayLabel, REFRESH_MS, CACHE_KEY } from "../weather/data.js";
import { hasConsent, requestConsent, watchConsent } from "../weather/consent.js";

const SVG = "http://www.w3.org/2000/svg";
const states = new WeakMap();
const controllers = new WeakMap();
const observers = new WeakMap();
// Per board: the hourly strip's scroll position, kept across repaints while
// the strip starts at the same hour.
const scrolls = new WeakMap();
// Interface glyphs, drawn like the weather glyphs.
const ICONS = {
  // A clockwise arc from the right round to the top right, with its arrowhead there.
  retry: [["path", { d: "M19 12a7 7 0 1 1-2.05-4.95" }], ["path", { d: "M16.95 2.55v4.5h-4.5" }]],
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let masks = 0;
export function glyph(name, className = "weather-glyph") {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.dataset.glyph = name;
  let mask = null;
  for (const [tag, { accent, fill, behind, ...attributes }] of GLYPHS[name] ?? ICONS[name] ?? GLYPHS.cloudy) {
    if (tag === "cutout") {
      // Everything except the cloud and a margin around its outline.
      mask = `foxy-glyph-${++masks}`;
      const node = document.createElementNS(SVG, "mask"), all = document.createElementNS(SVG, "rect"), cloud = document.createElementNS(SVG, "path");
      node.id = mask; node.setAttribute("maskUnits", "userSpaceOnUse");
      for (const [key, value] of Object.entries({ x: -2, y: -2, width: 28, height: 28, fill: "white" })) all.setAttribute(key, value);
      for (const [key, value] of Object.entries({ d: attributes.d, fill: "black", stroke: "black", "stroke-width": 3 })) cloud.setAttribute(key, value);
      node.append(all, cloud);
      svg.append(node);
      continue;
    }
    const shape = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);
    const classes = [accent ? `accent-${accent}` : "", fill ? "solid" : ""].filter(Boolean).join(" ");
    if (classes) shape.setAttribute("class", classes);
    if (behind && mask) shape.setAttribute("mask", `url(#${mask})`);
    svg.append(shape);
  }
  return svg;
}

export function weatherTile() {
  const tile = el("section", "weather");
  tile.setAttribute("aria-label", "Weather");
  tile.dataset.state = "loading";
  tile.append(el("div", "weather-body tile-grab"));
  return tile;
}

const degrees = (celsius, unit) => `${temperature(celsius, unit)}°`;

function message(body, text, retry) {
  body.append(el("p", "weather-message", text));
  if (retry) {
    // Below 80 px wide only the round glyph shows (CSS).
    const button = el("button", "weather-retry settings-pill");
    button.type = "button";
    button.setAttribute("aria-label", "Retry");
    button.title = "Retry";
    button.append(glyph("retry", "weather-retry-glyph"), el("span", "weather-retry-text", "RETRY"));
    body.append(button);
  }
}

/** Fill one tile from a state; pure DOM, no requests. Focus inside the tile stays on the same control. */
export function renderWeather(tile, state, settings = {}, now = Date.now()) {
  const body = tile.querySelector(".weather-body") ?? tile.appendChild(el("div", "weather-body tile-grab"));
  const focused = body.contains(document.activeElement) ? document.activeElement.className : null;
  fill(tile, body, state, settings, now);
  if (focused !== null) [...body.querySelectorAll("button, [tabindex]")].find(node => node.className === focused)?.focus();
}

function fill(tile, body, state, settings, now) {
  const unit = settings.tempUnit === "F" ? "F" : "C";
  body.replaceChildren();
  tile.dataset.state = state?.status ?? "loading";
  tile.toggleAttribute("data-stale", !!state?.stale);
  if (state?.status === "consent") {
    body.append(el("p", "weather-message", state.want === "auto" ? "Uses your approximate location" : "Uses your chosen location"));
    // Below 100 px wide only "Allow" shows, under a small cloud (CSS).
    const allow = el("button", "weather-allow settings-pill");
    allow.type = "button";
    allow.setAttribute("aria-label", "Allow weather");
    allow.title = "Allow weather";
    const label = el("span", "weather-allow-label", "Allow");
    label.append(el("span", "weather-allow-more", " weather"));
    allow.append(glyph("cloudy", "weather-allow-glyph"), label);
    body.append(allow);
    return;
  }
  if (state?.status === "no-place") { message(body, "Set a location in Settings"); return; }
  if (state?.status === "error") { message(body, "Weather is unavailable", true); return; }
  if (state?.status !== "ok") { body.append(el("p", "weather-message weather-loading", "Loading weather")); return; }

  const { data } = state, current = data.current;
  const now_ = condition(current.code, current.isDay);
  const days = upcomingDays(data, now), today = days[0];

  const top = el("div", "weather-top");
  top.append(el("div", "weather-place", state.place ?? ""));
  const updated = el("div", "weather-updated", updatedAgo(Math.max(0, now - state.fetchedAt)));
  updated.hidden = !state.stale && now - state.fetchedAt < 2 * REFRESH_MS;
  top.append(updated);

  const hero = el("div", "weather-now");
  hero.append(glyph(now_.glyph), el("div", "weather-temp", degrees(current.temp, unit)));
  hero.lastChild.setAttribute("aria-label", `${degrees(current.temp, unit)} ${unit === "F" ? "Fahrenheit" : "Celsius"}`);
  // "Overcast · 30° / 21°" on one line under the reading.
  const summary = el("div", "weather-summary");
  summary.append(el("span", "weather-condition", now_.label));
  if (today) {
    const range = el("span", "weather-range");
    range.append(el("span", "weather-hi", degrees(today.max, unit)), el("span", "weather-lo", ` / ${degrees(today.min, unit)}`));
    range.setAttribute("aria-label", `High ${degrees(today.max, unit)}, low ${degrees(today.min, unit)}`);
    summary.append(el("span", "weather-sep", " · "), range);
  }

  // One line; facts that do not fit the width wrap out of sight, whole.
  const details = el("div", "weather-details");
  const facts = [];
  if (current.feels !== null) facts.push(`Feels like ${degrees(current.feels, unit)}`);
  if (current.wind !== null) { const w = wind(current.wind, unit); facts.push(`Wind ${w.value} ${w.unit}`); }
  if (current.humidity !== null) facts.push(`Humidity ${Math.round(current.humidity)} %`);
  if (current.precipitation !== null && current.precipitation > 0) {
    facts.push(unit === "F" ? `Precip ${(current.precipitation / 25.4).toFixed(2)} in` : `Precip ${current.precipitation} mm`);
  }
  for (const [i, fact] of facts.entries()) {
    const item = el("span", "weather-fact");
    if (i) item.append(el("span", "weather-sep", " · "));
    item.append(fact);
    details.append(item);
  }

  const hours = el("div", "weather-hours");
  // Focusable so the arrow keys can scroll it; a vertical wheel scrolls it too.
  hours.tabIndex = 0;
  hours.setAttribute("aria-label", "Next 24 hours");
  const upcoming = upcomingHours(data, now);
  hours.dataset.first = String(upcoming[0]?.time ?? "");
  for (const [i, hour] of upcoming.entries()) {
    // The first slot is now: it shows the current reading, as the hero does.
    const item = el("div", "weather-hour"), shown = i === 0 ? current : hour;
    item.append(el("div", "weather-hour-time", i === 0 ? "Now" : hourLabel(hour.time, data, settings.timeFormat)),
      glyph(condition(shown.code, shown.isDay).glyph, "weather-hour-glyph"),
      el("div", "weather-hour-temp", degrees(shown.temp, unit)));
    const pop = el("div", "weather-hour-pop", hour.pop >= 20 ? `${Math.round(hour.pop / 10) * 10}%` : "");
    item.append(pop);
    hours.append(item);
  }

  const list = el("ol", "weather-days");
  if (days.length) {
    const low = Math.min(...days.map(day => day.min)), high = Math.max(...days.map(day => day.max));
    const span = Math.max(1, high - low), at = value => `${((value - low) / span * 100).toFixed(2)}%`;
    for (const [i, day] of days.entries()) {
      const row = el("li", "weather-day"), bar = el("div", "weather-bar"), fill = el("div", "weather-bar-fill");
      fill.style.left = at(day.min);
      fill.style.right = `${(100 - (day.max - low) / span * 100).toFixed(2)}%`;
      bar.append(fill);
      if (i === 0) {
        const dot = el("div", "weather-bar-now");
        dot.style.left = at(Math.min(high, Math.max(low, current.temp)));
        bar.append(dot);
      }
      const { label, glyph: name } = condition(day.code, true);
      const icon = glyph(name, "weather-day-glyph");
      icon.removeAttribute("aria-hidden");
      icon.setAttribute("role", "img");
      icon.setAttribute("aria-label", label);
      row.append(el("span", "weather-day-name", i === 0 ? "Today" : dayLabel(day.time, data)), icon,
        el("span", "weather-day-min", degrees(day.min, unit)), bar, el("span", "weather-day-max", degrees(day.max, unit)));
      list.append(row);
    }
  }
  body.append(top, hero, summary, details, hours, list);
  edges(hours);
  hours.addEventListener("scroll", () => edges(hours), { passive: true });
  hours.addEventListener("wheel", wheel);
  hours.addEventListener("keydown", keys);
}

const SLOT = 42; // one hour: 40 px slot and 2 px gap

// A vertical wheel scrolls the strip sideways while it can move that way;
// otherwise the event is left alone and the board scrolls.
function wheel(event) {
  const strip = event.currentTarget;
  if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1);
  const extent = strip.scrollWidth - strip.clientWidth;
  if (delta > 0 ? strip.scrollLeft >= extent - 0.5 : strip.scrollLeft <= 0.5) return;
  event.preventDefault();
  strip.scrollLeft += delta;
}

function keys(event) {
  const strip = event.currentTarget;
  const step = { ArrowRight: SLOT, ArrowLeft: -SLOT, PageDown: strip.clientWidth, PageUp: -strip.clientWidth }[event.key];
  if (event.key === "Home" || event.key === "End") strip.scrollLeft = event.key === "Home" ? 0 : strip.scrollWidth;
  else if (step) strip.scrollLeft += step;
  else return;
  event.preventDefault();
}

function edges(node) {
  const extent = node.scrollWidth - node.clientWidth;
  node.toggleAttribute("data-scroll-start", extent > 0 && node.scrollLeft > 0);
  node.toggleAttribute("data-scroll-end", extent > 0 && extent - node.scrollLeft >= 1);
}

/** Paint `state` into the board's tile, keeping the strip's scroll for the same first hour. */
function paintTile(root, tile, state, settings, now) {
  renderWeather(tile, state, settings, now);
  const strip = tile.querySelector(".weather-hours");
  if (!strip) return;
  const kept = scrolls.get(root);
  if (kept && kept.first === strip.dataset.first && kept.left > 0) { strip.scrollLeft = kept.left; edges(strip); }
  strip.addEventListener("scroll", () => scrolls.set(root, { first: strip.dataset.first, left: strip.scrollLeft }), { passive: true });
}

/** Remember a state for this board and paint it. */
export function showWeatherState(root, state, settings, now) {
  states.set(root, state);
  const tile = root.querySelector(".weather");
  if (tile) paintTile(root, tile, state, settings, now ?? Date.now());
}

/** Called after every board render: repaint the new tile and let the loop catch up. */
export function paintWeather(root, settings = {}) {
  const tile = root.querySelector(".weather");
  const control = controllers.get(root);
  observers.get(root)?.disconnect();
  if (tile) {
    paintTile(root, tile, states.get(root), settings, control?.now() ?? Date.now());
    // Resizing the tile changes which hours fit, so the edge fade follows it.
    const observer = new ResizeObserver(() => { const strip = tile.querySelector(".weather-hours"); if (strip) edges(strip); });
    observer.observe(tile);
    observers.set(root, observer);
  }
  control?.wake();
}

/**
 * Refresh loop for one board. Requests happen only while the tile is shown,
 * the setting is on and the page is visible; at most every 15 minutes unless
 * the place changes or the user retries.
 */
export function startWeather(root, { api, fetch, geolocation, settings, now = Date.now, hidden = () => document.hidden }) {
  let timer = 0, busy = null, lastAttempt = -Infinity, stopped = false, again = false, revoked = 0;
  const current = () => settings() ?? null;
  const placeWant = () => wantOf(current()?.device?.weatherPlace ?? "auto");
  const paint = () => {
    const s = current();
    showWeatherState(root, states.get(root), s?.synced ?? {}, now());
  };
  // Without the permissions nothing is kept either: cached coordinates, place
  // name and forecast go (the chosen city setting stays).
  const askConsent = () => {
    states.set(root, { status: "consent", want: placeWant() });
    paint();
    Promise.resolve().then(() => api.storage.local.remove(CACHE_KEY))
      .catch(error => console.warn("Foxy: could not clear weather", error));
  };
  async function wake(force = false) {
    clearTimeout(timer);
    const s = current();
    if (stopped || !s?.synced?.showWeather || !root.isConnected || !root.querySelector(".weather") || hidden()) return;
    const place = s.device?.weatherPlace ?? "auto", want = wantOf(place);
    if (busy) { if (busy.want !== want || force) again = true; return; }
    const state = states.get(root), age = now() - lastAttempt, waiting = state?.status === "consent";
    if (!force && state && !waiting && state.want === want && age < REFRESH_MS) {
      timer = setTimeout(() => wake(), REFRESH_MS - age);
      return;
    }
    busy = { want };
    const epoch = revoked;
    try {
      // Nothing is shown, located or fetched until locationInfo (and, for my
      // location, geolocation) is granted.
      if (!(await hasConsent(api, want))) {
        if (!stopped && epoch === revoked) askConsent();
        if (again) { again = false; queueMicrotask(() => wake()); }
        return;
      }
      if (stopped || epoch !== revoked) return;
      lastAttempt = now();
      if (!state || state.want !== want || waiting) {
        // Show a cached reading for this place at once, then refresh it.
        const cache = await readCache(api);
        if (stopped || epoch !== revoked) return;
        states.set(root, cache?.want === want ? { status: "ok", stale: false, ...cache } : { status: "loading", want });
        paint();
      }
      const result = await loadWeather({ api, fetch, geolocation, place, now: now(), force });
      if (stopped || epoch !== revoked) return;
      if (placeWant() === want) { states.set(root, result); paint(); }
      if (result.status === "consent") return;
    } catch (error) {
      console.warn("Foxy: weather refresh failed", error);
    } finally { busy = null; }
    if (again) { again = false; lastAttempt = -Infinity; return wake(); }
    timer = setTimeout(() => wake(), REFRESH_MS);
  }
  const onStorage = (changes, area) => {
    if (area !== "local" || !changes[CACHE_KEY]) return;
    const entry = changes[CACHE_KEY].newValue, state = states.get(root);
    if (!validCache(entry) || entry.want !== placeWant() || state?.status === "consent") return;
    if (state?.status === "ok" && state.fetchedAt >= entry.fetchedAt) return;
    states.set(root, { status: "ok", stale: false, ...entry });
    paint();
  };
  const onVisible = () => { if (hidden()) clearTimeout(timer); else wake(); };
  const onClick = event => {
    if (event.target.closest?.(".weather-retry")) wake(true);
    // permissions.request needs the click: it runs here, before any await.
    if (event.target.closest?.(".weather-allow")) requestConsent(api, placeWant()).then(granted => { if (granted) wake(); });
  };
  // Granted or revoked anywhere, including about:addons. Geolocation matters
  // only for my location.
  const unwatch = watchConsent(api, (granted, which) => {
    if (stopped) return;
    if (granted) { wake(); return; }
    if (!which.has("locationInfo") && placeWant() !== "auto") return;
    revoked++; again = false; clearTimeout(timer);
    askConsent();
  }, ["locationInfo", "geolocation"]);
  api.storage.onChanged.addListener(onStorage);
  document.addEventListener("visibilitychange", onVisible);
  root.addEventListener("click", onClick);
  const control = {
    wake: (force = false) => { wake(force); },
    now,
    stop() {
      stopped = true; clearTimeout(timer);
      unwatch();
      api.storage.onChanged.removeListener(onStorage);
      document.removeEventListener("visibilitychange", onVisible);
      root.removeEventListener("click", onClick);
      if (controllers.get(root) === control) controllers.delete(root);
    },
  };
  controllers.set(root, control);
  return control;
}
