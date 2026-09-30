import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import {
  STATE_KEY, emptyState, loadState, saveState, createQueue,
  folderOfGroup, groupOfFolder, tabsInFolder,
} from "../extension/src/sync/state.js";

const blank = () => ({
  rootId: null, pinnedId: null, groups: {}, tabs: {}, openFolders: [], missing: [],
  cantReopen: {}, deferred: [], quietUntil: {},
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
