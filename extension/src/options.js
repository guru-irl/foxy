import { renderSettings, settingActions, resetLayout } from "./settings/pane.js";
import { loadSettings } from "./settings/store.js";

export async function createOptions(container, api) {
  let version = 0;
  const handlers = settingActions(api, () => resetLayout(api), globalThis.fetch?.bind(globalThis));
  async function refresh() {
    const mine = ++version, settings = await loadSettings(api);
    if (mine !== version) return;
    renderSettings(container, settings, handlers);
  }
  const listener = (changes, area) => {
    if ((area === "sync" && ("settings" in changes || "board" in changes)) || (area === "local" && "deviceSettings" in changes)) refresh();
  };
  api.storage.onChanged.addListener(listener);
  const unwatch = () => api.storage.onChanged.removeListener(listener);
  window.addEventListener("pagehide", unwatch, { once: true });
  await refresh();
}

const container = document.querySelector(".settings-pane");
if (container && globalThis.browser) createOptions(container, globalThis.browser);
