import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import {
  STATE_KEY, emptyState, loadState, saveState, createQueue,
  folderOfGroup, groupOfFolder, tabsInFolder,
} from "../extension/src/sync/state.js";

const blank = () => ({
  rootId: null, pinnedId: null, groups: {}, tabs: {}, openFolders: [], missing: [],
  cantReopen: {}, deferred: [], quietUntil: {}, pendingRemovals: {}, failedCreates: {},
  removedIds: {}, folderSnapshots: {},
});
const populated = () => ({
  rootId: "root-guid", pinnedId: "pins-guid",
  groups: { 0: { folderId: "folder-a", title: "🔴 Work" }, 12: { folderId: "folder-b", title: "🔵 Play" } },
  tabs: {
    0: { bookmarkId: "bookmark-a", folderId: "folder-a", url: "https://example.com/a", title: "A" },
    9: { bookmarkId: "bookmark-b", folderId: "folder-b", url: "https://example.com/b", title: "B" },
    42: { bookmarkId: "bookmark-c", folderId: "folder-a", url: "https://example.com/c", title: "C" },
  },
  openFolders: ["folder-a", "folder-b"], missing: ["folder-c"],
  cantReopen: { "folder-c": ["file:///notes.txt", "about:config"] },
  deferred: ["folder-a"], quietUntil: { 42: 1234567890 },
  pendingRemovals: { 9: { bookmarkId: "bookmark-b", folderId: "folder-b", due: 1234567895 } },
  failedCreates: { 15: "data:text/plain,rejected" },
  removedIds: {}, folderSnapshots: {},
});

// Catch missing bookkeeping fields and shared mutable defaults across event-page loads.
test("emptyState has the complete shape and independent mutable containers", () => {
  const first = emptyState(), second = emptyState();
  assert.deepEqual(first, blank());
  first.groups[1] = { folderId: "folder", title: "Work" };
  first.tabs[1] = { bookmarkId: "bookmark", folderId: "folder", url: "https://example.com/", title: "Page" };
  first.openFolders.push("folder");
  first.missing.push("folder");
  first.cantReopen.folder = ["about:config"];
  first.deferred.push("folder");
  first.quietUntil[1] = 100;
  first.pendingRemovals[1] = { bookmarkId: "bookmark", folderId: "folder", due: 105 };
  first.failedCreates[2] = "data:text/plain,rejected";
  assert.deepEqual(second, blank());
});

test("missing storage loads the empty state without writing it", async () => {
  const ff = createFirefox();
  assert.deepEqual(await loadState(ff.browser), blank());
  assert.deepEqual(await ff.browser.storage.local.get(), {});
});

test("save and load round trip all state in storage.local without touching other keys", async () => {
  const ff = createFirefox(), state = populated();
  await ff.browser.storage.local.set({ other: { enabled: true } });
  await saveState(ff.browser, state);
  assert.equal(STATE_KEY, "foxySync");
  assert.deepEqual(await ff.browser.storage.local.get(), { other: { enabled: true }, foxySync: populated() });
  state.deferred.push("changed-after-save");
  const restored = await loadState(ff.browser);
  assert.deepEqual(restored, populated());
  restored.tabs[42].url = "https://changed.example/";
  restored.cantReopen["folder-c"].push("chrome://browser/");
  assert.deepEqual(await loadState(ff.browser), populated());
});

test("legacy state without pendingRemovals keeps its maps and defaults deadlines to empty", async () => {
  const ff = createFirefox(), legacy = populated();
  delete legacy.pendingRemovals;
  await ff.browser.storage.local.set({ foxySync: legacy });
  assert.deepEqual(await loadState(ff.browser), { ...legacy, pendingRemovals: {} });
});

test("legacy state without either new outbound field preserves maps", async () => {
  const ff = createFirefox(), legacy = populated();
  delete legacy.pendingRemovals;
  delete legacy.failedCreates;
  await ff.browser.storage.local.set({ foxySync: legacy });
  assert.deepEqual(await loadState(ff.browser), { ...legacy, pendingRemovals: {}, failedCreates: {} });
});

test("disposable outbound state: malformed fields default to empty without losing durable state", async (t) => {
  const cases = [
    ["pendingRemovals", "array", []],
    ["pendingRemovals", "null", null],
    ["pendingRemovals", "string", "broken"],
    ["pendingRemovals", "null entry", { 9: null }],
    ["pendingRemovals", "missing bookmark", { 9: { folderId: "folder-b", due: 105 } }],
    ["pendingRemovals", "wrong folder", { 9: { bookmarkId: "bookmark-b", folderId: 1, due: 105 } }],
    ["pendingRemovals", "wrong deadline", { 9: { bookmarkId: "bookmark-b", folderId: "folder-b", due: "soon" } }],
    ["pendingRemovals", "non-finite deadline", { 9: { bookmarkId: "bookmark-b", folderId: "folder-b", due: Infinity } }],
    ["pendingRemovals", "mixed valid and invalid", { 9: populated().pendingRemovals[9], 42: null }],
    ["removedIds", "array", []],
    ["removedIds", "null", null],
    ["removedIds", "wrong timestamp", { gone: "yesterday" }],
    ["folderSnapshots", "array", []],
    ["folderSnapshots", "null", null],
    ["folderSnapshots", "missing URLs", { gone: { title: "Dev", color: "red" } }],
    ["failedCreates", "array", []],
    ["failedCreates", "null", null],
    ["failedCreates", "number", 42],
    ["failedCreates", "wrong URL", { 15: null }],
    ["failedCreates", "mixed valid and invalid", { 15: "data:text/plain,rejected", 42: false }],
  ];
  for (const [field, name, value] of cases) await t.test(`${field}: ${name}`, async () => {
    const ff = createFirefox();
    await ff.browser.storage.local.set({ foxySync: { ...populated(), [field]: value } });
    ff.calls.length = 0;
    const restored = await loadState(ff.browser);
    assert.deepEqual(restored, { ...populated(), [field]: {} });
    assert.equal(ff.calls.some(call => call.api === "storage.local.set"), false);
    restored[field][123] = "local-only";
    assert.deepEqual(await loadState(ff.browser), { ...populated(), [field]: {} });
  });
  await t.test("both malformed", async () => {
    const ff = createFirefox();
    await ff.browser.storage.local.set({ foxySync: { ...populated(), pendingRemovals: null, failedCreates: [] } });
    assert.deepEqual(await loadState(ff.browser), { ...populated(), pendingRemovals: {}, failedCreates: {} });
  });
});

test("corrupt top-level and nested state gives a fresh empty state", async (t) => {
  const cases = [
    ["null", null], ["string", "broken"], ["array", []], ["empty object", {}],
    ["missing field", Object.fromEntries(Object.entries(populated()).filter(([key]) => key !== "deferred"))],
    ["wrong root id", { ...populated(), rootId: 1 }],
    ["wrong pinned id", { ...populated(), pinnedId: {} }],
    ["groups array", { ...populated(), groups: [] }],
    ["group null", { ...populated(), groups: { 1: null } }],
    ["group missing title", { ...populated(), groups: { 1: { folderId: "folder" } } }],
    ["group wrong folder id", { ...populated(), groups: { 1: { folderId: 1, title: "Work" } } }],
    ["tabs null", { ...populated(), tabs: null }],
    ["tab missing bookmark", { ...populated(), tabs: { 1: { folderId: "folder", url: "https://example.com/", title: "Page" } } }],
    ["tab wrong url", { ...populated(), tabs: { 1: { bookmarkId: "bookmark", folderId: "folder", url: 5, title: "Page" } } }],
    ["tab wrong title", { ...populated(), tabs: { 1: { bookmarkId: "bookmark", folderId: "folder", url: "https://example.com/", title: null } } }],
    ["openFolders not array", { ...populated(), openFolders: {} }],
    ["openFolders wrong member", { ...populated(), openFolders: [1] }],
    ["missing wrong member", { ...populated(), missing: [null] }],
    ["cantReopen not map", { ...populated(), cantReopen: [] }],
    ["cantReopen wrong list", { ...populated(), cantReopen: { folder: "about:config" } }],
    ["cantReopen wrong url", { ...populated(), cantReopen: { folder: [false] } }],
    ["deferred wrong member", { ...populated(), deferred: [false] }],
    ["quietUntil not map", { ...populated(), quietUntil: [] }],
    ["quietUntil wrong timestamp", { ...populated(), quietUntil: { 1: "soon" } }],
  ];
  for (const [name, value] of cases) await t.test(name, async () => {
    const ff = createFirefox();
    await ff.browser.storage.local.set({ foxySync: value });
    const restored = await loadState(ff.browser);
    assert.deepEqual(restored, blank());
    restored.deferred.push("local-only");
    assert.deepEqual(await loadState(ff.browser), blank());
  });
});

test("empty state itself round trips with nullable identities", async () => {
  const ff = createFirefox();
  await saveState(ff.browser, emptyState());
  assert.deepEqual(await loadState(ff.browser), blank());
});

test("a storage read failure is logged and gives empty state", async (t) => {
  const ff = createFirefox(), error = new Error("storage unavailable");
  t.mock.method(ff.browser.storage.local, "get", async () => { throw error; });
  const warn = t.mock.method(console, "warn", () => {});
  assert.deepEqual(await loadState(ff.browser), blank());
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /^Foxy:/);
  assert.ok(warn.mock.calls[0].arguments.includes(error));
});

test("mapping helpers convert numeric ids, preserve id zero and filter by folder", () => {
  const state = populated(), before = structuredClone(state);
  assert.equal(folderOfGroup(state, 0), "folder-a");
  assert.equal(folderOfGroup(state, 12), "folder-b");
  assert.equal(folderOfGroup(state, 99), null);
  assert.equal(groupOfFolder(state, "folder-a"), 0);
  assert.equal(groupOfFolder(state, "folder-b"), 12);
  assert.equal(groupOfFolder(state, "absent"), null);
  assert.deepEqual(tabsInFolder(state, "folder-a"), [[0, state.tabs[0]], [42, state.tabs[42]]]);
  assert.deepEqual(tabsInFolder(state, "absent"), []);
  assert.deepEqual(state, before);
});

// A gate makes concurrent execution/order bugs observable without timers.
test("queue runs one task at a time in call order and returns each result", async () => {
  const queue = createQueue(), seen = [];
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const first = queue.run(async () => {
    seen.push("first:start");
    entered.resolve();
    await gate.promise;
    seen.push("first:end");
    return 10;
  });
  const second = queue.run(async () => { seen.push("second"); return 20; });
  const third = queue.run(async () => { seen.push("third"); return 30; });
  await entered.promise;
  assert.deepEqual(seen, ["first:start"]);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), [10, 20, 30]);
  assert.deepEqual(seen, ["first:start", "first:end", "second", "third"]);
});

test("queue invokes handlers with no arguments", async () => {
  const queue = createQueue();
  await queue.run(() => "previous result");
  assert.equal(await queue.run((...args) => args.length), 0);
});

test("nested non-awaited run executes after the outer job in FIFO order", async () => {
  const queue = createQueue(), seen = [];
  let inner;
  const outer = queue.run(async () => {
    seen.push("outer:start");
    inner = queue.run(() => { seen.push("inner"); });
    seen.push("outer:end");
  });
  const later = queue.run(() => { seen.push("later"); });
  await Promise.all([outer, later]);
  await inner;
  assert.deepEqual(seen, ["outer:start", "outer:end", "later", "inner"]);
});

test("queue logs a rejected task, preserves rejection and continues", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const queue = createQueue(), error = new Error("handler failed"), seen = [];
  const first = queue.run(async () => { seen.push("failed"); throw error; });
  const second = queue.run(async () => { seen.push("later"); return "continued"; });
  await assert.rejects(first, candidate => candidate === error);
  assert.equal(await second, "continued");
  await queue.idle();
  assert.deepEqual(seen, ["failed", "later"]);
  assert.equal(log.mock.callCount(), 1);
  assert.deepEqual(log.mock.calls[0].arguments, ["Foxy: sync task failed", error]);
});

test("queue also survives a synchronous handler throw", async (t) => {
  t.mock.method(console, "error", () => {});
  const queue = createQueue();
  await assert.rejects(queue.run(() => { throw new Error("sync failure"); }), /sync failure/);
  assert.equal(await queue.run(async () => "next"), "next");
  await queue.idle();
});

test("idle waits for queued tasks, resolves after failure and allows later work", async (t) => {
  t.mock.method(console, "error", () => {});
  const queue = createQueue(), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  await queue.idle();
  const first = queue.run(async () => { entered.resolve(); await gate.promise; });
  const last = queue.run(async () => { throw new Error("last failed"); });
  const rejected = assert.rejects(last, /last failed/);
  let drained = false;
  const idle = queue.idle().then(() => { drained = true; });
  await entered.promise;
  assert.equal(drained, false);
  gate.resolve();
  await Promise.all([first, rejected, idle]);
  assert.equal(drained, true);
  assert.equal(await queue.run(async () => "new task"), "new task");
  await queue.idle();
});

test("idle drains jobs enqueued by a running job", async () => {
  const queue = createQueue(), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  let inner, finished = false;
  const outer = queue.run(() => {
    inner = queue.run(async () => {
      entered.resolve();
      await gate.promise;
      finished = true;
    });
  });
  const idle = queue.idle();
  await entered.promise;
  assert.equal(finished, false);
  // Release next turn: a tail snapshot resolves while the inner job is still gated.
  const finishedAtIdle = idle.then(() => finished);
  const release = setImmediate(() => gate.resolve());
  try {
    assert.equal(await finishedAtIdle, true);
  } finally {
    clearImmediate(release);
    gate.resolve();
    await Promise.all([outer, inner]);
  }
});

test("a failed storage save rejects its task but does not poison the queue", async (t) => {
  const ff = createFirefox(), queue = createQueue(), error = new Error("write failed");
  const set = ff.browser.storage.local.set;
  t.mock.method(ff.browser.storage.local, "set", async () => { throw error; });
  const log = t.mock.method(console, "error", () => {});
  await assert.rejects(queue.run(() => saveState(ff.browser, populated())), candidate => candidate === error);
  ff.browser.storage.local.set = set;
  await queue.run(() => saveState(ff.browser, populated()));
  await queue.idle();
  assert.deepEqual(await loadState(ff.browser), populated());
  assert.equal(log.mock.callCount(), 1);
});

test("legacy state without removal evidence or folder snapshots preserves its identities on wake", async () => {
  const ff = createFirefox(), legacy = populated();
  delete legacy.removedIds; delete legacy.folderSnapshots;
  await saveState(ff.browser, legacy);
  const state = await loadState(ff.browser);
  assert.deepEqual(state, { ...legacy, removedIds: {}, folderSnapshots: {} });
  await saveState(ff.browser, state);
  assert.deepEqual((await loadState(ff.browser)).tabs, legacy.tabs);
});

test("shown pin names survive valid state and malformed optional names do not lose identity", async () => {
  const ff = createFirefox(), state = populated();
  state.tabs[0].shownName = "Work";
  state.tabs[9].shownName = 42;
  state.tabs[42].shownName = "  ";
  await saveState(ff.browser, state);
  const loaded = await loadState(ff.browser);
  assert.equal(loaded.tabs[0].shownName, "Work");
  assert.equal(loaded.tabs[9].shownName, undefined);
  assert.equal(loaded.tabs[42].shownName, undefined);
  assert.equal(loaded.tabs[9].bookmarkId, "bookmark-b");
  assert.equal(loaded.tabs[42].bookmarkId, "bookmark-c");
});

test("applied pin names survive valid state and malformed optional names do not lose identity", async () => {
  const ff = createFirefox(), state = populated();
  state.tabs[0].appliedName = "Work";
  state.tabs[9].appliedName = 42;
  await saveState(ff.browser, state);
  const loaded = await loadState(ff.browser);
  assert.equal(loaded.tabs[0].appliedName, "Work");
  assert.equal(loaded.tabs[9].appliedName, undefined);
  assert.equal(loaded.tabs[9].bookmarkId, "bookmark-b");
});
