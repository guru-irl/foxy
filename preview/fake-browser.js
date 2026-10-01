// Preview only: the same stateful Firefox fake used by Node and DOM tests.
import { createFirefox } from "../test/fakes/firefox.js";
import { SCENARIOS } from "./fixtures.js";

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
    return { saved: scenario.saved ?? [], missing: scenario.missing ?? [] };
  }
});
globalThis.browser = ff.browser;
