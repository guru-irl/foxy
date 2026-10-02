import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { wire, drain } from "./fakes/sync.js";
import { loadState } from "../extension/src/sync/state.js";

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
    ff.browser.tabs.get = async id => ({ ...await get(id), ...(id === 2 ? {
      title: "Work", discarded: mode === "discarded",
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
