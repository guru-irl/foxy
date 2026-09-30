import { test } from "node:test";
import assert from "node:assert/strict";
import { activateTab } from "../src/actions.js";

function fakeApi({ updateFails = false, sendFails = false, removeFails = false } = {}) {
  const calls = [];
  return {
    calls,
    tabs: {
      async update(id, props) {
        calls.push(["update", id, props]);
        if (updateFails) throw new Error("Invalid tab ID");
      },
      async remove(id) {
        calls.push(["remove", id]);
        if (removeFails) throw new Error("Invalid tab ID");
      },
    },
    runtime: {
      async sendMessage(message) {
        calls.push(["sendMessage", message]);
        if (sendFails) throw new Error("No background listener");
      },
    },
  };
}

test("switches to the tab, then asks the background to blank and close its own tab", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const api = fakeApi();
  assert.equal(await activateTab(api, 5, 99), true);
  assert.deepEqual(api.calls, [["update", 5, { active: true }], ["sendMessage", { type: "blank-and-close" }]]);
  assert.equal(warn.mock.callCount(), 0);
});

test("switches without asking to close or removing the page when preserving its history", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const api = fakeApi();
  assert.equal(await activateTab(api, 5, 99, { close: false }), true);
  assert.deepEqual(api.calls, [["update", 5, { active: true }]]);
  assert.equal(warn.mock.callCount(), 0);
});

test("stays open when the tab can't be switched to", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const api = fakeApi({ updateFails: true });
  assert.equal(await activateTab(api, 5, 99), false);
  assert.deepEqual(api.calls, [["update", 5, { active: true }]]);
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(warn.mock.calls[0].arguments.slice(0, 2), ["Liquid Fox New Tab: could not switch to tab", 5]);
  assert.match(warn.mock.calls[0].arguments[2].message, /Invalid tab ID/);
});

test("a failed close request warns and falls back to removing the page", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const api = fakeApi({ sendFails: true });
  assert.equal(await activateTab(api, 5, 99), true);
  assert.deepEqual(api.calls, [
    ["update", 5, { active: true }],
    ["sendMessage", { type: "blank-and-close" }],
    ["remove", 99],
  ]);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(warn.mock.calls[0].arguments[0], "Liquid Fox New Tab: could not ask to close the page, closing it directly");
  assert.match(warn.mock.calls[0].arguments[1].message, /No background listener/);
});

test("a failed close request and fallback remove both warn but still count as switched", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const api = fakeApi({ sendFails: true, removeFails: true });
  assert.equal(await activateTab(api, 5, 99), true);
  assert.deepEqual(api.calls, [
    ["update", 5, { active: true }],
    ["sendMessage", { type: "blank-and-close" }],
    ["remove", 99],
  ]);
  assert.equal(warn.mock.callCount(), 2);
  assert.equal(warn.mock.calls[0].arguments[0], "Liquid Fox New Tab: could not ask to close the page, closing it directly");
  assert.match(warn.mock.calls[0].arguments[1].message, /No background listener/);
  assert.deepEqual(warn.mock.calls[1].arguments.slice(0, 2), ["Liquid Fox New Tab: could not close the new tab page", 99]);
  assert.match(warn.mock.calls[1].arguments[2].message, /Invalid tab ID/);
});

test("a synchronous update error leaves the page open and logs the failure", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const calls = [];
  const api = {
    tabs: {
      update(id, props) {
        calls.push(["update", id, props]);
        throw new Error("Invalid tab ID");
      },
      async remove(id) {
        calls.push(["remove", id]);
      },
    },
    runtime: {
      async sendMessage(message) {
        calls.push(["sendMessage", message]);
      },
    },
  };
  assert.equal(await activateTab(api, 5, 99), false);
  assert.deepEqual(calls, [["update", 5, { active: true }]]);
  assert.equal(warn.mock.callCount(), 1);
});
