// Preview only: the same stateful Firefox fake used by Node and DOM tests.
import { createFirefox } from "../test/fakes/firefox.js";
import { SCENARIOS } from "./fixtures.js";
import { forecastJson, fakeFetch, fakeGeolocation } from "../test/fakes/weather.js";

// Weather from fixtures: no network and no real location in previews.
const midnight = Math.floor(Date.now() / 86400000) * 86400;
globalThis.fetch = fakeFetch({ forecast: forecastJson({ start: midnight, offset: -new Date().getTimezoneOffset() * 60 }) });
Object.defineProperty(navigator, "geolocation", { configurable: true, value: fakeGeolocation() });

const params = new URLSearchParams(location.search);
const name = params.get("scenario") ?? "one-window";
const scenario = SCENARIOS[name];
if (!scenario) throw new Error(`Unknown preview scenario: ${name}`);

const scheme = params.get("scheme") ?? (name === "light" ? "light" : "dark");
document.documentElement.dataset.scheme = scheme;
document.documentElement.style.colorScheme = scheme;

const self = { id: 999, windowId: 1, index: 999, title: "New Tab", url: location.origin + location.pathname };
const ff = createFirefox({ ...scenario, tabs: [...scenario.tabs, self], selfTabId: self.id });
ff.browser.runtime.onMessage.addListener(message => {
  if (message?.type === "foxy:saved") {
    return { saved: scenario.saved ?? [], missing: scenario.missing ?? [],
      ...(scenario.folders ? { folders: scenario.folders } : {}) };
  }
});
if (scenario.layout) {
  const k = scenario.layoutWidth ?? 9;
  await ff.browser.storage.sync.set({ [`layout:${k}`]: { t: 1 },
    ...Object.fromEntries(Object.entries(scenario.layout).map(([id, rect]) => [`tile:${k}:${id}`, rect])),
    ...(scenario.syncedSettings ? { settings: scenario.syncedSettings } : {}) });
  await ff.browser.storage.local.set({ deviceSettings: scenario.deviceSettings });
}
globalThis.browser = ff.browser;

// Open the real pane through its gear once main.js has rendered the board.
if (params.get("settings") === "open") {
  const observer = new MutationObserver(() => {
    const gear = document.querySelector(".settings-cell");
    if (!gear) return;
    observer.disconnect();
    gear.click();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
