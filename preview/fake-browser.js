// Preview only: a stand-in for the WebExtension `browser` API, fed from
// fixtures.js. Query string: ?scenario=<none|one|two|three|five>&scheme=<dark|light>
import { SCENARIOS } from "./fixtures.js";

const params = new URLSearchParams(location.search);
const name = params.get("scenario") ?? "three";
const scenario = SCENARIOS[name];
if (!scenario) throw new Error(`Unknown preview scenario: ${name}`);

// Headless Firefox defaults to a light scheme; the real page follows the
// browser theme, which is dark here. Force the scheme explicitly.
const scheme = params.get("scheme") ?? "dark";
document.documentElement.dataset.scheme = scheme;
document.documentElement.style.colorScheme = scheme;

const self = { id: 999, index: 999, windowId: 1, pinned: false, hidden: false, groupId: -1, title: "New Tab" };
const event = () => ({ addListener() {} });

globalThis.browser = {
  runtime: {
    sendMessage: async () => undefined,
  },
  tabs: {
    getCurrent: async () => self,
    query: async () => [...scenario.tabs, self],
    update: async (id, props) => console.log("tabs.update", id, props),
    remove: async (id) => console.log("tabs.remove", id),
    onCreated: event(),
    onRemoved: event(),
    onUpdated: event(),
    onMoved: event(),
    onAttached: event(),
    onDetached: event(),
  },
  tabGroups: {
    query: async () => scenario.groups,
    onCreated: event(),
    onUpdated: event(),
    onMoved: event(),
    onRemoved: event(),
  },
};
