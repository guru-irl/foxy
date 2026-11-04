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
// Weather is allowed (locationInfo and geolocation granted) unless the preview asks to show the request.
const ask = params.get("weather") === "ask";
const dataCollection = ask ? [] : ["locationInfo"];
const ff = createFirefox({ ...scenario, tabs: [...scenario.tabs, self], selfTabId: self.id, dataCollection, permissions: ask ? [] : ["geolocation"] });
ff.browser.runtime.onMessage.addListener(message => {
  if (message?.type === 'foxy:memory') return {firefox:3650722202,system:{total:51539607552,used:36593121362}};
  if (message?.type === 'foxy:reconcile' && name.startsWith('v40')) return {ok:true};
  if (message?.type === "foxy:saved") {
    return { saved: scenario.saved ?? [], missing: scenario.missing ?? [],
      ...(scenario.folders ? { folders: scenario.folders } : {}) };
  }
});
if (scenario.board || scenario.syncedSettings) {
  await ff.browser.storage.sync.set({ ...(scenario.board ? {board:scenario.board} : {}),
    ...(scenario.syncedSettings ? {settings:scenario.syncedSettings} : {}) });
}
if (scenario.deviceSettings) await ff.browser.storage.local.set({ deviceSettings: scenario.deviceSettings });
globalThis.browser = ff.browser;

// Open the real pane through its gear once main.js has rendered the board.
if (params.get("settings") === "open") {
  const observer = new MutationObserver(() => {
    const gear = document.querySelector(".settings-gear");
    if (!gear) return;
    observer.disconnect();
    gear.click();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
