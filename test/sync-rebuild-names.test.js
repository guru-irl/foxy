import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { wire, drain } from "./fakes/sync.js";
import { loadState, saveState } from "../extension/src/sync/state.js";
import { rebuild } from "../extension/src/sync/startup.js";
import { createOutbound } from "../extension/src/sync/outbound.js";

const home = { id: 1, windowId: 1, url: "about:home", active: true };
const tree = (url, title) => [{ id: "root", title: "Foxy", children: [
  { id: "pins", title: "📌 Pinned", children: [{ id: "pin", url, title }] },
] }];
const titleOf = async ff => (await ff.browser.bookmarks.get("pin"))[0].title;

// Break caught: either A2 URL check is removed and a different document inherits Work's guard.
for (const source of ["old tab mapping", "saved bookmark mapping"]) {
  test(`rebuild rejects a shown name from a different URL in the ${source}`, async () => {
    const lostIdentity = source === "old tab mapping";
    const tabUrl = lostIdentity ? "https://example.com/b" : "https://example.com/a";
    const savedUrl = lostIdentity ? "https://example.com/a" : "https://example.com/previous";
    const ff = createFirefox({ bookmarks: tree("https://example.com/a", "Remote page title"),
      tabs: [home, { id: 2, windowId: 1, url: tabUrl, title: "Work", pinned: true, discarded: true }] });
    const state = await loadState(ff.browser);
    Object.assign(state, { rootId: "root", pinnedId: "pins", tabs: {
      2: { bookmarkId: lostIdentity ? "vanished-guid" : "pin", folderId: "pins",
        url: savedUrl, title: "Previous page title", shownName: "Work" },
    } });
    const outbound = createOutbound({ api: ff.browser, getState: () => state,
      save: () => saveState(ff.browser, state), extensionBaseUrl: ff.browser.runtime.getURL("") });
    // Isolate rebuild's state derivation from inbound navigation to the bookmark URL.
    // The consumer below is the real outbound, not a stub of the guard behavior.
    await rebuild({ api: ff.browser, state, outbound, lostIdentity,
      inbound: { reconcileFolder: async () => {} } });
    assert.equal(state.tabs[2].bookmarkId, "pin", "the occurrence was rebound, not dropped");
    // The fake uses the URL as a placeholder on update; a hash change keeps the live title.
    const get = ff.browser.tabs.get;
    ff.browser.tabs.get = async id => ({ ...await get(id), ...(id === 2 ? { title: "Work" } : {}) });
    await ff.browser.tabs.update(2, { url: tabUrl + "#next" });
    await outbound.syncTab(2);
    assert.equal(await titleOf(ff), "Work", "a label from a different document must not suppress its legitimate title");
    assert.equal((await ff.browser.bookmarks.get("pin"))[0].url, tabUrl + "#next");
    assert.equal(state.tabs[2].shownName, undefined);
  });
}

// Break caught: A1 stores decoded Work Mail instead of the raw restored label Work  Mail.
test("rebuild guards the raw whitespace-preserving tab label through unname and muted events", async () => {
  const ff = createFirefox({ bookmarks: tree("https://example.com/a", "✏️ Work Mail"),
    tabs: [home, { id: 2, windowId: 1, url: "https://example.com/a", title: "Work  Mail",
      pinned: true, discarded: true }] });
  const sync = wire(ff);
  await drain(ff, sync);
  await sync.onMessage({ type: "foxy:rename-pin", tabId: 2, name: null });
  await drain(ff, sync);
  assert.equal(await titleOf(ff), "https://example.com/a");
  await sync.handlers["tabs.onUpdated"](2, { mutedInfo: { muted: true } });
  await drain(ff, sync);
  assert.equal(await titleOf(ff), "https://example.com/a", "the raw restored label is still a name, not a page title");
  const { tabs } = await loadState(ff.browser);
  assert.equal(tabs[2].shownName, "Work  Mail");
  assert.equal(tabs[2].title, "https://example.com/a");
});
