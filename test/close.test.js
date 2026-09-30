import assert from "node:assert/strict";
import { test } from "node:test";
import { blankAndClose, handleMessage } from "../extension/src/close.js";

function fakeApi({ updateFails = false, discardFails = false, discardHangs = false, removeFails = false, onUpdate } = {}) {
  const calls = [];
  let listener;
  const api = {
    calls,
    runtime: { id: "own-extension" },
    tabs: {
      onUpdated: {
        addListener(fn, filter) {
          calls.push(["addListener", filter]);
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
      async discard(id) {
        calls.push(["discard", id]);
        if (discardFails) throw new Error("Cannot flush tab");
        if (discardHangs) return new Promise(() => {});
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
const FILTER = { tabId: 7, properties: ["status"] };
const AFTER_BLANK = [["removeListener"], ["discard", 7], ["remove", 7]];

async function completesSoon(promise) {
  let guard;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => { guard = setTimeout(() => reject(new Error("completion event did not end the wait")), 50); }),
    ]);
  } finally {
    clearTimeout(guard);
  }
}

test("blanks the page first, then removes it only after its about:blank completion event", async () => {
  const api = fakeApi();
  const closing = blankAndClose(api, 7, { timeoutMs: 10000 });
  assert.deepEqual(api.calls, [["addListener", FILTER], ["update", 7, BLANK]]);
  api.emit(7, COMPLETE, { url: "about:blank" });
  await completesSoon(closing);
  assert.deepEqual(api.calls, [["addListener", FILTER], ["update", 7, BLANK], ...AFTER_BLANK]);
});

test("ignores other tabs, loading status and other urls until the matching event", async () => {
  const api = fakeApi();
  const closing = blankAndClose(api, 7, { timeoutMs: 10000 });
  for (const [id, status, url] of [
    [8, "complete", "about:blank"],
    [7, "loading", "about:blank"],
    [7, "complete", "https://example.com/"],
  ]) {
    api.emit(id, { status }, { url });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(api.calls, [["addListener", FILTER], ["update", 7, BLANK]]);
  }
  api.emit(7, COMPLETE, { url: "about:blank" });
  await completesSoon(closing);
  assert.deepEqual(api.calls, [["addListener", FILTER], ["update", 7, BLANK], ...AFTER_BLANK]);
});

test("closes after the timeout when no completion event arrives", async () => {
  const api = fakeApi();
  await blankAndClose(api, 7, { timeoutMs: 5 });
  assert.deepEqual(api.calls, [["addListener", FILTER], ["update", 7, BLANK], ...AFTER_BLANK]);
});

test("cancels the completion timeout after the event", async (t) => {
  const pending = new Set();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  t.after(() => { for (const timer of pending) realClearTimeout(timer); });
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
    const timer = realSetTimeout((...params) => {
      pending.delete(timer);
      fn(...params);
    }, ms, ...args);
    pending.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => {
    pending.delete(timer);
    realClearTimeout(timer);
  });
  const api = fakeApi({ onUpdate: (browser) => {
    queueMicrotask(() => browser.emit(7, COMPLETE, { url: "about:blank" }));
  } });
  await completesSoon(blankAndClose(api, 7, { timeoutMs: 10000 }));
  assert.equal(pending.size, 0, "completion timer must not stay pending after an event");
});

test("a hung discard times out, warns and removes the tab without leaving a timer", async (t) => {
  const pending = new Set();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  t.after(() => { for (const timer of pending) realClearTimeout(timer); });
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
    const timer = realSetTimeout((...params) => {
      pending.delete(timer);
      fn(...params);
    }, ms, ...args);
    pending.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => {
    pending.delete(timer);
    realClearTimeout(timer);
  });
  const warn = t.mock.method(console, "warn", () => {});
  const api = fakeApi({ discardHangs: true, onUpdate: (browser) => {
    queueMicrotask(() => browser.emit(7, COMPLETE, { url: "about:blank" }));
  } });
  await completesSoon(blankAndClose(api, 7, { timeoutMs: 10000, discardTimeoutMs: 20 }));
  assert.deepEqual(api.calls, [["addListener", FILTER], ["update", 7, BLANK], ...AFTER_BLANK]);
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(warn.mock.calls[0].arguments, ["Foxy: flushing the page's state timed out, closing it anyway", 7]);
  assert.equal(pending.size, 0, "discard timer must not stay pending after closing");
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
  assert.deepEqual(api.calls, [["addListener", FILTER], ["update", 7, BLANK], ["removeListener"], ["remove", 7]]);
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(warn.mock.calls[0].arguments.slice(0, 2), ["Foxy: could not blank the page before closing it", 7]);
  assert.match(warn.mock.calls[0].arguments[2].message, /Cannot blank tab/);
});

test("a failed close warns and resolves after cleaning up", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const api = fakeApi({ removeFails: true, onUpdate: (browser) => {
    queueMicrotask(() => browser.emit(7, COMPLETE, { url: "about:blank" }));
  } });
  await completesSoon(blankAndClose(api, 7, { timeoutMs: 10000 }));
  assert.deepEqual(api.calls, [["addListener", FILTER], ["update", 7, BLANK], ...AFTER_BLANK]);
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(warn.mock.calls[0].arguments.slice(0, 2), ["Foxy: could not close the new tab page", 7]);
  assert.match(warn.mock.calls[0].arguments[2].message, /Cannot remove tab/);
});

test("a failed discard warns and still removes the tab", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const api = fakeApi({ discardFails: true, onUpdate: (browser) => {
    queueMicrotask(() => browser.emit(7, COMPLETE, { url: "about:blank" }));
  } });
  await completesSoon(blankAndClose(api, 7, { timeoutMs: 10000 }));
  assert.deepEqual(api.calls, [["addListener", FILTER], ["update", 7, BLANK], ...AFTER_BLANK]);
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(warn.mock.calls[0].arguments.slice(0, 2), ["Foxy: could not flush the page's state before closing it", 7]);
  assert.match(warn.mock.calls[0].arguments[2].message, /Cannot flush tab/);
});

test("a message from this extension closes only the sender's tab, never a tab id in the message", async () => {
  const api = fakeApi({ onUpdate: (browser) => {
    queueMicrotask(() => browser.emit(7, COMPLETE, { url: "about:blank" }));
  } });
  await completesSoon(handleMessage(api, { ...MESSAGE, tabId: 42 }, { id: "own-extension", tab: { id: 7 } }));
  assert.deepEqual(api.calls, [["addListener", FILTER], ["update", 7, BLANK], ...AFTER_BLANK]);
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
