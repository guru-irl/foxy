import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { createSyncServer } from "./fakes/sync-server.js";
import { wire, drain } from "./fakes/sync.js";
import { loadState } from "../extension/src/sync/state.js";

const home = { id: 1, windowId: 1, url: "about:home", active: true };
const bookmarks = [{ id: "root", title: "Foxy", children: [
  { id: "pins", title: "📌 Pinned", children: [
    { id: "pin", url: "https://example.com/a", title: "✏️ Work" },
    { id: "other", url: "https://example.org/", title: "Other page" },
  ] },
] }];
const titleOf = async ff => (await ff.browser.bookmarks.get("pin"))[0].title;
const entryOf = async (ff, id) => (await loadState(ff.browser)).tabs[id];

async function fixture({ loaded = false } = {}) {
  const ff = createFirefox({ bookmarks, origins: loaded ? ["https://example.com/*"] : [],
    tabs: loaded ? [home, { id: 2, windowId: 1, url: "https://example.com/a", title: "Page", pinned: true }] : [home] });
  const sync = wire(ff);
  await drain(ff, sync);
  const pin = (await ff.browser.tabs.query({ pinned: true })).find(tab => tab.url === "https://example.com/a");
  // The fake records injection but does not run a DOM. Model the label Firefox reads.
  const live = { title: "Work", discarded: !loaded, status: "complete" };
  const get = ff.browser.tabs.get, query = ff.browser.tabs.query;
  ff.browser.tabs.get = async id => ({ ...await get(id), ...(id === pin.id ? live : {}) });
  ff.browser.tabs.query = async props => (await query(props)).map(tab => tab.id === pin.id ? { ...tab, ...live } : tab);
  ff.calls.length = 0;
  return { ff, sync, pin, live };
}

async function laterEvents(ff, sync, pin, want) {
  await sync.handlers["tabs.onUpdated"](pin.id, { mutedInfo: { muted: true } });
  await drain(ff, sync);
  assert.equal(await titleOf(ff), want, "muted update preserves the unnamed bookmark title");
  const other = (await ff.browser.tabs.query({ pinned: true })).find(tab => tab.id !== pin.id);
  await ff.browser.tabs.move(other.id, { index: 0 });
  await drain(ff, sync);
  assert.equal(await titleOf(ff), want, "pinned-strip move preserves the unnamed bookmark title");
}

async function realLoad(ff, sync, pin, live, title = "Work") {
  Object.assign(live, { discarded: false, status: "loading", title });
  await sync.handlers["tabs.onUpdated"](pin.id, { discarded: false });
  await sync.handlers["tabs.onUpdated"](pin.id, { status: "loading" });
  assert.equal((await entryOf(ff, pin.id)).shownName, undefined, "new document ends the old-label guard durably");
  live.status = "complete";
  await sync.handlers["tabs.onUpdated"](pin.id, { status: "complete" });
  await sync.handlers["tabs.onUpdated"](pin.id, { title });
  await drain(ff, sync);
}

// Break caught: deriving shownName from the bookmark replaces Work with unapplied Mail.
test("review P2: revoked Work to Mail rename then board unname keeps the displayed-name guard", async () => {
  const { ff, sync, pin } = await fixture({ loaded: true });
  await ff.browser.permissions.remove({ origins: ["https://example.com/*"] });
  await sync.onMessage({ type: "foxy:rename-pin", tabId: pin.id, name: "Mail" });
  await drain(ff, sync);
  assert.equal(await titleOf(ff), "✏️ Mail");
  await sync.onMessage({ type: "foxy:rename-pin", tabId: pin.id, name: null });
  await drain(ff, sync);
  assert.equal(await titleOf(ff), "Page");
  await laterEvents(ff, sync, pin, "Page");
  assert.equal((await entryOf(ff, pin.id)).shownName, "Work");
  assert.equal(await titleOf(ff), "Page");
  assert.equal((await entryOf(ff, pin.id)).title, "Page");
  assert.equal(ff.calls.some(c => c.api === "scripting.executeScript"), false);
});

// Break caught: remote rename of an unloaded tab incorrectly changes its shownName.
test("review P3: discarded Work to remote Mail then board unname keeps the URL through tab events and moves", async () => {
  const { ff, sync, pin } = await fixture();
  await ff.browser.bookmarks.update("pin", { title: "✏️ Mail" });
  await drain(ff, sync);
  assert.equal((await ff.browser.tabs.get(pin.id)).title, "Work");
  await sync.onMessage({ type: "foxy:rename-pin", tabId: pin.id, name: null });
  await drain(ff, sync);
  assert.equal(await titleOf(ff), "https://example.com/a");
  await laterEvents(ff, sync, pin, "https://example.com/a");
  assert.equal((await entryOf(ff, pin.id)).shownName, "Work");
  assert.equal(await titleOf(ff), "https://example.com/a");
  assert.equal((await entryOf(ff, pin.id)).title, "https://example.com/a");
});

// Break caught: equality alone keeps a real title equal to the old name suppressed forever.
for (const loaded of [false, true]) {
  test(`review P1: ${loaded ? "same-as-name keeper removal" : "never-loaded unname"} publishes Work after a real load`, async () => {
    const { ff, sync, pin, live } = await fixture({ loaded });
    if (loaded) ff.browser.scripting.executeScript = async () => [{ frameId: 0, result: "Work" }];
    await sync.onMessage({ type: "foxy:rename-pin", tabId: pin.id, name: null });
    await drain(ff, sync);
    assert.equal(await titleOf(ff), loaded ? "Page" : "https://example.com/a");
    await laterEvents(ff, sync, pin, loaded ? "Page" : "https://example.com/a");
    assert.equal(await titleOf(ff), loaded ? "Page" : "https://example.com/a");
    await realLoad(ff, sync, pin, live);
    assert.equal(await titleOf(ff), "Work");
    assert.equal((await entryOf(ff, pin.id)).title, "Work");
    assert.equal((await entryOf(ff, pin.id)).shownName, undefined);
    const resumed = wire(ff);
    await drain(ff, resumed);
    assert.equal((await entryOf(ff, pin.id)).shownName, undefined, "cleared guard stays cleared across event-page wake");
  });
}

// Break caught: clearing on a URL event rather than a new document leaks Work on hash navigation.
test("same-document URL update without loading retains the shown name and writes URL only", async () => {
  const { ff, sync, pin } = await fixture({ loaded: true });
  await ff.browser.permissions.remove({ origins: ["https://example.com/*"] });
  await sync.onMessage({ type: "foxy:rename-pin", tabId: pin.id, name: null });
  await drain(ff, sync);
  ff.calls.length = 0;
  await ff.browser.tabs.update(pin.id, { url: "https://example.com/a#section" });
  await sync.handlers["tabs.onUpdated"](pin.id, { url: "https://example.com/a#section", status: "complete" });
  await drain(ff, sync);
  assert.equal((await entryOf(ff, pin.id)).shownName, "Work");
  assert.equal((await entryOf(ff, pin.id)).title, "Page");
  assert.equal(await titleOf(ff), "Page");
  assert.deepEqual(ff.calls.filter(c => c.api === "bookmarks.update").map(c => c.args),
    [["pin", { url: "https://example.com/a#section" }]]);
});

// Break caught: a successful reapply of the same name after loading fails to restore/save shownName.
test("load completion records the successfully re-applied name again even when appliedName is unchanged", async () => {
  const { ff, sync, pin, live } = await fixture({ loaded: true });
  Object.assign(live, { status: "loading", title: "Page" });
  await sync.handlers["tabs.onUpdated"](pin.id, { status: "loading" });
  assert.equal((await entryOf(ff, pin.id)).shownName, undefined);
  assert.equal((await entryOf(ff, pin.id)).appliedName, "Work");
  live.status = "complete";
  await sync.handlers["tabs.onUpdated"](pin.id, { status: "complete" });
  live.title = "Work";
  assert.equal((await entryOf(ff, pin.id)).shownName, "Work");
  await ff.browser.permissions.remove({ origins: ["https://example.com/*"] });
  await ff.browser.bookmarks.update("pin", { title: "Remote page title" });
  await drain(ff, sync);
  await laterEvents(ff, sync, pin, "Remote page title");
  assert.equal(await titleOf(ff), "Remote page title");
});

// Break caught: a fresh-session rebuild drops the label guard when its saved entry is missing.
for (const discarded of [true, false]) {
  test(`restart reconstructs a named ${discarded ? "discarded" : "complete but no load seen"} pin guard before local unname`, async () => {
    const { ff } = await fixture();
    const stored = await loadState(ff.browser);
    stored.tabs = {};
    await ff.browser.storage.local.set({ foxySync: stored });
    ff.restart({ restore: true });
    const get = ff.browser.tabs.get, query = ff.browser.tabs.query;
    ff.browser.tabs.get = async id => {
      const tab = await get(id);
      return tab.url === "https://example.com/a" ? { ...tab, discarded } : tab;
    };
    ff.browser.tabs.query = async props => (await query(props)).map(tab =>
      tab.url === "https://example.com/a" ? { ...tab, discarded } : tab);
    const sync = wire(ff);
    await drain(ff, sync);
    const pin = (await ff.browser.tabs.query({ pinned: true })).find(tab => tab.url === "https://example.com/a");
    assert.equal((await entryOf(ff, pin.id)).shownName, "Work");
    await sync.onMessage({ type: "foxy:rename-pin", tabId: pin.id, name: null });
    await drain(ff, sync);
    assert.equal(await titleOf(ff), "https://example.com/a");
    await laterEvents(ff, sync, pin, "https://example.com/a");
    assert.equal((await entryOf(ff, pin.id)).title, "https://example.com/a");
  });
}

// Break caught: rebuilding an unloaded pin overwrites a remote unname made while this device was closed.
test("restart retains a saved shown name by bookmark and URL after remote unname while closed", async () => {
  const { ff } = await fixture();
  ff.restart({ restore: true });
  // No listeners are registered while this fake device is closed.
  await ff.browser.bookmarks.update("pin", { title: "Remote page title" });
  const sync = wire(ff);
  await drain(ff, sync);
  const pin = (await ff.browser.tabs.query({ pinned: true })).find(tab => tab.url === "https://example.com/a");
  assert.equal(pin.title, "Work");
  assert.equal(pin.discarded, true);
  assert.equal((await entryOf(ff, pin.id)).shownName, "Work");
  await laterEvents(ff, sync, pin, "Remote page title");
  assert.equal((await entryOf(ff, pin.id)).title, "https://example.com/a");
});

// Break caught: an event-page wake loses knowledge of a real load and rebuild guards the page's own Work title.
test("lost-identity rebuild after an event-page wake does not reconstruct a guard for a load seen this session", async () => {
  const { ff, sync, pin, live } = await fixture({ loaded: true });
  await ff.browser.permissions.remove({ origins: ["https://example.com/*"] });
  await sync.onMessage({ type: "foxy:rename-pin", tabId: pin.id, name: null });
  await realLoad(ff, sync, pin, live);
  await sync.onMessage({ type: "foxy:rename-pin", tabId: pin.id, name: "Work" });
  await drain(ff, sync);
  const stored = await loadState(ff.browser);
  stored.tabs[pin.id].bookmarkId = "vanished-guid";
  await ff.browser.storage.local.set({ foxySync: stored });
  const resumed = wire(ff);
  await drain(ff, resumed);
  await resumed.handlers["tabs.onUpdated"](pin.id, { mutedInfo: { muted: true } });
  await drain(ff, resumed);
  assert.equal((await entryOf(ff, pin.id)).bookmarkId, "pin");
  assert.equal((await entryOf(ff, pin.id)).shownName, undefined);
  assert.equal(await titleOf(ff), "✏️ Work");
});

test("a load observed before startup rebuild prevents inferring a shown name from the completed page title", async () => {
  const ff = createFirefox({ bookmarks, tabs: [home,
    { id: 2, windowId: 1, url: "https://example.com/a", title: "Work", pinned: true }] });
  const sync = wire(ff);
  await sync.handlers["tabs.onUpdated"](2, { status: "loading" });
  await drain(ff, sync);
  // Wake and lose identity after startup; the page's real Work title is not an applied name.
  const stored = await loadState(ff.browser);
  stored.tabs[2].bookmarkId = "vanished-guid";
  await ff.browser.storage.local.set({ foxySync: stored });
  const resumed = wire(ff);
  await drain(ff, resumed);
  await resumed.handlers["tabs.onUpdated"](2, { mutedInfo: { muted: true } });
  await drain(ff, resumed);
  assert.equal((await entryOf(ff, 2)).shownName, undefined);
  assert.equal((await entryOf(ff, 2)).bookmarkId, "pin");
});

async function converge(server, ...devices) {
  for (let round = 0; round < 5; round++) {
    for (const ff of devices) await drain(ff, ff.sync);
    if ((await server.syncAll()).uploaded === 0) {
      assert.equal((await server.syncAll()).uploaded, 0, "no echo on the next sync");
      assert.deepEqual(await devices[0].browser.bookmarks.getTree(), await devices[1].browser.bookmarks.getTree());
      return;
    }
  }
  assert.fail("fake Sync did not converge in five rounds");
}

// Break caught: remote unname has no guard on the receiving device and its next strip sync publishes Work.
for (const loaded of [false, true]) {
  test(`remote unname converges without a bare-name echo on a ${loaded ? "loaded access-revoked" : "discarded inbound"} pin`, async () => {
    const { ff: receiver, sync, pin, live } = await fixture({ loaded });
    const writer = createFirefox({ bookmarks, tabs: [home,
      { id: 2, windowId: 1, url: "https://example.com/a", title: "Remote page title", pinned: true }] });
    writer.sync = wire(writer);
    receiver.sync = sync;
    await drain(writer, writer.sync);
    const server = createSyncServer({ deliveryOrder: "shuffle", seed: 42 });
    for (const ff of [writer, receiver]) server.attach(ff);
    await converge(server, writer, receiver);
    if (loaded) await receiver.browser.permissions.remove({ origins: ["https://example.com/*"] });
    await writer.browser.bookmarks.update("pin", { title: "Remote page title" });
    await converge(server, writer, receiver);
    assert.equal(await titleOf(receiver), "Remote page title");
    await laterEvents(receiver, sync, pin, "Remote page title");
    assert.equal(await titleOf(receiver), "Remote page title", "muted update and a real pin drag preserve the remote edit");
    await converge(server, writer, receiver);
    assert.equal(await titleOf(writer), "Remote page title");
    assert.equal((await entryOf(receiver, pin.id)).shownName, "Work");
    const fallback = loaded ? "Page" : "https://example.com/a";
    assert.equal((await entryOf(receiver, pin.id)).title, fallback, "outbound leaves the remembered page title alone");
    await realLoad(receiver, sync, pin, live);
    assert.equal(await titleOf(receiver), "Work", "a real page title equal to the old name is now legitimate");
    await converge(server, writer, receiver);
    assert.equal(await titleOf(writer), "Work");
    assert.equal((await entryOf(receiver, pin.id)).shownName, undefined);
  });
}
