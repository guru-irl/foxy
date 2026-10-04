import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { emptyState, saveState } from "../extension/src/sync/state.js";
import { createInbound } from "../extension/src/sync/inbound.js";
import { createOutbound } from "../extension/src/sync/outbound.js";
import { encodePinTitle } from "../extension/src/sync/codec.js";
import { wire, drain, sharedTree } from "./fakes/sync.js";
import { isOwn } from "../extension/src/tabs/own.js";

for (const [kind, base] of [["group", 10000], ["pin", 20000], ["named pin", 30000]]) {
  test(`inbound ${kind} creation marks the new tab before subsequent API operations`, async () => {
    const ff = createFirefox({ tabs: [{ id: base, windowId: 1, groupId: 7, url: "https://existing.example/" }],
      groups: [{ id: 7, windowId: 1 }], bookmarks: [{ title: "Foxy", children: [{ title: "📌 Pinned" }] }] });
    const state = emptyState(), api = ff.browser;
    state.rootId = (await api.bookmarks.getChildren("unfiled_____")).find(n => n.title === "Foxy").id;
    state.pinnedId = (await api.bookmarks.getChildren(state.rootId))[0].id;
    const config = { api, getState: () => state, save: () => saveState(api, state) };
    if (kind === "group") await createOutbound(config).syncGroup(7);
    const folderId = kind === "group" ? state.groups[7].folderId : state.pinnedId;
    await api.bookmarks.create({ parentId: folderId, url: "https://remote.example/", title: kind === "named pin" ? encodePinTitle("Remote") : "Remote" });
    assert.equal(isOwn(base + 1), false);
    // Grouping/pinning can yield to event listeners, so ownership must precede them.
    const operation = kind === "group" ? "group" : kind === "named pin" ? "update" : "discard";
    const original = api.tabs[operation];
    api.tabs[operation] = async (...args) => {
      assert.equal(isOwn(base + 1), true);
      return original(...args);
    };
    await createInbound(config).reconcileFolder(folderId);
    assert.equal(isOwn(base + 1), true);
    assert.equal((await api.tabs.get(base + 1)).url, "https://remote.example/");
  });
}

test("reopening a saved group marks all created tabs as Foxy-owned before grouping", async () => {
  const ff = createFirefox({ bookmarks: sharedTree, tabs: [{ id: 40000, windowId: 1, url: "about:home" }] });
  const sync = wire(ff); await drain(ff, sync);
  const saved = await sync.onMessage({ type: "foxy:saved" });
  const original = ff.browser.tabs.group;
  ff.browser.tabs.group = async options => {
    assert.ok(options.tabIds.every(isOwn)); return original(options);
  };
  const result = await sync.onMessage({ type: "foxy:open-saved", folderId: saved.saved[0].folderId, windowId: 1 });
  assert.equal(result.ok, true);
  const tabs = await ff.browser.tabs.query({ groupId: result.groupId });
  assert.equal(tabs.length, 2); assert.ok(tabs.every(tab => isOwn(tab.id)));
  await drain(ff, sync);
});
