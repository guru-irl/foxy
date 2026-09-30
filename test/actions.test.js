import { test } from "node:test";
import assert from "node:assert/strict";
import { activateTab } from "../src/actions.js";

function fakeApi({ updateFails = false, removeFails = false } = {}) {
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
  };
}

test("switches to the tab, then closes the page's own tab", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const api = fakeApi();
  assert.equal(await activateTab(api, 5, 99), true);
  assert.deepEqual(api.calls, [["update", 5, { active: true }], ["remove", 99]]);
  assert.equal(warn.mock.callCount(), 0);
});

test("switches without closing the page when preserving its history", async (t) => {
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
  assert.equal(warn.mock.calls[0].arguments[0], "Liquid Fox New Tab: could not switch to tab");
  assert.equal(warn.mock.calls[0].arguments[1], 5);
});

test("a failed close still counts as switched", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const api = fakeApi({ removeFails: true });
  assert.equal(await activateTab(api, 5, 99), true);
  assert.deepEqual(api.calls, [["update", 5, { active: true }], ["remove", 99]]);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(warn.mock.calls[0].arguments[0], "Liquid Fox New Tab: could not close the new tab page");
  assert.equal(warn.mock.calls[0].arguments[1], 99);
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
  };
  assert.equal(await activateTab(api, 5, 99), false);
  assert.deepEqual(calls, [["update", 5, { active: true }]]);
  assert.equal(warn.mock.callCount(), 1);
});
