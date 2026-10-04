// Weather tile: rendering (container queries pick the tier in CSS) and the
// refresh loop. Network, clock, geolocation and visibility are injected.
import { condition, GLYPHS } from "../weather/codes.js";
import { loadWeather, readCache, wantOf, validCache, temperature, wind, updatedAgo, upcomingHours, upcomingDays,
  REFRESH_MS, CACHE_KEY } from "../weather/data.js";

const SVG = "http://www.w3.org/2000/svg";
const states = new WeakMap();
const controllers = new WeakMap();
const observers = new WeakMap();

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
  for (const [tag, { accent, fill, behind, ...attributes }] of GLYPHS[name] ?? GLYPHS.cloudy) {
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

// Wall-clock fields at the forecast location.
const local = (ms, offset) => new Date(ms + offset * 1000);
function hourLabel(ms, offset, format) {
  const hour = local(ms, offset).getUTCHours();
  return format === "12" ? `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}` : String(hour).padStart(2, "0");
}
const dayName = (ms, offset) => local(ms, offset).toLocaleDateString("en", { weekday: "short", timeZone: "UTC" });
const degrees = (celsius, unit) => `${temperature(celsius, unit)}°`;

function message(body, text, retry) {
  body.append(el("p", "weather-message", text));
  if (retry) {
    const button = el("button", "weather-retry settings-pill", "RETRY");
    button.type = "button";
    button.setAttribute("aria-label", "Retry loading the weather");
    body.append(button);
  }
}

/** Fill one tile from a state; pure DOM, no requests. */
export function renderWeather(tile, state, settings = {}, now = Date.now()) {
  const unit = settings.tempUnit === "F" ? "F" : "C";
  const body = tile.querySelector(".weather-body") ?? tile.appendChild(el("div", "weather-body tile-grab"));
  body.replaceChildren();
  tile.dataset.state = state?.status ?? "loading";
  tile.toggleAttribute("data-stale", !!state?.stale);
  if (state?.status === "no-place") { message(body, "Set a location in Settings"); return; }
  if (state?.status === "error") { message(body, "Weather is unavailable", true); return; }
  if (state?.status !== "ok") { body.append(el("p", "weather-message weather-loading", "Loading weather")); return; }

  const { data } = state, current = data.current, offset = data.offset;
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
  const summary = el("div", "weather-summary");
  summary.append(el("div", "weather-condition", now_.label));
  if (today) {
    const range = el("div", "weather-range");
    range.append(el("span", "weather-hi", degrees(today.max, unit)), " ", el("span", "weather-lo", degrees(today.min, unit)));
    range.setAttribute("aria-label", `High ${degrees(today.max, unit)}, low ${degrees(today.min, unit)}`);
    summary.append(range);
  }
  if (current.feels !== null) summary.append(el("div", "weather-feels", `Feels like ${degrees(current.feels, unit)}`));
  hero.append(summary);

  const details = el("div", "weather-details");
  const facts = [];
  if (current.wind !== null) { const w = wind(current.wind, unit); facts.push(`Wind ${w.value} ${w.unit}`); }
  if (current.humidity !== null) facts.push(`Humidity ${Math.round(current.humidity)} %`);
  if (current.precipitation !== null && current.precipitation > 0) {
    facts.push(unit === "F" ? `Precip ${(current.precipitation / 25.4).toFixed(2)} in` : `Precip ${current.precipitation} mm`);
  }
  for (const [i, fact] of facts.entries()) {
    if (i) details.append(el("span", "weather-sep", "·"));
    details.append(el("span", "", fact));
  }

  const hours = el("div", "weather-hours");
  hours.tabIndex = -1;
  hours.setAttribute("aria-label", "Next 24 hours");
  for (const [i, hour] of upcomingHours(data, now).entries()) {
    // The first slot is now: it shows the current reading, as the hero does.
    const item = el("div", "weather-hour"), shown = i === 0 ? current : hour;
    item.append(el("div", "weather-hour-time", i === 0 ? "Now" : hourLabel(hour.time, offset, settings.timeFormat)),
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
      icon.setAttribute("aria-label", label);
      row.append(el("span", "weather-day-name", i === 0 ? "Today" : dayName(day.time, offset)), icon,
        el("span", "weather-day-min", degrees(day.min, unit)), bar, el("span", "weather-day-max", degrees(day.max, unit)));
      list.append(row);
    }
  }
  body.append(top, hero, details, hours, list);
  edges(hours);
  hours.addEventListener("scroll", () => edges(hours), { passive: true });
}

function edges(node) {
  const extent = node.scrollWidth - node.clientWidth;
  node.toggleAttribute("data-scroll-start", extent > 0 && node.scrollLeft > 0);
  node.toggleAttribute("data-scroll-end", extent > 0 && extent - node.scrollLeft >= 1);
}

/** Remember a state for this board and paint it. */
export function showWeatherState(root, state, settings, now) {
  states.set(root, state);
  const tile = root.querySelector(".weather");
  if (tile) renderWeather(tile, state, settings, now ?? Date.now());
}

/** Called after every board render: repaint the new tile and let the loop catch up. */
export function paintWeather(root, settings = {}) {
  const tile = root.querySelector(".weather");
  const control = controllers.get(root);
  observers.get(root)?.disconnect();
  if (tile) {
    renderWeather(tile, states.get(root), settings, control?.now() ?? Date.now());
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
  let timer = 0, busy = null, lastAttempt = -Infinity, stopped = false, again = false;
  const current = () => settings() ?? null;
  const paint = () => {
    const s = current();
    showWeatherState(root, states.get(root), s?.synced ?? {}, now());
  };
  async function wake(force = false) {
    clearTimeout(timer);
    const s = current();
    if (stopped || !s?.synced?.showWeather || !root.isConnected || !root.querySelector(".weather") || hidden()) return;
    const place = s.device?.weatherPlace ?? "auto", want = wantOf(place);
    if (busy) { if (busy.want !== want || force) again = true; return; }
    const state = states.get(root), age = now() - lastAttempt;
    if (!force && state && state.want === want && age < REFRESH_MS) {
      timer = setTimeout(() => wake(), REFRESH_MS - age);
      return;
    }
    busy = { want };
    lastAttempt = now();
    try {
      if (!state || state.want !== want) {
        // Show a cached reading for this place at once, then refresh it.
        const cache = await readCache(api);
        if (stopped) return;
        states.set(root, cache?.want === want ? { status: "ok", stale: false, ...cache } : { status: "loading", want });
        paint();
      }
      const result = await loadWeather({ api, fetch, geolocation, place, now: now(), force });
      if (stopped) return;
      if (wantOf(current()?.device?.weatherPlace ?? "auto") === want) { states.set(root, result); paint(); }
    } catch (error) {
      console.warn("Foxy: weather refresh failed", error);
    } finally { busy = null; }
    if (again) { again = false; lastAttempt = -Infinity; return wake(); }
    timer = setTimeout(() => wake(), REFRESH_MS);
  }
  const onStorage = (changes, area) => {
    if (area !== "local" || !changes[CACHE_KEY]) return;
    const entry = changes[CACHE_KEY].newValue, state = states.get(root);
    if (!validCache(entry) || entry.want !== wantOf(current()?.device?.weatherPlace ?? "auto")) return;
    if (state?.status === "ok" && state.fetchedAt >= entry.fetchedAt) return;
    states.set(root, { status: "ok", stale: false, ...entry });
    paint();
  };
  const onVisible = () => { if (!hidden()) wake(); };
  const onClick = event => { if (event.target.closest?.(".weather-retry")) wake(true); };
  api.storage.onChanged.addListener(onStorage);
  document.addEventListener("visibilitychange", onVisible);
  root.addEventListener("click", onClick);
  const control = {
    wake: (force = false) => { wake(force); },
    now,
    stop() {
      stopped = true; clearTimeout(timer);
      api.storage.onChanged.removeListener(onStorage);
      document.removeEventListener("visibilitychange", onVisible);
      root.removeEventListener("click", onClick);
      if (controllers.get(root) === control) controllers.delete(root);
    },
  };
  controllers.set(root, control);
  return control;
}
