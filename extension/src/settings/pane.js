import { resetBoard } from '../kanban/store.js';
import { saveSetting, cardAlpha } from "./store.js";
import { searchPlaces } from "../weather/location.js";
import { hasConsent, requestConsent, watchConsent } from "../weather/consent.js";

const panes = new WeakMap();
let sequence = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text) {
  const node = el("button", "", text); node.type = "button"; return node;
}

// Both pages use the same stores and the same failure rollback. A successful
// save is applied to the board only by its existing storage-change listener.
export function settingActions(api, onReset, fetch) {
  return {
    onChange(scope, key, value) { return saveSetting(api, scope, key, value); },
    onReset,
    // A searched city is location data too: nothing is sent before the grant.
    searchPlaces: async query => (await hasConsent(api) ? searchPlaces(query, fetch) : []),
    weatherAllowed: () => hasConsent(api),
    allowWeather: () => requestConsent(api),
    allowMyLocation: () => requestConsent(api, "auto"),
    watchWeather: listener => watchConsent(api, listener),
  };
}

export async function resetLayout(api) {
  await resetBoard(api);
}

/** Shared pane. Repeated calls update values without replacing focused nodes. */
export function renderSettings(container, state, handlers) {
  let pane = panes.get(container);
  if (!pane) {
    pane = { state, handlers, controls: [], confirmed: false, timer: 0, saving: new Map() };
    panes.set(container, pane);
    const scroll = el("div", "settings-scroll"); scroll.tabIndex = -1;
    container.replaceChildren(scroll);
    // pane.state holds stored values only (from storage or a successful save).
    // After a failure the control shows the stored value again, but only once
    // no later save for the same key is still in flight.
    const change = async (scope, key, value) => {
      const id = `${scope}:${key}`;
      pane.saving.set(id, (pane.saving.get(id) ?? 0) + 1);
      try {
        const stored = await pane.handlers.onChange(scope, key, value);
        if (stored) renderSettings(container, { ...pane.state, ...stored }, pane.handlers);
      } catch (error) {
        console.warn("Foxy: could not change setting", error);
        if (pane.saving.get(id) === 1) update();
      } finally {
        pane.saving.set(id, pane.saving.get(id) - 1);
      }
    };
    function section(title) {
      const node = el("section", "settings-section");
      node.append(el("h2", "settings-title", title)); scroll.append(node); return node;
    }
    function label(section, text, device = false) {
      const row = el("div", "setting"), title = el("div", "setting-label", text);
      title.id = `setting-${++sequence}`; row.append(title);
      let caption;
      if (device) {
        caption = el("small", "setting-caption", "This device only");
        caption.id = `setting-${++sequence}`; row.append(caption);
      }
      section.append(row); return { row, title, caption };
    }
    function segmented(section, text, scope, key, choices, device = false) {
      const { row, title, caption } = label(section, text, device), group = el("div", "settings-segmented");
      if (caption) group.setAttribute("aria-describedby", caption.id);
      group.dataset.key = key; group.setAttribute("role", "group"); group.setAttribute("aria-labelledby", title.id);
      for (const [value, text] of choices) {
        const node = button(text); node.dataset.value = value;
        node.addEventListener("click", () => {
          if (pane.state[scope][key] !== value) change(scope, key, value);
        });
        group.append(node);
      }
      row.append(group);
      pane.controls.push(() => {
        for (const node of group.children) node.setAttribute("aria-pressed", String(node.dataset.value === pane.state[scope][key]));
      });
    }
    function toggle(section, text, key) {
      const { row, title } = label(section, text), node = button("");
      row.classList.add("setting-toggle"); node.className = "settings-toggle"; node.dataset.key = key;
      node.setAttribute("role", "switch"); node.setAttribute("aria-labelledby", title.id);
      node.addEventListener("click", () => {
        const before = node.getAttribute("aria-checked") === "true";
        node.setAttribute("aria-checked", String(!before));
        change("synced", key, !before);
      }); row.append(node);
      pane.controls.push(() => node.setAttribute("aria-checked", String(pane.state.synced[key])));
    }
    const tiles = section("Widgets");
    toggle(tiles, "Show clock", "showClock"); toggle(tiles, "Show pinned", "showPinned"); toggle(tiles, "Show saved", "showSaved");
    toggle(tiles, "Show memory", "showMemory");
    toggle(tiles, "Show weather", "showWeather");
    tiles.append(el("p", "settings-help", "Reset restores widget and group order, heights and both bar widths."));
    const reset = button("Reset layout"); reset.className = "settings-reset settings-pill"; tiles.append(reset);
    const clearConfirm = () => { clearTimeout(pane.timer); pane.confirmed = false; reset.textContent = "Reset layout"; };
    reset.addEventListener("keydown", event => {
      if (event.repeat && ["Enter", " "].includes(event.key)) event.preventDefault();
    });
    reset.addEventListener("click", async event => {
      if (event.detail > 1) return;
      if (!pane.confirmed) {
        pane.confirmed = true; pane.armedAt = performance.now();
        reset.textContent = "Confirm reset"; pane.timer = setTimeout(clearConfirm, 3000); return;
      }
      if (performance.now() - pane.armedAt < 400) return;
      clearConfirm(); reset.disabled = true;
      try { await pane.handlers.onReset(); }
      catch (error) { console.warn("Foxy: could not reset layout", error); }
      finally { reset.disabled = false; }
    });
    const clock = section("Clock");
    segmented(clock, "Time format", "synced", "timeFormat", [["24", "24-hour"], ["12", "12-hour"]]);
    toggle(clock, "Show date", "showDate");
    weatherSection(section("Weather"));
    const cards = section("Cards");
    segmented(cards, "Transparency", "synced", "transparency", [["low", "Low"], ["medium", "Medium"], ["high", "High"]]);
    segmented(cards, "Row density", "device", "density", [["normal", "Normal"], ["compact", "Compact"]], true);
    const windows = section("Windows");
    toggle(windows, "Show tabs and groups from other windows", "otherWindows");
    toggle(windows, "Switch to an open tab instead of opening a duplicate", "switchToOpenTab");
    toggle(section("Pins"), "Clicking a pin from another window moves it here", "pinsMoveHere");
    function edges() {
      container.classList.toggle("scroll-start", scroll.scrollTop > 0);
      container.classList.toggle("scroll-end", scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop >= 1);
    }
    scroll.addEventListener("scroll", edges, { passive: true });
    new ResizeObserver(edges).observe(scroll);
    pane.updateEdges = edges;
    function update() { for (const control of pane.controls) control(); }
    function weatherSection(weather) {
      segmented(weather, "Temperature", "synced", "tempUnit", [["C", "°C"], ["F", "°F"]]);
      const { row, title, caption } = label(weather, "Location", true);
      row.classList.add("setting-place");
      const current = el("output", "weather-current");
      current.setAttribute("aria-labelledby", title.id);
      const search = el("div", "weather-search"), input = el("input", "settings-text");
      input.type = "search"; input.placeholder = "Search a city"; input.autocomplete = "off"; input.spellcheck = false;
      input.setAttribute("aria-label", "Search a city"); input.setAttribute("aria-describedby", caption.id);
      const results = el("div", "weather-results"); results.setAttribute("role", "group"); results.setAttribute("aria-label", "Matching places");
      const auto = el("button", "weather-auto settings-pill", "Use my location"); auto.type = "button";
      // A searched city is location data: until locationInfo is granted the field is a pill that asks.
      const allow = el("button", "weather-allow settings-pill", "Allow weather"); allow.type = "button";
      search.append(allow, input, results);
      row.append(current, search, auto);
      let timer = 0, token = 0, found = { query: null, places: [] }, allowed = !pane.handlers.weatherAllowed;
      const setAllowed = value => {
        allowed = value === true;
        allow.hidden = allowed; input.hidden = !allowed;
        if (!allowed) { clearTimeout(timer); ++token; results.replaceChildren(); found = { query: null, places: [] }; }
      };
      setAllowed(allowed);
      pane.handlers.weatherAllowed?.().then(setAllowed, () => setAllowed(false));
      pane.handlers.watchWeather?.(setAllowed);
      // permissions.request needs the click: it runs here, before any await.
      allow.addEventListener("click", () => {
        pane.handlers.allowWeather?.().then(granted => { if (granted) { setAllowed(true); input.focus(); } });
      });
      const pick = place => {
        clearTimeout(timer); ++token;
        input.value = ""; results.replaceChildren(); found = { query: null, places: [] };
        change("device", "weatherPlace", { name: place.name, lat: place.lat, lon: place.lon });
      };
      async function run(query) {
        if (!allowed) return null;
        const mine = ++token;
        let places = [];
        try { places = await pane.handlers.searchPlaces?.(query) ?? []; }
        catch (error) { console.warn("Foxy: city search failed", error); }
        if (mine !== token) return null;
        found = { query, places };
        results.replaceChildren(...places.map(place => {
          const option = el("button", "weather-result"); option.type = "button";
          option.append(el("span", "weather-result-name", place.name), el("span", "weather-result-detail", place.detail ?? ""));
          option.addEventListener("click", () => pick(place));
          return option;
        }));
        return places;
      }
      input.addEventListener("input", () => {
        clearTimeout(timer); ++token;
        const query = input.value.trim();
        if (query.length < 2) { results.replaceChildren(); found = { query: null, places: [] }; return; }
        timer = setTimeout(() => run(query), 300);
      });
      input.addEventListener("keydown", async event => {
        if (event.key !== "Enter" || event.isComposing) return;
        event.preventDefault();
        const query = input.value.trim();
        if (query.length < 2 || !allowed) return;
        clearTimeout(timer);
        const places = found.query === query ? found.places : await run(query);
        if (places?.length && input.value.trim() === query) pick(places[0]);
      });
      auto.addEventListener("click", () => {
        // Ask in this click (it must run before any await); switch only on a grant so a decline keeps the city.
        const asked = pane.handlers.allowMyLocation?.() ?? Promise.resolve(true);
        asked.then(granted => { if (granted) change("device", "weatherPlace", "auto"); }, () => {});
      });
      pane.controls.push(() => {
        const place = pane.state.device.weatherPlace;
        current.textContent = place && place !== "auto" ? place.name : "Current location";
        auto.disabled = !place || place === "auto";
      });
    }
  }
  pane.state = state; pane.handlers = handlers;
  for (const control of pane.controls) control();
  for (const scheme of ["dark", "light"]) container.style.setProperty(`--card-alpha-${scheme}`, cardAlpha(state.synced.transparency, scheme));
  pane.updateEdges();
}
