import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";

const URL_A = "https://example.com/path?q=1";
// A missing module is an explicit RED, not a silent skipped test.
async function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });
  const { createTabSwitch } = await import("../extension/src/tabs/switch.js");
  const ff = createFirefox({ windows: [{ id: 1, focused: true }, { id: 2 }],
    tabs: [{ id: 1, windowId: 1, url: URL_A }, { id: 2, windowId: 2, url: URL_A }], ...options.setup });
  if (options.stored) await ff.browser.storage.sync.set({ settings: options.stored });
  await ff.settle();
  if (options.background) {
    const previous = globalThis.browser;
    globalThis.browser = ff.browser;
    t.after(() => { globalThis.browser = previous; });
    await import("../extension/background.js?tab-switch-integration");
  } else {
    const control = createTabSwitch(ff.browser, { now: Date.now, ...options.dependencies });
    await control.ready;
  }
  async function flush() { for (let i = 0; i < 20; i++) { await ff.settle(); await Promise.resolve(); } }
  async function advance(ms) { t.mock.timers.tick(ms); await flush(); }
  if (!options.startup) await advance(15000);
  async function create(props = {}) {
    const tab = await ff.browser.tabs.create({ windowId: 1, url: "about:blank", active: true, ...props });
    await flush(); return tab;
  }
  async function navigate(tab, url, changes = {}) {
    await ff.browser.tabs.update(tab.id, { url });
    if (Object.keys(changes).length) ff.fire("tabs.onUpdated", tab.id, changes, await ff.browser.tabs.get(tab.id));
    await flush();
  }
  async function complete(tab) {
    ff.fire("tabs.onUpdated", tab.id, { status: "complete" }, await ff.browser.tabs.get(tab.id)); await flush();
  }
  async function switched(tab, target = 1) {
    await assert.rejects(ff.browser.tabs.get(tab.id), /Invalid tab/);
    assert.equal((await ff.browser.tabs.get(target)).active, true);
    assert.equal((await ff.browser.windows.getLastFocused()).id, (await ff.browser.tabs.get(target)).windowId);
    assert.deepEqual(ff.errors, []);
  }
  async function retained(tab) { assert.equal((await ff.browser.tabs.get(tab.id)).id, tab.id); assert.deepEqual(ff.errors, []); }
  return { ff, create, navigate, complete, advance, flush, switched, retained };
}

test("a new foreground URL activates its open match and closes the duplicate after the burst guard", async t => {
  const f = await fixture(t); const tab = await f.create({ url: URL_A });
  await f.retained(tab); await f.advance(1001); await f.switched(tab);
});

test("the background module wires duplicate switching at startup", async t => {
  const f = await fixture(t, { background: true }); const tab = await f.create({ url: URL_A });
  await f.advance(1001); await f.switched(tab);
});

test("URL changes during the first load switch, ignoring only the fragment", async t => {
  const f = await fixture(t); const tab = await f.create();
  await f.advance(1001); await f.navigate(tab, `${URL_A}#part`); await f.switched(tab);
});

for (const url of ["https://example.com/path/?q=1", "https://example.com/path?q=2", "https://example.com/path?q=1&", "http://example.com/path?q=1", "https://example.com/PATH?q=1", "https://example.com:443/path?q=1"]) {
  test(`differences other than fragments do not match: ${url}`, async t => {
    const f = await fixture(t); const tab = await f.create({ url });
    await f.advance(1001); await f.retained(tab);
  });
}

test("redirect chains remain candidates until the matching URL within ten seconds", async t => {
  const f = await fixture(t); const tab = await f.create({ url: "https://redirect.example/start" });
  await f.advance(1001); await f.navigate(tab, "https://redirect.example/next"); await f.retained(tab);
  await f.advance(8000); await f.navigate(tab, URL_A); await f.switched(tab);
});

test("a final URL and completion in the same update still switch", async t => {
  const f = await fixture(t); const tab = await f.create(); await f.advance(1001);
  // Queue the combined event first, then update the live fake before delivery.
  // Its later URL-only event must not rescue a candidate already completed.
  f.ff.fire("tabs.onUpdated", tab.id, { url: URL_A, status: "complete" }, { ...tab, url: URL_A, status: "complete" });
  await f.ff.browser.tabs.update(tab.id, { url: URL_A });
  await f.flush(); await f.switched(tab);
});

test("a redirect while matches are queried does not close the new tab for a stale URL", async t => {
  const f = await fixture(t); const tab = await f.create({ url: URL_A });
  const query = f.ff.browser.tabs.query; let release;
  t.mock.method(f.ff.browser.tabs, "query", async (...args) => {
    const result = await query(...args);
    await new Promise(resolve => { release = resolve; }); return result;
  });
  await f.advance(1001); assert.ok(release);
  await f.navigate(tab, "https://redirect.example/unmatched");
  // Future checks should use the real query, not remain artificially blocked.
  f.ff.browser.tabs.query = query;
  release(); await f.flush(); await f.retained(tab);
});

test("after ten seconds URL changes cannot switch", async t => {
  const f = await fixture(t); const tab = await f.create(); await f.advance(10000);
  await f.navigate(tab, URL_A); await f.retained(tab);
});

test("after the first complete load a later matching navigation cannot switch", async t => {
  const f = await fixture(t); const tab = await f.create(); await f.advance(1001);
  await f.complete(tab); await f.navigate(tab, URL_A); await f.retained(tab);
});

test("a URL received before completion still switches after the burst guard", async t => {
  const f = await fixture(t); const tab = await f.create({ url: URL_A });
  await f.complete(tab); await f.advance(1001); await f.switched(tab);
});

test("a background creation is ignored even when later activated", async t => {
  const f = await fixture(t); const tab = await f.create({ active: false });
  await f.ff.browser.tabs.update(tab.id, { active: true }); await f.advance(1001);
  await f.navigate(tab, URL_A); await f.retained(tab);
});

for (const thirdActive of [true, false]) {
  test(`three creations in one second skip the entire burst, including a ${thirdActive ? "foreground" : "background"} third tab`, async t => {
    const f = await fixture(t); const a = await f.create({ url: URL_A }); await f.advance(400);
    const b = await f.create({ url: URL_A }); await f.advance(600);
    const c = await f.create({ url: URL_A, active: thirdActive }); await f.advance(1001);
    for (const tab of [a, b, c]) await f.retained(tab);
    assert.equal(f.ff.calls.some(call => call.api === "tabs.remove"), false);
  });
}

test("two creations are not a burst", async t => {
  const f = await fixture(t); const a = await f.create({ url: URL_A }); const b = await f.create({ url: URL_A });
  await f.advance(1001); await f.switched(a); await f.switched(b);
});

test("two simultaneous duplicates never close each other's only remaining URL", async t => {
  const f = await fixture(t, { setup: { tabs: [{ id: 1, windowId: 1, url: "https://different.example/" }] } });
  await f.create({ url: URL_A }); await f.create({ url: URL_A }); await f.advance(1001);
  const matches = (await f.ff.browser.tabs.query({})).filter(tab => tab.url === URL_A);
  assert.equal(matches.length, 1); assert.equal(matches[0].active, true);
});

test("three creations spread outside one second are not a burst", async t => {
  const f = await fixture(t); await f.create({ active: false }); await f.advance(501);
  await f.create({ active: false }); await f.advance(500);
  const tab = await f.create({ url: URL_A }); await f.advance(1001); await f.switched(tab);
});

test("the background start time skips candidates created before fifteen seconds", async t => {
  const f = await fixture(t, { startup: true }); await f.advance(14999);
  const tab = await f.create({ url: URL_A }); await f.advance(1001); await f.retained(tab);
  await f.navigate(tab, `${URL_A}#later`); await f.retained(tab);
});

test("runtime.onStartup resets the fifteen second startup window", async t => {
  const f = await fixture(t); f.ff.fire("runtime.onStartup"); await f.flush();
  const tab = await f.create({ url: URL_A }); await f.advance(1001); await f.retained(tab);
  await f.advance(15000); const later = await f.create({ url: URL_A }); await f.advance(1001); await f.switched(later, tab.id);
});

test("the default ownership registry prevents switching a Foxy-created tab", async t => {
  const f = await fixture(t, { setup: { tabs: [{ id: 50000, windowId: 1, url: URL_A }] } });
  const tab = await f.create({ url: URL_A });
  const { markOwn } = await import("../extension/src/tabs/own.js");
  markOwn(tab.id); await f.advance(1001); await f.retained(tab);
});

test("Foxy-created candidates are ignored even when marked after onCreated", async t => {
  const own = new Set(); const f = await fixture(t, { dependencies: { isFoxyTab: id => own.has(id) } });
  const tab = await f.create({ url: URL_A }); own.add(tab.id); await f.advance(1001); await f.retained(tab);
});

for (const [candidate, match] of [
  [{ cookieStoreId: "firefox-container-1" }, { cookieStoreId: "firefox-default" }],
  [{ cookieStoreId: "firefox-default" }, { cookieStoreId: "firefox-container-2" }],
  [{ incognito: true }, { incognito: false }],
  [{ incognito: false }, { incognito: true }],
]) {
  test(`private and container states must match: ${JSON.stringify([candidate, match])}`, async t => {
    const f = await fixture(t, { setup: { tabs: [{ id: 1, windowId: 1, url: URL_A, ...match }] } });
    const tab = await f.create(candidate); await f.navigate(tab, URL_A); await f.advance(1001); await f.retained(tab);
  });
}

test("matching private container tabs can switch", async t => {
  const f = await fixture(t, { setup: { windows: [{ id: 1, incognito: true, focused: true }],
    tabs: [{ id: 1, windowId: 1, url: URL_A, cookieStoreId: "firefox-private" }] } });
  const tab = await f.create({ cookieStoreId: "firefox-private", url: URL_A }); await f.advance(1001); await f.switched(tab);
});

for (const pinned of [true, false]) {
  test(`${pinned ? "pinned" : "grouped"} matches count and collapsed groups expand before activation`, async t => {
    const f = await fixture(t, { setup: { groups: [{ id: 7, windowId: 2, collapsed: true }],
      tabs: [{ id: 1, windowId: 1 }, { id: 2, windowId: 2, url: URL_A, pinned, groupId: pinned ? -1 : 7 }] } });
    const tab = await f.create({ url: URL_A }); await f.advance(1001); await f.switched(tab, 2);
    if (!pinned) {
      assert.equal((await f.ff.browser.tabGroups.get(7)).collapsed, false);
      const calls = f.ff.calls.filter(call => ["tabGroups.update", "tabs.update", "windows.update", "tabs.remove"].includes(call.api));
      assert.deepEqual(calls.map(call => call.api), ["tabGroups.update", "tabs.update", "windows.update", "tabs.remove"]);
    }
  });
}

for (const [tabs, target] of [
  [[{ id: 1, windowId: 1, lastAccessed: 2 }, { id: 2, windowId: 2, lastAccessed: 100 }], 1],
  [[{ id: 1, windowId: 2, lastAccessed: 2 }, { id: 2, windowId: 2, lastAccessed: 100 }], 2],
  [[{ id: 1, windowId: 1, lastAccessed: 100 }, { id: 2, windowId: 1, lastAccessed: 2 }], 1],
]) {
  test(`multiple matches prefer this window then recency: target ${target}, ${JSON.stringify(tabs)}`, async t => {
    const f = await fixture(t, { setup: { tabs: tabs.map(tab => ({ ...tab, url: URL_A })) } });
    const tab = await f.create({ url: URL_A }); await f.advance(1001); await f.switched(tab, target);
  });
}

test("fragments are ignored on both the new tab and its existing match", async t => {
  const f = await fixture(t, { setup: { tabs: [{ id: 1, windowId: 1, url: `${URL_A}#old` }] } });
  const tab = await f.create({ url: `${URL_A}#new` }); await f.advance(1001); await f.switched(tab);
});

test("injected initial settings can disable switching when storage has no setting", async t => {
  const f = await fixture(t, { dependencies: { settings: { switchToOpenTab: false } } });
  const tab = await f.create({ url: URL_A }); await f.advance(1001); await f.retained(tab);
});

test("an initially disabled synced setting prevents switches", async t => {
  const f = await fixture(t, { stored: { switchToOpenTab: false } });
  const tab = await f.create({ url: URL_A }); await f.advance(1001); await f.retained(tab);
});

test("live synced setting changes apply, local changes do not, and removal restores default on", async t => {
  const f = await fixture(t); await f.ff.browser.storage.sync.set({ settings: { switchToOpenTab: false } }); await f.flush();
  const tab = await f.create({ url: URL_A }); await f.advance(1001); await f.retained(tab);
  await f.ff.browser.storage.local.set({ settings: { switchToOpenTab: true } }); await f.flush();
  await f.navigate(tab, `${URL_A}#local`); await f.retained(tab);
  await f.ff.browser.storage.sync.remove("settings"); await f.flush();
  await f.navigate(tab, `${URL_A}#sync`); await f.switched(tab);
});

test("turning the setting off during the burst guard prevents a pending switch", async t => {
  const f = await fixture(t); const tab = await f.create({ url: URL_A });
  await f.ff.browser.storage.sync.set({ settings: { switchToOpenTab: false } }); await f.advance(1001); await f.retained(tab);
});

test("the new tab never matches itself", async t => {
  const f = await fixture(t, { setup: { tabs: [{ id: 1, windowId: 1, url: "https://different.example/" }] } });
  const tab = await f.create({ url: URL_A }); await f.advance(1001); await f.retained(tab);
});

for (const url of ["about:blank", "moz-extension://foxy-test/newtab.html"]) {
  test(`non-web URLs are not candidates: ${url}`, async t => {
    const f = await fixture(t, { setup: { tabs: [{ id: 1, windowId: 1, url }] } });
    const tab = await f.create({ url }); await f.advance(1001); await f.retained(tab);
  });
}

for (const [namespace, method] of [["tabGroups", "get"], ["tabGroups", "update"], ["windows", "update"]]) {
  test(`a closed match or window error from ${namespace}.${method} leaves the new tab open`, async t => {
    const f = await fixture(t, { setup: { groups: [{ id: 7, windowId: 2, collapsed: true }],
      tabs: [{ id: 1, windowId: 1 }, { id: 2, windowId: 2, groupId: 7, url: URL_A }] } });
    const tab = await f.create({ url: URL_A });
    t.mock.method(f.ff.browser[namespace], method, async () => { throw new Error("closed meanwhile"); });
    await f.advance(1001); await f.retained(tab);
    assert.equal(f.ff.calls.some(call => call.api === "tabs.remove"), false);
  });
}

for (const api of ["query", "get", "update", "remove"]) {
  test(`a meanwhile-closed tab error from tabs.${api} is swallowed`, async t => {
    const f = await fixture(t); const tab = await f.create({ url: URL_A });
    t.mock.method(f.ff.browser.tabs, api, async () => { throw new Error("Invalid tab ID: closed meanwhile"); });
    await f.advance(1001); assert.deepEqual(f.ff.errors, []);
    if (api === "update") assert.equal(f.ff.calls.some(call => call.api === "tabs.remove"), false);
    if (api !== "get") await f.retained(tab);
  });
}
