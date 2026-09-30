import { handleMessage } from "./src/close.js";
import { createSync } from "./src/sync/sync.js";

const api = globalThis.browser;
const sync = createSync({ api });

// Register synchronously: Firefox uses these listeners to wake this event page.
// Each controller handler starts the session and runs through its serial queue.
for (const [name, handler] of Object.entries(sync.handlers)) {
  const [namespace, event] = name.split(".");
  api[namespace][event].addListener((...args) => {
    handler(...args).catch(() => {}); // Queue failures are already logged.
  });
}
api.runtime.onMessage.addListener((message, sender) => {
  if (typeof message?.type === "string" && message.type.startsWith("foxy:")) {
    return sync.onMessage(message, sender).catch(() => ({ ok: false }));
  }
  // Preserve the close helper's sender validation and fire-and-forget response.
  sync.start().then(() => handleMessage(api, message, sender))
    .catch(error => console.warn("Foxy: close message failed", error));
  return undefined;
});
