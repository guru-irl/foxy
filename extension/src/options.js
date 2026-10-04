import { renderSettings, settingActions, resetLayout } from "./settings/pane.js";
import { loadSettings, cellPx } from "./settings/store.js";
import { totalColumns, railLimits } from "./grid/layout.js";
import { watchStorage } from "./grid/store.js";

export async function createOptions(container, api) {
  let version = 0;
  const handlers = settingActions(api, () => resetLayout(api), globalThis.fetch?.bind(globalThis));
  async function refresh() {
    const mine = ++version, settings = await loadSettings(api);
    if (mine !== version) return;
    renderSettings(container, { ...settings,
      railMax: railLimits(totalColumns(screen.availWidth - 96, cellPx(settings.device))).max }, handlers);
  }
  const unwatch = watchStorage(api, refresh);
  window.addEventListener("pagehide", unwatch, { once: true });
  await refresh();
}

const container = document.querySelector(".settings-pane");
if (container && globalThis.browser) createOptions(container, globalThis.browser);
