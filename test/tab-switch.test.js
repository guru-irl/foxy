import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";

const URL_A = "https://example.com/path?q=1";
// A missing module is an explicit RED, not a silent skipped test.
async function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });
  const timers = new Set();
  const schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms) => {
    const id = schedule(() => { timers.delete(id); fn(); }, ms);
    timers.add(id); return id;
  });
  t.mock.method(globalThis, "clearTimeout", id => { timers.delete(id); return cancel(id); });
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
  async function create({ url, ...props } = {}) {
    const tab = await ff.createExternal({ windowId: 1, active: true, ...props });
    await flush();
    if (url && url !== "about:blank") await navigate(tab, url);
    return tab;
  }
  async function navigate(tab, url, changes = {}) {
    ff.commitExternal(tab.id, url);
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
  async function suspend(ms = 0) {
    ff.suspendBackground();
    await advance(ms);
    const control = createTabSwitch(ff.browser, { now: Date.now, ...options.dependencies });
    await control.ready; await flush();
  }
  return { ff, create, navigate, complete, advance, flush, switched, retained, timers, suspend };
}

for (const delay of [0, 2000]) {
  test(`an external URL switches immediately after initial blank completion (commit delay ${delay} ms)`, async t => {
    const f = await fixture(t); const tab = await f.create();
    await f.advance(delay); await f.navigate(tab, URL_A); await f.switched(tab);
  });
}

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

test("redirect chains remain candidates until the matching URL before settling", async t => {
  const f = await fixture(t); const tab = await f.create({ url: "https://redirect.example.com/start" });
  await f.advance(1001); await f.navigate(tab, "https://redirect.example.com/next"); await f.retained(tab);
  await f.advance(8000); await f.navigate(tab, URL_A); await f.switched(tab);
});

test("a final URL and completion in the same update still switch", async t => {
  const f = await fixture(t); const tab = await f.create(); await f.advance(1001);
  // Queue the combined event first, then update the live fake before delivery.
  // The combined completion must still allow the queued URL check to switch.
  f.ff.fire("tabs.onUpdated", tab.id, { url: URL_A, status: "complete" }, { ...tab, url: URL_A, status: "complete" });
  await f.ff.browser.tabs.update(tab.id, { url: URL_A });
  await f.flush(); await f.switched(tab);
});

test("a redirect while matches are queried does not close the new tab for a stale URL", async t => {
  const f = await fixture(t); const tab = await f.create();
  const query = f.ff.browser.tabs.query; let release;
  t.mock.method(f.ff.browser.tabs, "query", async (...args) => {
    const result = await query(...args);
    await new Promise(resolve => { release = resolve; }); return result;
  });
  await f.navigate(tab, URL_A); assert.ok(release);
  await f.navigate(tab, "https://redirect.example.com/unmatched");
  // Future checks should use the real query, not remain artificially blocked.
  f.ff.browser.tabs.query = query;
  release(); await f.flush(); await f.retained(tab);
});

test("at the two minute cap URL changes cannot switch", async t => {
  const f = await fixture(t); const tab = await f.create(); await f.advance(120000);
  await f.navigate(tab, URL_A); await f.retained(tab); assert.equal(f.timers.size, 0);
});

test("three seconds after a non-hop completion a later matching navigation cannot switch", async t => {
  const f = await fixture(t); const tab = await f.create({ url: "https://different.example.com/" });
  await f.complete(tab); await f.advance(3000);
  await f.navigate(tab, URL_A); await f.retained(tab); assert.equal(f.timers.size, 0);
});

test("a URL checked before the third burst tab may already have switched", async t => {
  const f = await fixture(t); const a = await f.create({ url: URL_A });
  await f.switched(a); await f.advance(400);
  const b = await f.create(); await f.advance(600); const c = await f.create();
  await f.navigate(b, URL_A); await f.navigate(c, URL_A);
  await f.retained(b); await f.retained(c);
});

test("a background creation is ignored even when later activated", async t => {
  const f = await fixture(t); const tab = await f.create({ active: false });
  await f.ff.browser.tabs.update(tab.id, { active: true }); await f.advance(1001);
  await f.navigate(tab, URL_A); await f.retained(tab);
});

for (const thirdActive of [true, false]) {
  test(`three creations in one second skip the entire burst, including a ${thirdActive ? "foreground" : "background"} third tab`, async t => {
    const f = await fixture(t); const a = await f.create(); await f.advance(400);
    const b = await f.create(); await f.advance(600);
    const c = await f.create({ active: thirdActive });
    for (const tab of [a, b, c]) await f.navigate(tab, URL_A);
    for (const tab of [a, b, c]) await f.retained(tab);
    assert.equal(f.ff.calls.some(call => call.api === "tabs.remove"), false);
  });
}

test("two creations are not a burst", async t => {
  const f = await fixture(t); const a = await f.create({ url: URL_A }); const b = await f.create({ url: URL_A });
  await f.advance(1001); await f.switched(a); await f.switched(b);
});

test("two simultaneous duplicates never close each other's only remaining URL", async t => {
  const f = await fixture(t, { setup: { tabs: [{ id: 1, windowId: 1, url: "https://different.example.com/" }] } });
  const a = await f.ff.createExternal({ windowId: 1, active: true });
  const b = await f.ff.createExternal({ windowId: 1, active: true });
  f.ff.commitExternal(a.id, URL_A); f.ff.commitExternal(b.id, URL_A);
  await f.flush();
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
  const tab = await f.create();
  const { markOwn } = await import("../extension/src/tabs/own.js");
  markOwn(tab.id); await f.navigate(tab, URL_A); await f.retained(tab);
});

test("Foxy-created candidates are ignored even when marked after onCreated", async t => {
  const own = new Set(); const f = await fixture(t, { dependencies: { isFoxyTab: id => own.has(id) } });
  const tab = await f.create(); own.add(tab.id); await f.navigate(tab, URL_A); await f.retained(tab);
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
      const calls = f.ff.calls.filter(call => ["tabGroups.update", "tabs.update", "windows.update", "tabs.discard", "tabs.remove"].includes(call.api));
      assert.deepEqual(calls.map(call => call.api), ["tabGroups.update", "tabs.update", "windows.update", "tabs.update", "tabs.discard", "tabs.remove"]);
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
  await f.navigate(tab, `${URL_A}#sync`); await f.retained(tab);
  const later = await f.create({ url: URL_A }); await f.switched(later, tab.id);
});

test("turning the setting off before URL arrival prevents a pending switch", async t => {
  const f = await fixture(t); const tab = await f.create();
  await f.ff.browser.storage.sync.set({ settings: { switchToOpenTab: false } });
  await f.navigate(tab, URL_A); await f.retained(tab);
});

test("the new tab never matches itself", async t => {
  const f = await fixture(t, { setup: { tabs: [{ id: 1, windowId: 1, url: "https://different.example.com/" }] } });
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
    const tab = await f.create();
    t.mock.method(f.ff.browser[namespace], method, async () => { throw new Error("closed meanwhile"); });
    await f.navigate(tab, URL_A); await f.retained(tab);
    assert.equal(f.ff.calls.some(call => call.api === "tabs.remove"), false);
  });
}

for (const api of ["query", "get", "update", "remove"]) {
  test(`a meanwhile-closed tab error from tabs.${api} is swallowed`, async t => {
    const f = await fixture(t); const tab = await f.create();
    t.mock.method(f.ff.browser.tabs, api, async () => { throw new Error("Invalid tab ID: closed meanwhile"); });
    await f.navigate(tab, URL_A); await f.advance(1001); assert.deepEqual(f.ff.errors, []);
    if (api === "update") assert.equal(f.ff.calls.some(call => call.api === "tabs.remove"), false);
    if (api !== "get") await f.retained(tab);
  });
}


test("an idle wake keeps the browser session start time and switches immediately", async t => {
  const f = await fixture(t); await f.advance(30000);
  assert.deepEqual(await f.ff.browser.storage.session.get("foxySwitchStartedAt"), { foxySwitchStartedAt: 100000 });
  f.ff.suspendBackground();
  const { createTabSwitch } = await import("../extension/src/tabs/switch.js");
  createTabSwitch(f.ff.browser, { now: Date.now });
  const tab = await f.create({ url: URL_A }); await f.switched(tab);
  assert.deepEqual(await f.ff.browser.storage.session.get("foxySwitchStartedAt"), { foxySwitchStartedAt: 100000 });
  assert.equal(f.ff.calls.filter(call => call.api === "storage.session.set" && "foxySwitchStartedAt" in call.args[0]).length, 1);
});

test("browser restart clears the session start and protects the new startup window", async t => {
  const f = await fixture(t); await f.advance(30000);
  f.ff.restart({ restore: true });
  const { createTabSwitch } = await import("../extension/src/tabs/switch.js");
  const control = createTabSwitch(f.ff.browser, { now: Date.now });
  await f.flush(); await control.ready;
  assert.deepEqual(await f.ff.browser.storage.session.get("foxySwitchStartedAt"), { foxySwitchStartedAt: 145000 });
  const tab = await f.create({ url: URL_A }); await f.retained(tab);
});

test("a startup event wins over an in-flight session read", async t => {
  const f = await fixture(t); await f.advance(30000); f.ff.suspendBackground();
  const get = f.ff.browser.storage.session.get; let release;
  t.mock.method(f.ff.browser.storage.session, "get", async (...args) => {
    const stored = await get(...args);
    await new Promise(resolve => { release = resolve; }); return stored;
  });
  const { createTabSwitch } = await import("../extension/src/tabs/switch.js");
  const control = createTabSwitch(f.ff.browser, { now: Date.now });
  await f.flush(); assert.ok(release);
  f.ff.fire("runtime.onStartup"); await f.flush(); release(); await control.ready;
  const tab = await f.create({ url: URL_A }); await f.retained(tab);
  assert.deepEqual(await get("foxySwitchStartedAt"), { foxySwitchStartedAt: 145000 });
});


test("switching blanks with loadReplace and flushes before removing only the duplicate", async t => {
  const f = await fixture(t); const tab = await f.create({ url: URL_A }); await f.switched(tab);
  const close = f.ff.calls.filter(call => ["tabs.update", "tabs.discard", "tabs.remove"].includes(call.api));
  assert.deepEqual(close, [
    { api: "tabs.update", args: [1, { active: true }] },
    { api: "tabs.update", args: [tab.id, { url: "about:blank", loadReplace: true }] },
    { api: "tabs.discard", args: [tab.id] },
    { api: "tabs.remove", args: [tab.id] },
  ]);
});

test("a URL change during window focus prevents blanking or closing the source", async t => {
  const f = await fixture(t); const tab = await f.create();
  const update = f.ff.browser.windows.update;
  t.mock.method(f.ff.browser.windows, "update", async (...args) => {
    f.ff.commitExternal(tab.id, "https://different.example.com/");
    return update(...args);
  });
  await f.navigate(tab, URL_A); await f.retained(tab);
  assert.equal(f.ff.calls.some(call => call.api === "tabs.remove" || call.api === "tabs.discard"
    || (call.api === "tabs.update" && call.args[1].loadReplace)), false);
});

test("a popup source never switches to a normal-window match", async t => {
  const f = await fixture(t, { setup: { windows: [{ id: 1, focused: true }, { id: 2, type: "popup" }] } });
  const tab = await f.create({ windowId: 2, url: URL_A }); await f.retained(tab);
  assert.equal(f.ff.calls.some(call => call.api === "tabs.remove"), false);
});

test("popup matches are skipped even when they would win by recency", async t => {
  const f = await fixture(t, { setup: { windows: [{ id: 1, focused: true }, { id: 2 }, { id: 3, type: "popup" }],
    tabs: [{ id: 1, windowId: 2, url: URL_A, lastAccessed: 1 }, { id: 2, windowId: 3, url: URL_A, lastAccessed: 100 }] } });
  const tab = await f.create({ url: URL_A }); await f.switched(tab, 1);
  assert.equal((await f.ff.browser.tabs.get(2)).url, URL_A);
});

test("a popup-only match leaves the duplicate open", async t => {
  const f = await fixture(t, { setup: { windows: [{ id: 1, focused: true }, { id: 2, type: "popup" }],
    tabs: [{ id: 1, windowId: 1 }, { id: 2, windowId: 2, url: URL_A }] } });
  const tab = await f.create({ url: URL_A }); await f.retained(tab);
});

test("switch updates register only URL and status properties", async t => {
  const f = await fixture(t); f.ff.suspendBackground();
  const source = f.ff.browser.tabs.onUpdated, add = source.addListener;
  const filters = [];
  t.mock.method(source, "addListener", (listener, filter) => { filters.push(filter); add(listener, filter); });
  const { createTabSwitch } = await import("../extension/src/tabs/switch.js");
  await createTabSwitch(f.ff.browser).ready;
  assert.deepEqual(filters, [{ properties: ["url", "status"] }]);
});

test("switch updates fall back if a properties filter is unavailable", async t => {
  const f = await fixture(t); f.ff.suspendBackground();
  const source = f.ff.browser.tabs.onUpdated, add = source.addListener;
  const filters = [], warn = t.mock.method(console, "warn", () => {});
  t.mock.method(source, "addListener", (listener, filter) => {
    filters.push(filter); if (filter?.properties.includes("url")) throw new Error("unsupported switch filter"); add(listener, filter);
  });
  const { createTabSwitch } = await import("../extension/src/tabs/switch.js");
  await createTabSwitch(f.ff.browser).ready;
  assert.deepEqual(filters, [{ properties: ["url", "status"] }, undefined]);
  assert.equal(warn.mock.callCount(), 1);
  const tab = await f.create({ url: URL_A }); await f.switched(tab);
});

test("web completion does not repeat the unchanged URL query", async t => {
  const f = await fixture(t);
  const tab = await f.ff.browser.tabs.create({ windowId: 1, active: true, url: "https://different.example.com/" });
  await f.advance(1001);
  const count = () => f.ff.calls.filter(call => call.api === "tabs.query").length;
  assert.equal(count(), 1); await f.complete(tab); assert.equal(count(), 1);
});

test("a settled Foxy board is never a later web navigation candidate", async t => {
  const f = await fixture(t); const tab = await f.create({ url: "moz-extension://foxy-test/newtab.html" });
  await f.complete(tab); await f.advance(3000); await f.navigate(tab, URL_A); await f.retained(tab);
});


test("a client-side redirect inside the settle window still switches", async t => {
  const f = await fixture(t); const tab = await f.create({ url: "https://different.example.com/" });
  await f.complete(tab); await f.advance(2999); await f.navigate(tab, URL_A); await f.switched(tab);
  assert.equal(f.timers.size, 0);
});

test("a URL change cancels settling until the next non-hop page completes", async t => {
  const f = await fixture(t); const tab = await f.create({ url: "https://different.example.com/" });
  await f.complete(tab); await f.advance(2000); await f.navigate(tab, "https://different.example.com/next");
  await f.advance(4000); await f.navigate(tab, URL_A); await f.switched(tab);
});

test("a new completed page gets its own three second settle window", async t => {
  const f = await fixture(t); const tab = await f.create({ url: "https://different.example.com/" });
  await f.complete(tab); await f.advance(2000); await f.navigate(tab, "https://different.example.com/next");
  await f.complete(tab); await f.advance(2999); await f.navigate(tab, URL_A); await f.switched(tab);
});

test("chat-app Safe Links completion does not end the watch", async t => {
  const f = await fixture(t); const tab = await f.create({ url:
    "https://cdn.example.net/evergreen-assets/safelinks/2/atp-safelinks.html" });
  await f.complete(tab); await f.advance(12000); await f.navigate(tab, URL_A); await f.switched(tab);
});

test("sign-in completions keep watching through the final URL forty seconds later", async t => {
  const f = await fixture(t); const tab = await f.create({ url: "https://different.example.com/" });
  await f.complete(tab); await f.advance(2000);
  await f.navigate(tab, "https://login.example.com/common"); await f.complete(tab);
  await f.advance(10000); await f.navigate(tab, "https://logon.example.com/"); await f.complete(tab);
  await f.advance(10000); await f.navigate(tab, "https://device.login.example.net/common/return"); await f.complete(tab);
  await f.advance(20000); await f.navigate(tab, URL_A); await f.switched(tab);
});

for (const url of ["https://login.example.com/common", "https://accounts.example.com/signin",
  "https://eu.safelinks.example.net/", "https://example.com/LOGIN",
  "https://cdn.example.net/evergreen-assets/safelinks/2/atp-safelinks.html"]) {
  test(`identical open hop tabs never match: ${url}`, async t => {
    const f = await fixture(t, { setup: { tabs: [{ id: 1, windowId: 1, url }] } });
    const tab = await f.create({ url }); await f.complete(tab); await f.advance(4000); await f.retained(tab);
    assert.equal(f.ff.calls.some(call => call.api === "tabs.query"), false);
  });
}

test("the optional hop classifier is used for matching and completion", async t => {
  const hop = "https://example.net/hop";
  const f = await fixture(t, { dependencies: { isHop: url => url === hop },
    setup: { tabs: [{ id: 1, windowId: 1, url: hop }, { id: 2, windowId: 1, url: URL_A }] } });
  const tab = await f.create({ url: hop }); await f.complete(tab); await f.advance(4000); await f.retained(tab);
  await f.navigate(tab, URL_A); await f.switched(tab, 2);
});

test("hop changes and completions cannot extend the two minute cap", async t => {
  const f = await fixture(t); const tab = await f.create({ url: "https://logon.example.com/" });
  await f.complete(tab); await f.advance(119999);
  await f.navigate(tab, "https://login.example.com/common"); await f.complete(tab);
  await f.advance(1); await f.navigate(tab, URL_A); await f.retained(tab); assert.equal(f.timers.size, 0);
});

test("a hop candidate still switches one millisecond before the cap", async t => {
  const f = await fixture(t); const tab = await f.create({ url: "https://logon.example.com/" });
  await f.complete(tab); await f.advance(119999); await f.navigate(tab, URL_A); await f.switched(tab);
});

for (const action of ["close", "setting off", "startup"]) {
  test(`${action} clears persisted candidates without timers`, async t => {
    const f = await fixture(t); const tab = await f.create({ url: "https://different.example.com/" });
    await f.complete(tab); assert.equal(f.timers.size, 0);
    assert.deepEqual(await f.ff.browser.storage.session.get("foxySwitchCandidates"), {
      foxySwitchCandidates: { [tab.id]: { created: 115000, url: "https://different.example.com/", settleAt: 118000 } },
    });
    if (action === "close") await f.ff.browser.tabs.remove(tab.id);
    if (action === "setting off") await f.ff.browser.storage.sync.set({ settings: { switchToOpenTab: false } });
    if (action === "startup") f.ff.fire("runtime.onStartup");
    await f.flush(); assert.equal(f.timers.size, 0);
    assert.deepEqual(await f.ff.browser.storage.session.get("foxySwitchCandidates"), { foxySwitchCandidates: {} });
    if (action !== "close") {
      await f.advance(15000); await f.ff.browser.storage.sync.remove("settings"); await f.flush();
      await f.navigate(tab, URL_A); await f.retained(tab);
    }
  });
}


test("a sign-in chain survives losing in-memory state and switches forty seconds later", async t => {
  const f = await fixture(t); const tab = await f.create({ url: "https://different.example.com/" });
  await f.complete(tab); await f.advance(2000);
  await f.navigate(tab, "https://login.example.com/common"); await f.complete(tab);
  await f.suspend(20000);
  await f.navigate(tab, "https://device.login.example.net/return"); await f.complete(tab);
  await f.suspend(20000); await f.navigate(tab, URL_A); await f.switched(tab);
  assert.deepEqual(await f.ff.browser.storage.session.get("foxySwitchCandidates"), { foxySwitchCandidates: {} });
});

test("a settled watch does not revive after losing in-memory state", async t => {
  const f = await fixture(t); const tab = await f.create({ url: "https://different.example.com/" });
  await f.complete(tab); await f.suspend(10000);
  await f.navigate(tab, URL_A); await f.retained(tab);
  assert.deepEqual(await f.ff.browser.storage.session.get("foxySwitchCandidates"), { foxySwitchCandidates: {} });
});

test("the two minute deadline survives losing in-memory state", async t => {
  const f = await fixture(t); const tab = await f.create({ url: "https://login.example.com/" });
  await f.complete(tab); await f.suspend(120000);
  await f.navigate(tab, URL_A); await f.retained(tab);
  assert.deepEqual(await f.ff.browser.storage.session.get("foxySwitchCandidates"), { foxySwitchCandidates: {} });
});

test("a resumed watch still switches just before its two minute deadline", async t => {
  const f = await fixture(t); const tab = await f.create({ url: "https://login.example.com/" });
  await f.complete(tab); await f.suspend(119999);
  await f.navigate(tab, URL_A); await f.switched(tab);
});

test("any write prunes expired watches for other tabs", async t => {
  const f = await fixture(t); const old = await f.create({ url: "https://different.example.com/" });
  await f.complete(old); await f.advance(3000);
  const live = await f.create({ url: "https://login.example.com/" });
  assert.deepEqual(await f.ff.browser.storage.session.get("foxySwitchCandidates"), {
    foxySwitchCandidates: { [live.id]: { created: 118000, url: "https://login.example.com/", settleAt: null } },
  });
});


test("three initial web URLs arriving before checks still skip the entire burst", async t => {
  const f = await fixture(t); const tabs = [];
  for (let i = 0; i < 3; i++) tabs.push(await f.ff.browser.tabs.create({ windowId: 1, active: true, url: URL_A }));
  await f.flush();
  for (const tab of tabs) await f.retained(tab);
  assert.equal(f.ff.calls.some(call => call.api === "tabs.remove"), false);
});
