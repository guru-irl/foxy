import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { readTree } from "../extension/src/sync/tree.js";
import { matchGroups, matchTabs } from "../extension/src/sync/match.js";

function folder(id, index, urls = [], extra = {}) {
  return { id, index, title: "🔴 Work", name: "Work", color: "red",
    bookmarks: urls.map((url, index) => ({ id: `${id}-${index}`, index, url, title: `Page ${index}` })),
    ...extra };
}
const group = (groupId, urls = [], extra = {}) => ({ groupId, title: "Work", color: "red", urls, ...extra });

// Wrong identity, scoring, ordering or reuse branches each change literal pairs below.
test("group matching requires both case-sensitive decoded name and equal colour", () => {
  const open = [group(1), group(2, [], { title: "work" }), group(3, [], { color: "blue" })];
  const folders = [folder("plain", 0, [], { title: "Work", color: "grey" }),
    folder("red", 1), folder("wrong-name", 2, [], { title: "🔵 Other", name: "Other", color: "blue" })];
  assert.deepEqual(matchGroups(open, folders), {
    pairs: [{ groupId: 1, folderId: "red" }], unmatchedGroups: [2, 3], unmatchedFolders: ["plain", "wrong-name"],
  });
});

test("group matching prefers the candidate sharing the most URLs over a lower index", () => {
  const urls = ["https://example.com/a", "https://example.com/b"];
  assert.deepEqual(matchGroups([group(1, urls)], [folder("few", 0, urls.slice(0, 1)), folder("most", 9, urls)]), {
    pairs: [{ groupId: 1, folderId: "most" }], unmatchedGroups: [], unmatchedFolders: ["few"],
  });
});

test("equal URL overlap is resolved by folder index, not candidate array order", () => {
  const urls = ["https://example.com/a"];
  assert.deepEqual(matchGroups([group(1, urls)], [folder("later", 8, urls), folder("earlier", 2, urls)]), {
    pairs: [{ groupId: 1, folderId: "earlier" }], unmatchedGroups: [], unmatchedFolders: ["later"],
  });
});

test("zero overlap still matches an identity and prefers the lower folder index", () => {
  assert.deepEqual(matchGroups([group(1, ["https://example.com/other"])], [
    folder("later", 4, ["https://example.com/a"]), folder("first", 0, ["https://example.com/b"]),
  ]), {
    pairs: [{ groupId: 1, folderId: "first" }], unmatchedGroups: [], unmatchedFolders: ["later"],
  });
});

test("groups are processed in given order and each folder is used at most once", () => {
  const url = "https://example.com/a";
  const open = [group(9), group(2, [url]), group(1)];
  assert.deepEqual(matchGroups(open, [folder("first", 0, [url]), folder("second", 1)]), {
    pairs: [{ groupId: 9, folderId: "first" }, { groupId: 2, folderId: "second" }],
    unmatchedGroups: [1], unmatchedFolders: [],
  });
});

test("group matching trims names as folder encoding does, including unnamed groups", async () => {
  const ff = createFirefox({ bookmarks: [{ title: "Foxy", children: [
    { title: "🔴 Work" }, { title: " 🩵\uFE0F  Planning " }, { title: "🩶" },
  ] }] });
  const [root] = await ff.browser.bookmarks.getChildren("unfiled_____");
  const [work, planning, unnamed] = await ff.browser.bookmarks.getChildren(root.id);
  const { folders } = await readTree(ff.browser, root.id);
  assert.deepEqual(matchGroups([
    group(1, [], { title: "Work " }),
    group(2, [], { title: "  Planning  ", color: "cyan" }),
    group(3, [], { title: "   ", color: "grey" }),
  ], folders), {
    pairs: [{ groupId: 1, folderId: work.id }, { groupId: 2, folderId: planning.id }, { groupId: 3, folderId: unnamed.id }],
    unmatchedGroups: [], unmatchedFolders: [],
  });
});

test("group matching is pure and preserves unmatched input order", () => {
  const open = [group(8, [], { title: "Missing" }), group(3), group(1, [], { title: "Other" })];
  const folders = [folder("late", 8, [], { name: "Unmatched" }), folder("match", 2),
    folder("early", 0, [], { name: "Also unmatched" })];
  const before = structuredClone({ open, folders });
  assert.deepEqual(matchGroups(open, folders), {
    pairs: [{ groupId: 3, folderId: "match" }], unmatchedGroups: [8, 1], unmatchedFolders: ["late", "early"],
  });
  assert.deepEqual({ open, folders }, before);
});

test("group matching handles empty sides", () => {
  assert.deepEqual(matchGroups([], []), { pairs: [], unmatchedGroups: [], unmatchedFolders: [] });
  assert.deepEqual(matchGroups([group(7)], []), { pairs: [], unmatchedGroups: [7], unmatchedFolders: [] });
  assert.deepEqual(matchGroups([], [folder("saved", 0)]), { pairs: [], unmatchedGroups: [], unmatchedFolders: ["saved"] });
});

test("tab matching gives each duplicate URL tab the first unused matching bookmark", () => {
  const a = "https://example.com/a", b = "https://example.com/b";
  const tabs = [{ tabId: 9, url: a }, { tabId: 2, url: b }, { tabId: 1, url: a },
    { tabId: 7, url: a }, { tabId: 4, url: "https://example.com/missing" }];
  const bookmarks = [{ id: "b-first", url: b }, { id: "a-first", url: a },
    { id: "a-second", url: a }, { id: "b-unused", url: b }, { id: "saved", url: "https://example.com/saved" }];
  const before = structuredClone({ tabs, bookmarks });
  assert.deepEqual(matchTabs(tabs, bookmarks), {
    pairs: [{ tabId: 9, bookmarkId: "a-first" }, { tabId: 2, bookmarkId: "b-first" }, { tabId: 1, bookmarkId: "a-second" }],
    unmatchedTabs: [7, 4], unmatchedBookmarks: ["b-unused", "saved"],
  });
  assert.deepEqual({ tabs, bookmarks }, before);
});

test("tab URL matching is exact without normalization", () => {
  assert.deepEqual(matchTabs([{ tabId: 1, url: "https://example.com/a" }], [
    { id: "slash", url: "https://example.com/a/" }, { id: "fragment", url: "https://example.com/a#top" },
  ]), { pairs: [], unmatchedTabs: [1], unmatchedBookmarks: ["slash", "fragment"] });
});

test("tab matching handles empty sides", () => {
  assert.deepEqual(matchTabs([], []), { pairs: [], unmatchedTabs: [], unmatchedBookmarks: [] });
  assert.deepEqual(matchTabs([{ tabId: 1, url: "https://example.com/" }], []), {
    pairs: [], unmatchedTabs: [1], unmatchedBookmarks: [],
  });
  assert.deepEqual(matchTabs([], [{ id: "saved", url: "https://example.com/" }]), {
    pairs: [], unmatchedTabs: [], unmatchedBookmarks: ["saved"],
  });
});
