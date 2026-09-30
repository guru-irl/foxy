import assert from "node:assert/strict";
import test from "node:test";
import { closedPagesToForget, createForgetter, forgetClosedPages } from "../src/forget.js";

const PAGE = "moz-extension://abc/newtab.html";

test("picks closed tabs that are this page", () => {
  const sessions = [
    { lastModified: 3, tab: { sessionId: "1", windowId: 7, url: PAGE } },
    { lastModified: 2, tab: { sessionId: "2", windowId: 7, url: "https://example.com/" } },
    { lastModified: 1, tab: { sessionId: "3", windowId: 8, url: PAGE } },
  ];
  assert.deepEqual(closedPagesToForget(sessions, PAGE), {
    tabs: [{ windowId: 7, sessionId: "1" }, { windowId: 8, sessionId: "3" }],
    windows: [],
  });
});

test("keeps tabs with another url, no url, or no open window", () => {
  const sessions = [
    { tab: { sessionId: "1", windowId: 7, url: `${PAGE}#x` } },
    { tab: { sessionId: "2", windowId: 7 } },
    { tab: { sessionId: "3", windowId: null, url: PAGE } },
    { tab: { sessionId: "4", url: PAGE } },
  ];
  assert.deepEqual(closedPagesToForget(sessions, PAGE), { tabs: [], windows: [] });
});

test("forgets a closed window only when every tab in it is this page", () => {
  const sessions = [
    { window: { sessionId: "w1", tabs: [{ url: PAGE }, { url: PAGE }] } },
    { window: { sessionId: "w2", tabs: [{ url: PAGE }, { url: "https://example.com/" }] } },
    { window: { sessionId: "w3", tabs: [] } },
    { window: { sessionId: "w4" } },
  ];
  assert.deepEqual(closedPagesToForget(sessions, PAGE), { tabs: [], windows: ["w1"] });
});

function fakeApi(sessions, { failTab = null } = {}) {
  const calls = [];
  return {
    calls,
    sessions: {
      async getRecentlyClosed() {
        calls.push(["getRecentlyClosed"]);
        return sessions;
      },
      async forgetClosedTab(windowId, sessionId) {
        calls.push(["forgetClosedTab", windowId, sessionId]);
        if (sessionId === failTab) throw new Error(`Could not find closed tab using sessionId ${sessionId}.`);
      },
      async forgetClosedWindow(sessionId) {
        calls.push(["forgetClosedWindow", sessionId]);
      },
    },
  };
}

test("forgetClosedPages forgets each match and keeps going after a failure", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const api = fakeApi(
    [
      { tab: { sessionId: "1", windowId: 7, url: PAGE } },
      { tab: { sessionId: "2", windowId: 7, url: PAGE } },
      { window: { sessionId: "w1", tabs: [{ url: PAGE }] } },
    ],
    { failTab: "1" },
  );
  assert.equal(await forgetClosedPages(api, PAGE), 3);
  assert.deepEqual(api.calls, [
    ["getRecentlyClosed"],
    ["forgetClosedTab", 7, "1"],
    ["forgetClosedTab", 7, "2"],
    ["forgetClosedWindow", "w1"],
  ]);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(warn.mock.calls[0].arguments[0], "Liquid Fox New Tab: could not forget a closed tab");
  assert.equal(warn.mock.calls[0].arguments[1], "1");
});

test("the forgetter runs one pass at a time and coalesces calls made during a pass", async (t) => {
  t.mock.method(console, "warn", () => {});
  let release;
  let reads = 0;
  const api = {
    sessions: {
      getRecentlyClosed() {
        reads += 1;
        if (reads === 1) return new Promise((resolve) => { release = () => resolve([]); });
        return Promise.resolve([]);
      },
      async forgetClosedTab() {},
      async forgetClosedWindow() {},
    },
  };
  const forget = createForgetter(api, PAGE);
  const first = forget();
  const second = forget();
  const third = forget();
  assert.equal(reads, 1);
  release();
  await Promise.all([first, second, third]);
  assert.equal(reads, 2);
});

test("the forgetter survives a failed read and works next time", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  let fail = true;
  const api = {
    sessions: {
      async getRecentlyClosed() {
        if (fail) throw new Error("boom");
        return [{ tab: { sessionId: "9", windowId: 1, url: PAGE } }];
      },
      forgetClosedTab: t.mock.fn(async () => {}),
      async forgetClosedWindow() {},
    },
  };
  const forget = createForgetter(api, PAGE);
  await forget();
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(warn.mock.calls[0].arguments[0], "Liquid Fox New Tab: could not read recently closed tabs");
  fail = false;
  await forget();
  assert.equal(api.sessions.forgetClosedTab.mock.callCount(), 1);
  assert.deepEqual(api.sessions.forgetClosedTab.mock.calls[0].arguments, [1, "9"]);
});
