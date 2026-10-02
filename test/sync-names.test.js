import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { emptyState } from "../extension/src/sync/state.js";

const namesModule = () => import("../extension/src/sync/names.js");
async function fixture({ tab = {}, origins = [] } = {}) {
  const fake = createFirefox({ origins, tabs: [{ id: 1, windowId: 1, pinned: true,
    url: "https://example.com/a", title: "Page", ...tab }], bookmarks: [
    { id: "root", title: "Foxy", children: [
      { id: "pins", title: "📌 Pinned", children: [
        { id: "pin", url: "https://example.com/a", title: "✏️ Work" },
      ] },
    ] },
  ] });
  const state = emptyState();
  Object.assign(state, { rootId: "root", pinnedId: "pins", tabs: {
    1: { bookmarkId: "pin", folderId: "pins", url: "https://example.com/a", title: "Page" },
  } });
  const { createNames } = await namesModule();
  return { ...fake, state, names: createNames({ api: fake.browser, getState: () => state, save: async () => {} }) };
}

test("pin origins are HTTP(S) match patterns with no paths, credentials or ports", async () => {
  const { pinOrigin } = await namesModule();
  for (const [url, want] of [["https://user:pass@example.com:8443/a?q=1", "https://example.com/*"],
    ["http://127.0.0.1:3000/", "http://127.0.0.1/*"], ["https://[::1]:123/a", "https://[::1]/*"],
    ["about:config", null], ["file:///x", null], ["bad", null]]) assert.equal(pinOrigin(url), want);
});

test("named pins are listed without permission, then injected in the isolated top frame after a user grant", async () => {
  const { names, browser, calls, withUserInput, settle, state } = await fixture();
  assert.deepEqual(await names.pins(), { pins: { 1: { name: "Work", origin: "https://example.com/*", allowed: false } } });
  await names.apply(1);
  assert.equal(calls.filter(c => c.api === "scripting.executeScript").length, 0);
  await assert.rejects(browser.permissions.request({ origins: ["https://example.com/*"] }), /user input/i);
  assert.equal(await withUserInput(() => browser.permissions.request({ origins: ["https://example.com/*"] })), true);
  await settle();
  await names.apply(1);
  const details = calls.find(c => c.api === "scripting.executeScript").args[0];
  assert.deepEqual(details.target, { tabId: 1, frameIds: [0] });
  assert.equal(details.world, "ISOLATED");
  assert.equal(typeof details.func, "function");
  assert.deepEqual(details.args, ["Work"]);
  assert.equal(state.tabs[1].appliedName, "Work");
  assert.equal((await names.pins()).pins[1].allowed, true);
});

for (const tab of [{ discarded: true }, { status: "loading" }, { url: "about:config" }, { incognito: true }]) {
  test(`names skip tabs not eligible for injection: ${JSON.stringify(tab)}`, async () => {
    const { names, calls } = await fixture({ tab, origins: ["https://example.com/*"] });
    await names.apply(1);
    assert.equal(calls.filter(c => c.api === "scripting.executeScript").length, 0);
  });
}

test("bookmark unname and local unpin both restore an applied title keeper", async () => {
  const { names, browser, state, calls } = await fixture({ origins: ["https://example.com/*"] });
  await names.apply(1);
  await browser.bookmarks.update("pin", { title: "Page" });
  await names.apply(1);
  assert.deepEqual(calls.filter(c => c.api === "scripting.executeScript").at(-1).args[0].args, [null]);
  assert.equal(state.tabs[1].appliedName, undefined);
  await browser.bookmarks.update("pin", { title: "✏️ Work" });
  await names.apply(1);
  await browser.tabs.update(1, { pinned: false });
  await names.apply(1);
  assert.deepEqual(calls.filter(c => c.api === "scripting.executeScript").at(-1).args[0].args, [null]);
});

test("injection failure is logged once and does not record a successful application", async () => {
  const { names, browser, state } = await fixture({ origins: ["https://example.com/*"] });
  let attempts = 0;
  browser.scripting.executeScript = async () => { attempts++; throw new Error("Restricted page"); };
  const warnings = [], old = console.warn;
  console.warn = (...args) => warnings.push(args);
  try { await names.apply(1); } finally { console.warn = old; }
  assert.equal(attempts, 1);
  assert.match(warnings[0][0], /^Foxy:/);
  assert.equal(state.tabs[1].appliedName, undefined);
});
