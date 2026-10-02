import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { wire, drain } from "./fakes/sync.js";
import { loadState } from "../extension/src/sync/state.js";
import { rebuild } from "../extension/src/sync/startup.js";
import { createOutbound } from "../extension/src/sync/outbound.js";
import { createInbound } from "../extension/src/sync/inbound.js";

async function fixture({ title = "Page", origins = [], tabs, ...setup } = {}) {
  const ff = createFirefox({ origins, tabs: tabs ?? [
    { id: 1, windowId: 1, url: "about:home", active: true },
    { id: 2, windowId: 1, url: "https://example.com/a", title: "Page", pinned: true },
  ], bookmarks: [{ id: "root", title: "Foxy", children: [
    { id: "pins", title: "📌 Pinned", children: [
      { id: "pin", url: "https://example.com/a", title },
    ] },
  ] }], ...setup });
  const sync = wire(ff);
  await drain(ff, sync);
  ff.calls.length = 0;
  return { ff, sync };
}
const scripts = ff => ff.calls.filter(c => c.api === "scripting.executeScript");

test("rename saves a trimmed marker without access and rejects nonpins and malformed messages", async () => {
  const { ff, sync } = await fixture();
  assert.deepEqual(await sync.onMessage({ type: "foxy:rename-pin", tabId: 2, name: "  Work  " }), { ok: true });
  await drain(ff, sync);
  assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, "✏️ Work");
  assert.deepEqual(await sync.onMessage({ type: "foxy:pins" }), {
    pins: { 2: { name: "Work", origin: "https://example.com/*", allowed: false } },
  });
  assert.equal(scripts(ff).length, 0);
  for (const message of [{ tabId: 1, name: "Bad" }, { tabId: 999, name: "Bad" },
    { tabId: "2", name: "Bad" }, { tabId: 2, name: {} }]) {
    assert.deepEqual(await sync.onMessage({ type: "foxy:rename-pin", ...message }), { ok: false });
  }
  assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, "✏️ Work");
});

test("rename rejects more than 200 normalized characters before any mutation", async () => {
  const { ff, sync } = await fixture();
  assert.deepEqual(await sync.onMessage({ type: "foxy:rename-pin", tabId: 2, name: `  ${"A".repeat(201)}  ` }), { ok: false });
  assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, "Page");
  assert.equal(ff.calls.some(c => ["bookmarks.update", "scripting.executeScript"].includes(c.api)), false);
  const value = `${"A".repeat(198)}   B`;
  assert.deepEqual(await sync.onMessage({ type: "foxy:rename-pin", tabId: 2, name: value }), { ok: true });
  assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, `✏️ ${"A".repeat(198)} B`);
});

test("outbound never writes a named pin title even on URL changes or tab moves", async () => {
  const { ff, sync } = await fixture({ title: "✏️ Work" });
  const get = ff.browser.tabs.get;
  let pageTitle = "Work";
  ff.browser.tabs.get = async id => ({ ...await get(id), ...(id === 2 ? { title: pageTitle } : {}) });
  await sync.handlers["tabs.onUpdated"](2, { title: "Work" });
  await ff.browser.tabs.update(2, { url: "https://example.com/b" });
  await drain(ff, sync);
  pageTitle = "Page changed again";
  await sync.handlers["tabs.onUpdated"](2, { title: pageTitle });
  assert.deepEqual(ff.calls.filter(c => c.api === "bookmarks.update").map(c => c.args),
    [["pin", { url: "https://example.com/b" }]]);
  assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, "✏️ Work");
});

test("an inbound named pin opens unloaded with the decoded label and no eager page load", async () => {
  const { ff, sync } = await fixture({ title: "✏ Work", tabs: [
    { id: 1, windowId: 1, url: "about:home", active: true },
  ] });
  const [pin] = await ff.browser.tabs.query({ pinned: true });
  assert.equal(pin.title, "Work");
  assert.equal(pin.discarded, true);
  assert.equal(pin.active, false);
  assert.equal((await sync.onMessage({ type: "foxy:pins" })).pins[pin.id].name, "Work");
});

test("inbound named pins explicitly append before pinning and moving among pins", async () => {
  const { ff, sync } = await fixture();
  await ff.browser.bookmarks.create({ parentId: "pins", url: "https://remote.com/", title: "✏️ Remote" });
  await drain(ff, sync);
  const create = ff.calls.find(c => c.api === "tabs.create").args[0];
  assert.equal(create.index, 2, "append to the window, not after the selected tab or into its group");
  const pins = await ff.browser.tabs.query({ pinned: true });
  assert.equal(pins[1].title, "Remote");
  assert.equal(pins[1].discarded, true);
  assert.equal(pins[1].index, 1);
});

test("a granted site applies names at startup, load completion, permission events and remote bookmark edits", async () => {
  const { ff, sync } = await fixture({ title: "✏️ Work", origins: ["https://example.com/*"] });
  assert.equal((await loadState(ff.browser)).tabs[2].appliedName, "Work", "startup applied name");
  await sync.handlers["tabs.onUpdated"](2, { status: "loading" });
  assert.equal(scripts(ff).length, 0);
  await sync.handlers["tabs.onUpdated"](2, { status: "complete" });
  assert.deepEqual(scripts(ff).at(-1).args[0].args, ["Work"]);
  await ff.browser.bookmarks.update("pin", { title: "✏️ Home" });
  await drain(ff, sync);
  assert.deepEqual(scripts(ff).at(-1).args[0].args, ["Home"]);
  await ff.browser.bookmarks.update("pin", { title: "Ordinary page title" });
  await drain(ff, sync);
  assert.deepEqual(scripts(ff).at(-1).args[0].args, [null]);
  assert.deepEqual(await sync.onMessage({ type: "foxy:pins" }), { pins: {} });
  assert.equal((await loadState(ff.browser)).tabs[2].appliedName, undefined);
});

test("permission onAdded applies a saved name on this device, and revocation is reflected by pins", async () => {
  const { ff, sync } = await fixture({ title: "✏️ Work" });
  await ff.withUserInput(() => ff.browser.permissions.request({ origins: ["https://example.com/*"] }));
  await drain(ff, sync);
  assert.deepEqual(scripts(ff).at(-1)?.args[0].args, ["Work"]);
  assert.equal((await sync.onMessage({ type: "foxy:pins" })).pins[2].allowed, true);
  await ff.browser.permissions.remove({ origins: ["https://example.com/*"] });
  assert.equal((await sync.onMessage({ type: "foxy:pins" })).pins[2].allowed, false);
});

for (const mode of ["restored", "discarded", "revoked", "missing keeper", "unusable", "same as name"]) {
  test(`board unname writes the page title, not the shown name: ${mode}`, async () => {
    const { ff, sync } = await fixture({ title: "✏️ Work", origins: ["https://example.com/*"] });
    const get = ff.browser.tabs.get;
    let liveTitle = "Work", discarded = mode === "discarded";
    ff.browser.tabs.get = async id => ({ ...await get(id), ...(id === 2 ? {
      title: liveTitle, discarded,
    } : {}) });
    if (mode === "revoked") await ff.browser.permissions.remove({ origins: ["https://example.com/*"] });
    const injected = [];
    ff.browser.scripting.executeScript = async details => {
      injected.push(details.args[0]);
      assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, "✏️ Work", "restore before writing");
      return [{ frameId: 0, result: mode === "restored" ? "Latest page" : mode === "unusable" ? {} : mode === "same as name" ? "Work" : undefined }];
    };
    assert.deepEqual(await sync.onMessage({ type: "foxy:rename-pin", tabId: 2, name: null }), { ok: true });
    assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, mode === "restored" ? "Latest page" : "Page");
    assert.deepEqual(injected, ["discarded", "revoked"].includes(mode) ? [] : [null]);
    if (mode === "restored") liveTitle = "Latest page";
    const want = mode === "restored" ? "Latest page" : "Page";
    await sync.handlers["tabs.onUpdated"](2, { mutedInfo: { muted: true } });
    assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, want, "later unrelated update must keep the page-title fallback");
    await sync.handlers["tabs.onMoved"](2, { windowId: 1, fromIndex: 0, toIndex: 0 });
    await drain(ff, sync);
    assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, want, "pinned-strip sync must not publish the bare name");
    liveTitle = "Real page title on next load"; discarded = false;
    await sync.handlers["tabs.onUpdated"](2, { status: "complete" });
    assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, liveTitle);
    assert.equal((await loadState(ff.browser)).tabs[2].shownName, undefined);
  });
}

test("renaming an already displayed name keeps the last synced page title for fallback", async () => {
  const { ff, sync } = await fixture({ title: "✏️ Work", origins: ["https://example.com/*"] });
  const get = ff.browser.tabs.get;
  ff.browser.tabs.get = async id => ({ ...await get(id), ...(id === 2 ? { title: "Work" } : {}) });
  await sync.onMessage({ type: "foxy:rename-pin", tabId: 2, name: "Home" });
  assert.equal((await loadState(ff.browser)).tabs[2].title, "Page");
});

test("a named pin URL update preserves the page-title fallback when access is revoked", async () => {
  const { ff, sync } = await fixture({ title: "✏️ Work", origins: ["https://example.com/*"] });
  const get = ff.browser.tabs.get;
  await ff.browser.tabs.update(2, { url: "https://example.com/b" });
  ff.browser.tabs.get = async id => ({ ...await get(id), ...(id === 2 ? { title: "Work" } : {}) });
  await drain(ff, sync);
  await ff.browser.permissions.remove({ origins: ["https://example.com/*"] });
  await sync.onMessage({ type: "foxy:rename-pin", tabId: 2, name: null });
  assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, "Page");
});

test("repinning before delayed removal reapplies the retained bookmark name", async () => {
  const { ff, sync } = await fixture({ title: "✏️ Work", origins: ["https://example.com/*"] });
  await ff.browser.tabs.update(2, { pinned: false });
  await drain(ff, sync);
  assert.deepEqual(scripts(ff).at(-1).args[0].args, [null]);
  ff.calls.length = 0;
  await ff.browser.tabs.update(2, { pinned: true });
  await drain(ff, sync);
  assert.deepEqual(scripts(ff).at(-1)?.args[0].args, ["Work"]);
  assert.equal((await loadState(ff.browser)).pendingRemovals[2], undefined);
  assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, "✏️ Work");
  assert.equal(ff.calls.some(c => ["bookmarks.remove", "bookmarks.create"].includes(c.api)), false);
});

test("event-page wake and board reconcile do not reinject durable pin keepers", async () => {
  const { ff } = await fixture({ title: "✏️ Work", origins: ["https://example.com/*"] });
  const sync = wire(ff);
  await drain(ff, sync);
  await sync.onMessage({ type: "foxy:reconcile" });
  assert.equal(scripts(ff).length, 0);
});

for (const lifecycle of ["update", "reload"]) {
  test(`extension ${lifecycle} clears its session bucket and rebuild applies names once`, async () => {
    const { ff } = await fixture({ title: "✏️ Work", origins: ["https://example.com/*"] });
    // Firefox storage.session is keyed by Extension object, not event page.
    await ff.browser.storage.session.clear();
    const sync = wire(ff);
    await drain(ff, sync);
    assert.deepEqual(scripts(ff).map(c => c.args[0].args), [["Work"]]);
    await sync.handlers["runtime.onInstalled"]({ reason: lifecycle === "update" ? "update" : "install" });
    await sync.onMessage({ type: "foxy:reconcile" });
    assert.equal(scripts(ff).length, 1);
  });
}

test("extension rebuild preserves a named pin page-title fallback when its keeper is unavailable", async () => {
  const { ff } = await fixture({ title: "✏️ Work", origins: ["https://example.com/*"] });
  const query = ff.browser.tabs.query, get = ff.browser.tabs.get;
  ff.browser.tabs.get = async id => ({ ...await get(id), ...(id === 2 ? { title: "Work" } : {}) });
  ff.browser.tabs.query = async props => (await query(props)).map(tab => tab.id === 2 ? { ...tab, title: "Work" } : tab);
  await ff.browser.storage.session.clear();
  const sync = wire(ff);
  await drain(ff, sync);
  await ff.browser.permissions.remove({ origins: ["https://example.com/*"] });
  assert.deepEqual(await sync.onMessage({ type: "foxy:rename-pin", tabId: 2, name: null }), { ok: true });
  assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, "Page");
});

for (const path of ["inbound never-loaded", "rebuild without saved title"]) {
  test(`unname uses the URL without loading when no page title is known: ${path}`, async () => {
    const { ff, sync: initial } = await fixture({ title: "✏️ Work", tabs: [
      { id: 1, windowId: 1, url: "about:home", active: true },
    ] });
    const [pin] = await ff.browser.tabs.query({ pinned: true });
    let sync = initial;
    if (path === "rebuild without saved title") {
      const stored = await loadState(ff.browser);
      stored.tabs = {};
      await ff.browser.storage.local.set({ foxySync: stored });
      await ff.browser.storage.session.clear();
      sync = wire(ff);
      await drain(ff, sync);
    }
    ff.calls.length = 0;
    assert.deepEqual(await sync.onMessage({ type: "foxy:rename-pin", tabId: pin.id, name: null }), { ok: true });
    assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, "https://example.com/a");
    assert.equal((await loadState(ff.browser)).tabs[pin.id].title, "https://example.com/a");
    assert.equal((await ff.browser.tabs.get(pin.id)).discarded, true);
    assert.equal(ff.calls.some(c => ["tabs.create", "tabs.update", "scripting.executeScript"].includes(c.api)), false);
    await sync.handlers["tabs.onUpdated"](pin.id, { mutedInfo: { muted: true } });
    assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, "https://example.com/a");
    await sync.handlers["tabs.onMoved"](pin.id, { windowId: 1, fromIndex: 0, toIndex: 0 });
    await drain(ff, sync);
    assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, "https://example.com/a");
    const get = ff.browser.tabs.get;
    ff.browser.tabs.get = async id => ({ ...await get(id), ...(id === pin.id ? {
      discarded: false, status: "complete", title: "Real page title on next load",
    } : {}) });
    await sync.handlers["tabs.onUpdated"](pin.id, { status: "complete" });
    assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, "Real page title on next load");
  });
}

test("unname escapes a restored marker-like page title instead of naming it again", async () => {
  const { ff, sync } = await fixture({ title: "✏️ Work", origins: ["https://example.com/*"] });
  ff.browser.scripting.executeScript = async () => [{ frameId: 0, result: "  ✏️ Page title" }];
  assert.deepEqual(await sync.onMessage({ type: "foxy:rename-pin", tabId: 2, name: null }), { ok: true });
  assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, "\u200B  ✏️ Page title");
  assert.deepEqual(await sync.onMessage({ type: "foxy:pins" }), { pins: {} });
});

for (const mode of ["discarded never-loaded", "revoked access"]) {
  test(`review probe: ${mode} unname survives later tab events and reconcile`, async () => {
    const { ff, sync } = await fixture({ title: "✏️ Work", origins: ["https://example.com/*"],
      ...(mode === "discarded never-loaded" ? { tabs: [{ id: 1, windowId: 1, url: "about:home", active: true }] } : {}) });
    const [pin] = await ff.browser.tabs.query({ pinned: true });
    const get = ff.browser.tabs.get;
    ff.browser.tabs.get = async id => ({ ...await get(id), ...(id === pin.id ? { title: "Work" } : {}) });
    if (mode === "revoked access") await ff.browser.permissions.remove({ origins: ["https://example.com/*"] });
    await sync.onMessage({ type: "foxy:rename-pin", tabId: pin.id, name: null });
    await drain(ff, sync);
    const want = mode === "revoked access" ? "Page" : "https://example.com/a";
    assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, want);
    await sync.handlers["tabs.onUpdated"](pin.id, mode === "revoked access" ? { audible: true } : { mutedInfo: { muted: true } });
    await drain(ff, sync);
    assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, want);
    await sync.onMessage({ type: "foxy:reconcile" });
    await drain(ff, sync);
    assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, want);
  });
}

test("a lingering shown name suppresses only title writes during an unnamed pin URL change", async () => {
  const { ff, sync } = await fixture({ title: "✏️ Work", origins: ["https://example.com/*"] });
  const get = ff.browser.tabs.get;
  let liveTitle = "Work";
  ff.browser.tabs.get = async id => ({ ...await get(id), ...(id === 2 ? { title: liveTitle } : {}) });
  await ff.browser.permissions.remove({ origins: ["https://example.com/*"] });
  await sync.onMessage({ type: "foxy:rename-pin", tabId: 2, name: null });
  await drain(ff, sync);
  ff.calls.length = 0;
  await ff.browser.tabs.update(2, { url: "https://example.com/b" });
  await drain(ff, sync);
  assert.deepEqual(ff.calls.filter(c => c.api === "bookmarks.update").map(c => c.args),
    [["pin", { url: "https://example.com/b" }]]);
  assert.equal((await loadState(ff.browser)).tabs[2].title, "Page");
  assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, "Page");
  liveTitle = "Real title";
  await sync.handlers["tabs.onUpdated"](2, { title: liveTitle });
  assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, "Real title");
  assert.equal((await loadState(ff.browser)).tabs[2].shownName, undefined);
});

for (const path of ["event-page wake", "extension rebuild", "lost identity rebuild"]) {
  test(`unnamed pin retains its shown-name guard across ${path}`, async () => {
    const { ff, sync } = await fixture({ title: "✏️ Work", origins: ["https://example.com/*"] });
    const get = ff.browser.tabs.get, query = ff.browser.tabs.query;
    ff.browser.tabs.get = async id => ({ ...await get(id), ...(id === 2 ? { title: "Work" } : {}) });
    ff.browser.tabs.query = async props => (await query(props)).map(tab => tab.id === 2 ? { ...tab, title: "Work" } : tab);
    await ff.browser.permissions.remove({ origins: ["https://example.com/*"] });
    await sync.onMessage({ type: "foxy:rename-pin", tabId: 2, name: null });
    await drain(ff, sync);
    if (path === "lost identity rebuild") {
      const state = await loadState(ff.browser), save = () => ff.browser.storage.local.set({ foxySync: state });
      // Rebind to a replacement bookmark without removal evidence, as GUID dedupe does.
      state.tabs[2].bookmarkId = "vanished-guid";
      const outbound = createOutbound({ api: ff.browser, getState: () => state, save });
      const inbound = createInbound({ api: ff.browser, getState: () => state, save });
      await rebuild({ api: ff.browser, state, outbound, inbound, lostIdentity: true });
      assert.equal(state.tabs[2].bookmarkId, "pin");
      assert.equal(state.tabs[2].shownName, "Work");
      await outbound.syncTab(2);
      assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, "Page");
    } else {
      if (path === "extension rebuild") await ff.browser.storage.session.clear();
      const resumed = wire(ff);
      await drain(ff, resumed);
      await resumed.handlers["tabs.onUpdated"](2, { mutedInfo: { muted: true } });
      assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, "Page");
      assert.equal((await loadState(ff.browser)).tabs[2].title, "Page");
      assert.equal((await loadState(ff.browser)).tabs[2].shownName, "Work");
    }
  });
}

for (const action of ["unpin", "remove"]) {
  test(`shown-name guard is cleared on ${action} before delayed bookmark removal`, async () => {
    const { ff } = await fixture();
    const stored = await loadState(ff.browser);
    stored.tabs[2].shownName = "Work";
    await ff.browser.storage.local.set({ foxySync: stored });
    const sync = wire(ff, { removeDelayMs: 2000 });
    await drain(ff, sync);
    if (action === "unpin") {
      const get = ff.browser.tabs.get;
      ff.browser.tabs.get = async id => ({ ...await get(id), ...(id === 2 ? { pinned: false, title: "Work" } : {}) });
      await sync.handlers["tabs.onUpdated"](2, { pinned: false });
    } else await sync.handlers["tabs.onRemoved"](2, { windowId: 1, isWindowClosing: true });
    assert.equal((await loadState(ff.browser)).tabs[2].shownName, undefined);
  });
}

test("removing a board name restores the keeper and resumes ordinary outbound title sync", async () => {
  const { ff, sync } = await fixture({ title: "✏️ Work", origins: ["https://example.com/*"] });
  assert.deepEqual(await sync.onMessage({ type: "foxy:rename-pin", tabId: 2, name: null }), { ok: true });
  assert.deepEqual(scripts(ff).at(-1).args[0].args, [null]);
  const get = ff.browser.tabs.get;
  ff.browser.tabs.get = async id => ({ ...await get(id), ...(id === 2 ? { title: "Latest page" } : {}) });
  await sync.handlers["tabs.onUpdated"](2, { title: "Latest page" });
  await drain(ff, sync);
  assert.equal((await ff.browser.bookmarks.get("pin"))[0].title, "Latest page");
});
