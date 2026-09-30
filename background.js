// Event page. Keeps this add-on's new tab page out of Recently Closed Tabs,
// the way Firefox leaves out its own. Listeners are registered at the top
// level so Firefox can wake the page for them.
import { createForgetter } from "./src/forget.js";

const api = globalThis.browser;
const forget = createForgetter(api, api.runtime.getURL("newtab.html"));

api.sessions.onChanged.addListener(() => {
  forget();
});
forget();
