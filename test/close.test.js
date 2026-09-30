import assert from "node:assert/strict";
import { test } from "node:test";
import { blankAndClose, handleMessage } from "../src/close.js";

function fakeApi({ updateFails = false, removeFails = false, onUpdate } = {}) {
  const calls = [];
  let listener;
  const api = {
    calls,
    runtime: { id: "own-extension" },
    tabs: {
      onUpdated: {
        addListener(fn) {
          calls.push(["addListener"]);
          listener = fn;
        },
        removeListener(fn) {
          calls.push(["removeListener"]);
          assert.equal(fn, listener);
          listener = undefined;
        },
      },
      async update(id, props) {
        calls.push(["update", id, props]);
        if (updateFails) throw new Error("Cannot blank tab");
        onUpdate?.(api);
      },
      async remove(id) {
        calls.push(["remove", id]);
        if (removeFails) throw new Error("Cannot remove tab");
      },
    },
    emit(id, changeInfo, tab) {
      assert.ok(listener, "onUpdated listener must be registered before the update event");
      listener(id, changeInfo, tab);
    },
  };
  return api;
}

const BLANK = { url: "about:blank", loadReplace: true };
const COMPLETE = { status: "complete" };
const MESSAGE = { type: "blank-and-close" };

test("blanks the page first, then removes it only after its about:blank completion event", async () => {
  const api = fakeApi();
  const closing = blankAndClose(api, 7, { timeoutMs: 30 });
  assert.deepEqual(api.calls, [["addListener"], ["update", 7, BLANK]]);
  api.emit(7, COMPLETE, { url: "about:blank" });
  await closing;
  assert.deepEqual(api.calls, [["addListener"], ["update", 7, BLANK], ["removeListener"], ["remove", 7]]);
});

test("ignores other tabs, loading status and other urls, then closes after the timeout", async () => {
  const api = fakeApi();
  const closing = blankAndClose(api, 7, { timeoutMs: 20 });
  api.emit(8, COMPLETE, { url: "about:blank" });
  api.emit(7, { status: "loading" }, { url: "about:blank" });
  api.emit(7, COMPLETE, { url: "https://example.com/" });
  assert.deepEqual(api.calls, [["addListener"], ["update", 7, BLANK]]);
  await closing;
  assert.deepEqual(api.calls, [["addListener"], ["update", 7, BLANK], ["removeListener"], ["remove", 7]]);
});

test("a failed blank warns, removes the listener and closes without waiting for the timeout", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const api = fakeApi({ updateFails: true });
  // A slow failure would leave this unresolved; cap the wait at 50 ms.
  let guard;
  try {
    await Promise.race([
      blankAndClose(api, 7, { timeoutMs: 10000 }),
      new Promise((_, reject) => { guard = setTimeout(() => reject(new Error("blank failure waited for timeout")), 50); }),
    ]);
  } finally {
    clearTimeout(guard);
  }
  assert.deepEqual(api.calls, [["addListener"], ["update", 7, BLANK], ["removeListener"], ["remove", 7]]);
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(warn.mock.calls[0].arguments.slice(0, 2), ["Liquid Fox New Tab: could not blank the page before closing it", 7]);
  assert.match(warn.mock.calls[0].arguments[2].message, /Cannot blank tab/);
});

test("a failed close warns and resolves after cleaning up", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const api = fakeApi({ removeFails: true, onUpdate: (browser) => {
    queueMicrotask(() => browser.emit(7, COMPLETE, { url: "about:blank" }));
  } });
  await blankAndClose(api, 7, { timeoutMs: 30 });
  assert.deepEqual(api.calls, [["addListener"], ["update", 7, BLANK], ["removeListener"], ["remove", 7]]);
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(warn.mock.calls[0].arguments.slice(0, 2), ["Liquid Fox New Tab: could not close the new tab page", 7]);
  assert.match(warn.mock.calls[0].arguments[2].message, /Cannot remove tab/);
});

test("a message from this extension closes only the sender's tab, never a tab id in the message", async () => {
  const api = fakeApi({ onUpdate: (browser) => {
    queueMicrotask(() => browser.emit(7, COMPLETE, { url: "about:blank" }));
  } });
  await handleMessage(api, { ...MESSAGE, tabId: 42 }, { id: "own-extension", tab: { id: 7 } });
  assert.deepEqual(api.calls, [["addListener"], ["update", 7, BLANK], ["removeListener"], ["remove", 7]]);
});

test("ignores wrong types, missing messages, foreign senders and missing or invalid sender tabs", () => {
  const api = fakeApi();
  for (const [message, sender] of [
    [{ type: "other" }, { id: "own-extension", tab: { id: 7 } }],
    [undefined, { id: "own-extension", tab: { id: 7 } }],
    [MESSAGE, { id: "another-extension", tab: { id: 7 } }],
    [MESSAGE, { id: "own-extension" }],
    [MESSAGE, { id: "own-extension", tab: { id: "7" } }],
  ]) {
    assert.equal(handleMessage(api, message, sender), undefined);
  }
  assert.deepEqual(api.calls, []);
});
