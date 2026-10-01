import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import * as tree from "../extension/src/sync/tree.js";
const { OTHER_BOOKMARKS, findOrCreateRoot, ensurePinnedFolder, readTree } = tree;

// Each scenario catches a wrong selection branch, an unintended tree mutation,
// or lost folder/bookmark identity, order or decoded metadata.
test("a renamed and moved known folder is reused when no direct Foxy folder exists", async () => {
  const ff = createFirefox({ bookmarks: [{ title: "Other" }, { title: "Foxy" }] });
  const b = ff.browser.bookmarks;
  const [, known] = await b.getChildren("unfiled_____");
  await b.update(known.id, { title: "Renamed" });
  await b.move(known.id, { parentId: "menu________" });
  const before = await b.getTree();
  assert.equal(await findOrCreateRoot(ff.browser, known.id), known.id);
  assert.deepEqual(await b.getTree(), before);
});

test("without a known id the oldest direct Foxy folder wins over the first by index", async () => {
  const ff = createFirefox({ bookmarks: [{ title: "Foxy" }, { title: "Foxy" }] });
  const b = ff.browser.bookmarks;
  const [oldest, newer] = await b.getChildren("unfiled_____");
  await b.move(newer.id, { index: 0 });
  const before = await b.getTree();
  assert.equal(await findOrCreateRoot(ff.browser), oldest.id);
  assert.deepEqual(await b.getTree(), before);
});

test("equal root dates are resolved by index, not API array order", async () => {
  const ff = createFirefox({ bookmarks: [{ title: "Foxy" }, { title: "Foxy" }] });
  const b = ff.browser.bookmarks;
  const [first] = await b.getChildren("unfiled_____");
  // The fake uses a strictly increasing clock; only the read snapshot needs
  // equal timestamps to represent a possible Firefox Sync result.
  const api = { bookmarks: { ...b, getChildren: async id =>
    (await b.getChildren(id)).map(node => ({ ...node, dateAdded: 100 })).reverse() } };
  assert.equal(await findOrCreateRoot(api), first.id);
});

test("a stale known id falls back to the existing root without creating a duplicate", async () => {
  const ff = createFirefox({ bookmarks: [{ title: "Old" }, { title: "Foxy" }] });
  const b = ff.browser.bookmarks;
  const [stale, root] = await b.getChildren("unfiled_____");
  await b.remove(stale.id);
  assert.equal(await findOrCreateRoot(ff.browser, stale.id), root.id);
  assert.deepEqual((await b.getChildren("unfiled_____")).map(node => node.id), [root.id]);
});

test("a known bookmark is not a root folder", async () => {
  const ff = createFirefox({ bookmarks: [
    { title: "Foxy", url: "https://example.com/" }, { title: "Foxy" },
  ] });
  const [bookmark, root] = await ff.browser.bookmarks.getChildren("unfiled_____");
  assert.equal(await findOrCreateRoot(ff.browser, bookmark.id), root.id);
});

test("root creation appends under Other Bookmarks and ignores nested, other-root and bookmark matches", async (t) => {
  t.mock.method(console, "warn", () => {});
  const ff = createFirefox({ bookmarks: [
    { title: "Foxy", url: "https://example.com/" },
    { title: "Container", children: [{ title: "Foxy" }] },
  ] });
  const b = ff.browser.bookmarks;
  await b.create({ parentId: "toolbar_____", title: "Foxy" });
  const id = await findOrCreateRoot(ff.browser, "missing-guid");
  const [root] = await b.get(id);
  assert.equal(OTHER_BOOKMARKS, "unfiled_____");
  assert.equal(root.parentId, "unfiled_____");
  assert.equal(root.type, "folder");
  assert.equal(root.title, "Foxy");
  assert.equal(root.index, 2);
  assert.equal(await findOrCreateRoot(ff.browser), id);
  assert.equal((await b.getChildren("unfiled_____")).length, 3);
});

test("ensurePinnedFolder creates at index zero once, without mistaking a bookmark for a folder", async () => {
  const ff = createFirefox({ bookmarks: [{ title: "Foxy", children: [
    { title: "📌 Pinned", url: "https://example.com/" }, { title: "🔴 Work" },
  ] }] });
  const b = ff.browser.bookmarks;
  const [root] = await b.getChildren("unfiled_____");
  const id = await ensurePinnedFolder(ff.browser, root.id);
  const [pinned] = await b.get(id);
  assert.equal(pinned.title, "📌 Pinned");
  assert.equal(pinned.type, "folder");
  assert.equal(pinned.parentId, root.id);
  assert.equal(pinned.index, 0);
  const before = await b.getTree();
  assert.equal(await ensurePinnedFolder(ff.browser, root.id), id);
  assert.deepEqual(await b.getTree(), before);
});

test("ensurePinnedFolder finds the first matching child folder including VS16", async () => {
  const ff = createFirefox({ bookmarks: [{ title: "Foxy", children: [
    { title: "🔵 Work" }, { title: "📌\uFE0F Pinned" }, { title: "📌 Pinned" },
  ] }] });
  const b = ff.browser.bookmarks;
  const [root] = await b.getChildren("unfiled_____");
  const [, first] = await b.getChildren(root.id);
  const before = await b.getTree();
  assert.equal(await ensurePinnedFolder(ff.browser, root.id), first.id);
  assert.deepEqual(await b.getTree(), before);
});

test("readTree returns raw titles, decoded group names and colours, and only direct bookmarks in order", async () => {
  const ff = createFirefox({ bookmarks: [{ title: "Foxy", children: [
    { title: "Loose", url: "https://example.com/loose" },
    { title: "📌\uFE0F Pinned", children: [{ title: "Pin", url: "https://example.com/pin" }] },
    { title: " 🩵\uFE0F  Work ", children: [
      { title: "A", url: "https://example.com/a" },
      { title: "Nested", children: [{ title: "Hidden", url: "https://example.com/hidden" }] },
      { title: "B", url: "about:config" },
    ] },
    { title: " Plain " }, { title: "🩷" },
  ] }] });
  const b = ff.browser.bookmarks;
  const [root] = await b.getSubTree((await b.getChildren("unfiled_____"))[0].id);
  const [, pinned, work, plain, unnamed] = root.children;
  const [a, , bookmarkB] = work.children;
  const [pin] = pinned.children;
  const before = await b.getTree();
  assert.deepEqual(await readTree(ff.browser, root.id), {
    extraPinned: [],
    pinned: {
      id: pinned.id, index: 1, title: "📌\uFE0F Pinned", name: "📌\uFE0F Pinned", color: "grey",
      bookmarks: [{ id: pin.id, index: 0, url: "https://example.com/pin", title: "Pin" }],
    },
    folders: [
      { id: work.id, index: 2, title: " 🩵\uFE0F  Work ", name: "Work", color: "cyan", bookmarks: [
        { id: a.id, index: 0, url: "https://example.com/a", title: "A" },
        { id: bookmarkB.id, index: 2, url: "about:config", title: "B" },
      ] },
      { id: plain.id, index: 3, title: " Plain ", name: "Plain", color: "grey", bookmarks: [] },
      { id: unnamed.id, index: 4, title: "🩷", name: "", color: "pink", bookmarks: [] },
    ],
  });
  assert.deepEqual(await b.getTree(), before);
});

test("readTree returns null for missing pins and does not create folders", async () => {
  const ff = createFirefox({ bookmarks: [{ title: "Foxy" }] });
  const b = ff.browser.bookmarks;
  const [root] = await b.getChildren("unfiled_____");
  const before = await b.getTree();
  assert.deepEqual(await readTree(ff.browser, root.id), { pinned: null, extraPinned: [], folders: [] });
  assert.deepEqual(await b.getTree(), before);
});

test("readTree ignores separators at root and group level without renumbering bookmarks", async () => {
  const ff = createFirefox({ bookmarks: [{ title: "Foxy", children: [
    { title: "🔴 Work", children: [{ title: "Page", url: "https://example.com/" }] },
  ] }] });
  const b = ff.browser.bookmarks;
  const [root] = await b.getChildren("unfiled_____");
  const [group] = await b.getChildren(root.id);
  const [bookmark] = await b.getChildren(group.id);
  // The fake cannot seed separators. Add complete separator nodes to read
  // snapshots only, retaining its stateful bookmark data and real methods.
  const withSeparators = (nodes, parentId) => [
    { id: `sep-${parentId}`, parentId, index: 0, title: "", type: "separator", dateAdded: 1 },
    ...nodes.map(node => ({ ...node, index: node.index + 1 })),
  ];
  const api = { bookmarks: {
    ...b,
    getChildren: async id => withSeparators(await b.getChildren(id), id),
    getSubTree: async id => {
      const [tree] = await b.getSubTree(id);
      tree.children = withSeparators(tree.children, id).map(node => node.type === "folder"
        ? { ...node, children: withSeparators(node.children, node.id) } : node);
      return [tree];
    },
  } };
  assert.deepEqual(await readTree(api, root.id), {
    pinned: null,
    extraPinned: [],
    folders: [{ id: group.id, index: 1, title: "🔴 Work", name: "Work", color: "red",
      bookmarks: [{ id: bookmark.id, index: 1, url: "https://example.com/", title: "Page" }] }],
  });
});


test("the oldest direct Foxy root wins even when the known root is younger", async () => {
  const ff = createFirefox({ bookmarks: [{ title: "Foxy" }, { title: "Foxy" }] });
  const b = ff.browser.bookmarks;
  const [oldest, younger] = await b.getChildren("unfiled_____");
  await b.move(younger.id, { index: 0 });
  const before = await b.getTree();
  assert.equal(await findOrCreateRoot(ff.browser, younger.id), oldest.id);
  assert.deepEqual(await b.getTree(), before);
});

test("a direct Foxy root wins over a renamed and moved known folder", async () => {
  const ff = createFirefox({ bookmarks: [{ title: "Foxy" }, { title: "Renamed" }] });
  const b = ff.browser.bookmarks;
  const [root, known] = await b.getChildren("unfiled_____");
  await b.move(known.id, { parentId: "menu________" });
  const before = await b.getTree();
  assert.equal(await findOrCreateRoot(ff.browser, known.id), root.id);
  assert.deepEqual(await b.getTree(), before);
});

test("a stale known id is logged and replaced when there is no direct Foxy root", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const ff = createFirefox();
  const id = await findOrCreateRoot(ff.browser, "missing-guid");
  const [root] = await ff.browser.bookmarks.get(id);
  assert.equal(root.title, "Foxy");
  assert.equal(root.parentId, "unfiled_____");
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /^Foxy:/);
});

test("findExtraRoots returns only other direct Foxy folder ids, oldest first", async () => {
  assert.equal(typeof tree.findExtraRoots, "function");
  const ff = createFirefox({ bookmarks: [
    { title: "Foxy" }, { title: "Foxy" }, { title: "Foxy" },
    { title: "Foxy", url: "https://example.com/" },
    { title: "Container", children: [{ title: "Foxy" }] },
  ] });
  const b = ff.browser.bookmarks;
  const [oldest, selected, newest] = await b.getChildren("unfiled_____");
  await b.move(newest.id, { index: 0 });
  await b.create({ parentId: "menu________", title: "Foxy" });
  const before = await b.getTree();
  assert.deepEqual(await tree.findExtraRoots(ff.browser, selected.id), [oldest.id, newest.id]);
  assert.deepEqual(await b.getTree(), before);
});

test("findExtraRoots breaks equal-date ties by index rather than API order", async () => {
  assert.equal(typeof tree.findExtraRoots, "function");
  const ff = createFirefox({ bookmarks: [{ title: "Foxy" }, { title: "Foxy" }, { title: "Foxy" }] });
  const b = ff.browser.bookmarks;
  const [root, first, second] = await b.getChildren("unfiled_____");
  const api = { bookmarks: { ...b, getChildren: async id =>
    (await b.getChildren(id)).map(node => ({ ...node, dateAdded: 100 })).reverse() } };
  assert.deepEqual(await tree.findExtraRoots(api, root.id), [first.id, second.id]);
});

test("findExtraRoots returns an empty list when no extra direct Foxy folders exist", async () => {
  assert.equal(typeof tree.findExtraRoots, "function");
  const ff = createFirefox({ bookmarks: [{ title: "Foxy" }] });
  const [root] = await ff.browser.bookmarks.getChildren("unfiled_____");
  assert.deepEqual(await tree.findExtraRoots(ff.browser, root.id), []);
  await ff.browser.bookmarks.update(root.id, { title: "Renamed" });
  assert.deepEqual(await tree.findExtraRoots(ff.browser, root.id), []);
});

for (const change of ["rename", "move", "rename-and-move"]) {
  test(`findExtraRoots returns a ${change} known root first without mutating bookmarks`, async () => {
    const ff = createFirefox({ bookmarks: [
      { title: "Foxy" }, { title: "Foxy" }, { title: "Foxy" }, { title: "Foxy" },
    ] });
    const b = ff.browser.bookmarks;
    const [root, first, last, known] = await b.getChildren("unfiled_____");
    if (change.includes("rename")) await b.update(known.id, { title: "Personal tabs" });
    if (change.includes("move")) await b.move(known.id, { parentId: "menu________" });
    await b.move(last.id, { index: 0 });
    const before = await b.getTree();
    assert.deepEqual(await tree.findExtraRoots(ff.browser, root.id, known.id), [known.id, first.id, last.id]);
    assert.deepEqual(await b.getTree(), before);
  });
}

test("findExtraRoots lists a known direct Foxy folder first, only once", async () => {
  const ff = createFirefox({ bookmarks: [{ title: "Foxy" }, { title: "Foxy" }, { title: "Foxy" }] });
  const [root, other, known] = await ff.browser.bookmarks.getChildren("unfiled_____");
  assert.deepEqual(await tree.findExtraRoots(ff.browser, root.id, known.id), [known.id, other.id]);
});

test("findExtraRoots never returns the selected root even when it is known", async () => {
  const ff = createFirefox({ bookmarks: [{ title: "Foxy" }, { title: "Foxy" }] });
  const [root, other] = await ff.browser.bookmarks.getChildren("unfiled_____");
  assert.deepEqual(await tree.findExtraRoots(ff.browser, root.id, root.id), [other.id]);
});

test("findExtraRoots skips known bookmarks and stale ids, logging a failed read", async (t) => {
  const ff = createFirefox({ bookmarks: [{ title: "Foxy" }, { title: "Foxy" },
    { title: "Foxy", url: "https://example.com/" }] });
  const [root, other, bookmark] = await ff.browser.bookmarks.getChildren("unfiled_____");
  assert.deepEqual(await tree.findExtraRoots(ff.browser, root.id, bookmark.id), [other.id]);
  const warn = t.mock.method(console, "warn", () => {});
  assert.deepEqual(await tree.findExtraRoots(ff.browser, root.id, "stale-guid"), [other.id]);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /^Foxy:/);
});

test("readTree keeps later pinned folders out of groups and selects pins by index", async () => {
  const ff = createFirefox({ bookmarks: [{ title: "Foxy", children: [
    { title: "Loose", url: "https://example.com/loose" },
    { title: "📌 Pinned", children: [{ title: "First", url: "https://example.com/first" }] },
    { title: "🔴 Work" },
    { title: "📌\uFE0F Pinned", children: [{ title: "Second", url: "https://example.com/second" }] },
    { title: "📌 Pinned" },
  ] }] });
  const b = ff.browser.bookmarks;
  const [root] = await b.getSubTree((await b.getChildren("unfiled_____"))[0].id);
  const [, pinned, group, extra, emptyExtra] = root.children;
  const [first] = pinned.children;
  const [second] = extra.children;
  // Reverse the read snapshot so selecting array-first would choose the wrong pins.
  const api = { bookmarks: { ...b, getSubTree: async id => {
    const [snapshot] = await b.getSubTree(id);
    snapshot.children.reverse();
    return [snapshot];
  } } };
  const before = await b.getTree();
  assert.deepEqual(await readTree(api, root.id), {
    pinned: { id: pinned.id, index: 1, title: "📌 Pinned", name: "📌 Pinned", color: "grey",
      bookmarks: [{ id: first.id, index: 0, url: "https://example.com/first", title: "First" }] },
    extraPinned: [
      { id: extra.id, index: 3, title: "📌\uFE0F Pinned", name: "📌\uFE0F Pinned", color: "grey",
        bookmarks: [{ id: second.id, index: 0, url: "https://example.com/second", title: "Second" }] },
      { id: emptyExtra.id, index: 4, title: "📌 Pinned", name: "📌 Pinned", color: "grey", bookmarks: [] },
    ],
    folders: [{ id: group.id, index: 2, title: "🔴 Work", name: "Work", color: "red", bookmarks: [] }],
  });
  assert.deepEqual(await b.getTree(), before);
});

// Catches set-based pin deduplication and group deduplication ignoring counts/metadata.
test("merge archive preserves URL multiplicity and only identical decoded groups", async () => {
  const ff = createFirefox({ bookmarks: [
    { id: "kept", title: "Foxy", children: [
      { id: "pins", title: "📌 Pinned", children: [{ id: "p1", url: "https://mail/" }, { id: "p2", url: "https://mail/" }] },
      { id: "dev", title: "🔴 Dev", children: [{ url: "https://one/" }, { url: "https://one/" }, { url: "https://two/" }] }] },
    { id: "extra", title: "Foxy", children: [
      { id: "extra-pins", title: "📌 Pinned", children: [{ id: "e1", url: "https://mail/" }, { id: "e2", url: "https://mail/" }, { id: "e3", url: "https://mail/" }, { id: "new", url: "https://new/" }] },
      { id: "same", title: "  🔴  Dev  ", children: [{ url: "https://two/" }, { url: "https://one/" }, { url: "https://one/" }] },
      { id: "counts", title: "🔴 Dev", children: [{ url: "https://two/" }, { url: "https://two/" }, { url: "https://one/" }] },
      { id: "name", title: "🔴 Other", children: [{ url: "https://one/" }, { url: "https://one/" }, { url: "https://two/" }] },
      { id: "colour", title: "🔵 Dev", children: [{ url: "https://one/" }, { url: "https://one/" }, { url: "https://two/" }] }] },
    { id: "archive", title: "Foxy merge leftovers", children: [{ title: "Foxy" }, { url: "https://manual/" }] },
  ] });
  await tree.mergeRoots(ff.browser, "extra");
  const merged = await readTree(ff.browser, "kept");
  assert.deepEqual(merged.pinned.bookmarks.map(n => n.id), ["p1", "p2", "e3", "new"], "two counterparts consume two surplus occurrences, not every same-URL bookmark");
  assert.deepEqual(merged.extraPinned, []);
  assert.deepEqual(merged.folders.map(n => n.id), ["dev", "counts", "name", "colour"]);
  assert.deepEqual((await ff.browser.bookmarks.getChildren("archive")).filter(n => ["e1", "e2", "same", "extra", "extra-pins"].includes(n.id)).map(n => n.id).sort(),
    ["e1", "e2", "extra", "extra-pins", "same"]);
  assert.equal((await ff.browser.bookmarks.search({ title: "Foxy merge leftovers" })).length, 1, "reuse archive by exact title");
  assert.equal(ff.calls.some(c => /^bookmarks\.remove/.test(c.api)), false);
  const before = await ff.browser.bookmarks.getTree();
  await tree.mergeRoots(ff.browser, "kept");
  assert.deepEqual(await ff.browser.bookmarks.getTree(), before);
});

// Catches reuse of a kept folder and matching siblings moved from any extra root.
for (const keptGroup of [false, true]) test(`merge identical groups across extra roots consumes ${keptGroup ? "one kept" : "no moved"} counterpart`, async () => {
  const dev = id => ({ id, title: "🔴 Dev", children: [{ id: `${id}-bookmark`, url: "https://one/" }] });
  const ff = createFirefox({ bookmarks: [
    { id: "kept", title: "Foxy", children: [{ id: "pins", title: "📌 Pinned" }, ...(keptGroup ? [dev("canonical")] : [])] },
    { id: "extra-a", title: "Foxy", children: [dev("a1"), dev("a2")] },
    { id: "extra-b", title: "Foxy", children: [dev("b1")] },
  ] });
  const merged = await tree.mergeRoots(ff.browser, "extra-a");
  const managed = await readTree(ff.browser, "kept");
  assert.deepEqual(managed.folders.map(folder => folder.id), keptGroup ? ["canonical", "a2", "b1"] : ["a1", "a2", "b1"]);
  assert.deepEqual(merged.folderRemaps, keptGroup ? { a1: "canonical" } : {});
  assert.deepEqual(managed.folders.map(folder => folder.bookmarks.map(node => node.id)),
    keptGroup ? [["canonical-bookmark"], ["a2-bookmark"], ["b1-bookmark"]] : [["a1-bookmark"], ["a2-bookmark"], ["b1-bookmark"]]);
  assert.equal(ff.calls.some(call => /^bookmarks\.remove/.test(call.api)), false);
  const before = await ff.browser.bookmarks.getTree();
  await tree.mergeRoots(ff.browser, "kept");
  assert.deepEqual(await ff.browser.bookmarks.getTree(), before);
});

test("archive is not selected as a root or extra root, even when older", async () => {
  const ff = createFirefox({ bookmarks: [{ id: "archive", title: "Foxy merge leftovers", dateAdded: 1,
    children: [{ title: "Foxy" }] }, { id: "root", title: "Foxy", dateAdded: 2 }, { id: "extra", title: "Foxy", dateAdded: 3 }] });
  assert.equal(await findOrCreateRoot(ff.browser), "root");
  assert.deepEqual(await tree.findExtraRoots(ff.browser, "root"), ["extra"]);
});
