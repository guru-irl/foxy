// Event page. When the new tab page closes itself after a click, it asks for
// this: the tab is switched to about:blank first (Firefox leaves a tab whose
// only page is about:blank out of Recently Closed Tabs), its session state is
// flushed via tabs.discard, then it is closed. The listener is registered at
// the top level so Firefox can wake the page for it.
import { handleMessage } from "./src/close.js";

const api = globalThis.browser;

api.runtime.onMessage.addListener((message, sender) => {
  handleMessage(api, message, sender);
});
