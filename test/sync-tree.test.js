import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirefox } from "./fakes/firefox.js";
import { OTHER_BOOKMARKS, findOrCreateRoot, ensurePinnedFolder, readTree } from "../extension/src/sync/tree.js";

// Each scenario catches a wrong selection branch, an unintended tree mutation,
// or lost folder/bookmark identity, order or decoded metadata.
test("a known folder wins even after it is renamed and moved", async () => {
  const ff = createFirefox({ bookmarks: [{ title: "Foxy" }, { title: "Foxy" }] });
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

test("a stale known id falls back to the existing root without creating a duplicate", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const ff = createFirefox({ bookmarks: [{ title: "Old" }, { title: "Foxy" }] });
  const b = ff.browser.bookmarks;
  const [stale, root] = await b.getChildren("unfiled_____");
  await b.remove(stale.id);
  assert.equal(await findOrCreateRoot(ff.browser, stale.id), root.id);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /^Foxy:/);
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
  assert.deepEqual(await readTree(ff.browser, root.id), { pinned: null, folders: [] });
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
    folders: [{ id: group.id, index: 1, title: "🔴 Work", name: "Work", color: "red",
      bookmarks: [{ id: bookmark.id, index: 1, url: "https://example.com/", title: "Page" }] }],
  });
});
