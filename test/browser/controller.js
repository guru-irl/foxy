import { createFirefox } from "../fakes/firefox.js";

function boardMessages(message) {
  if (message.type === "foxy:reconcile") return { ok: true };
  if (message.type === "foxy:saved") return { saved: [], missing: [] };
}

// Integration tests use the bare fake with createSync instead. Pass a listener
// to override this stub, or null to exercise an unavailable background.
export function createBoardFirefox(setup, listener = boardMessages) {
  const ff = createFirefox(setup);
  // Existing geometry fixtures opt out of optional memory unless explicitly on.
  const get = ff.browser.storage.sync.get;
  ff.browser.storage.sync.get = async keys => {
    const result = await get(keys);
    if (keys === "settings") result.settings = { showMemory: false, ...result.settings };
    return result;
  };
  if (listener) ff.browser.runtime.onMessage.addListener(listener);
  return ff;
}
