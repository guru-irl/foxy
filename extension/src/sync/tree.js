import { ROOT_TITLE, PINNED_TITLE, decodeFolderTitle, isPinnedFolderTitle } from "./codec.js";

export const OTHER_BOOKMARKS = "unfiled_____";

/** Prefer the oldest direct Foxy folder, then stored identity, then append one. */
export async function findOrCreateRoot(api, knownRootId) {
  const [root] = await directRoots(api);
  if (root) return root.id;
  if (knownRootId) {
    try {
      const [known] = await api.bookmarks.get(knownRootId);
      if (known?.type === "folder") return known.id;
    } catch (error) {
      console.warn("Foxy: could not read stored bookmark root", knownRootId, error);
    }
  }
  const created = await api.bookmarks.create({ parentId: OTHER_BOOKMARKS, title: ROOT_TITLE });
  return created.id;
}

/** Report the stored orphan first, then duplicate roots, without mutating them. */
export async function findExtraRoots(api, rootId, knownRootId) {
  const extra = new Set();
  if (knownRootId && knownRootId !== rootId) {
    try {
      const [known] = await api.bookmarks.get(knownRootId);
      if (known?.type === "folder") extra.add(known.id);
    } catch (error) {
      console.warn("Foxy: could not read stored bookmark root", knownRootId, error);
    }
  }
  for (const node of await directRoots(api)) {
    if (node.id !== rootId) extra.add(node.id);
  }
  return [...extra];
}

async function directRoots(api) {
  const children = await api.bookmarks.getChildren(OTHER_BOOKMARKS);
  return children
    .filter(node => node.type === "folder" && node.title === ROOT_TITLE)
    .sort((a, b) => a.dateAdded - b.dateAdded || a.index - b.index);
}

/** Merge duplicate contents by moving; retained folders are never deleted. */
export async function mergeRoots(api, knownRootId) {
  const rootId = await findOrCreateRoot(api, knownRootId);
  for (const extra of await findExtraRoots(api, rootId, knownRootId)) {
    for (const child of await api.bookmarks.getChildren(extra)) await api.bookmarks.move(child.id, { parentId: rootId });
  }
  const pinnedId = await ensurePinnedFolder(api, rootId), tree = await readTree(api, rootId);
  const urls = new Set(tree.pinned.bookmarks.map(bookmark => bookmark.url));
  for (const extra of tree.extraPinned) for (const bookmark of extra.bookmarks) {
    if (urls.has(bookmark.url)) continue;
    await api.bookmarks.move(bookmark.id, { parentId: pinnedId });
    urls.add(bookmark.url);
  }
  return { rootId, pinnedId };
}

/** Reserve the first matching child folder for pins; new pins go at index zero. */
export async function ensurePinnedFolder(api, rootId) {
  const children = await api.bookmarks.getChildren(rootId);
  const pinned = children.find(node => node.type === "folder" && isPinnedFolderTitle(node.title));
  if (pinned) return pinned.id;
  const created = await api.bookmarks.create({ parentId: rootId, index: 0, title: PINNED_TITLE });
  return created.id;
}

/** Read a snapshot without creating folders or descending into nested groups. */
export async function readTree(api, rootId) {
  const [root] = await api.bookmarks.getSubTree(rootId);
  const children = root.children.filter(node => node.type === "folder")
    .sort((a, b) => a.index - b.index);
  const [pinned, ...extraPinned] = children.filter(node => isPinnedFolderTitle(node.title));
  return {
    pinned: pinned ? folderInfo(pinned) : null,
    extraPinned: extraPinned.map(folderInfo),
    folders: children.filter(node => !isPinnedFolderTitle(node.title)).map(folderInfo),
  };
}

function folderInfo(folder) {
  const { title: name, color } = decodeFolderTitle(folder.title);
  return {
    id: folder.id, index: folder.index, title: folder.title, color, name,
    bookmarks: folder.children
      .filter(node => node.type === "bookmark")
      .map(({ id, index, url, title }) => ({ id, index, url, title })),
  };
}
