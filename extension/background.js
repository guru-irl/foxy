import { handleMessage } from "./src/close.js";
import { createSync } from "./src/sync/sync.js";

const api = globalThis.browser;
const sync = createSync({ api });

// Register synchronously: Firefox uses these listeners to wake this event page.
// Each controller handler starts the session and runs through its serial queue.
for (const [name, handler] of Object.entries(sync.handlers)) {
  const [namespace, event] = name.split(".");
  const listener = (...args) => {
    handler(...args).catch(() => {}); // Queue failures are already logged.
  };
  if (name === "tabs.onUpdated") {
    try {
      // URL/title changes can arrive while loading; status releases those writes.
      api.tabs.onUpdated.addListener(listener, { properties: ["url", "title", "pinned", "groupId", "status"] });
    } catch (error) {
      console.warn("Foxy: filtered tab updates unavailable, listening to all updates", error);
      try { api.tabs.onUpdated.addListener(listener); }
      catch (fallbackError) { console.warn("Foxy: could not listen to tab updates", fallbackError); }
    }
  } else api[namespace][event].addListener(listener);
}
api.runtime.onMessage.addListener((message, sender) => {
  if (typeof message?.type === "string" && message.type.startsWith("foxy:")) {
    return sync.onMessage(message, sender).catch(() => ({ ok: false }));
  }
  // Preserve the close helper's sender validation and fire-and-forget response.
  handleMessage(api, message, sender)?.catch(error => console.warn("Foxy: close message failed", error));
  return undefined;
});
