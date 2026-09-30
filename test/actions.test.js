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

test("switches to the tab, then closes the page's own tab", async () => {
  const api = fakeApi();
  assert.equal(await activateTab(api, 5, 99), true);
  assert.deepEqual(api.calls, [["update", 5, { active: true }], ["remove", 99]]);
});

test("stays open when the tab can't be switched to", async () => {
  const api = fakeApi({ updateFails: true });
  assert.equal(await activateTab(api, 5, 99), false);
  assert.deepEqual(api.calls, [["update", 5, { active: true }]]);
});

test("a failed close still counts as switched", async () => {
  const api = fakeApi({ removeFails: true });
  assert.equal(await activateTab(api, 5, 99), true);
  assert.deepEqual(api.calls, [["update", 5, { active: true }], ["remove", 99]]);
});
