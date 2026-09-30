import { ROOT_TITLE, PINNED_TITLE, decodeFolderTitle, isPinnedFolderTitle } from "./codec.js";

export const OTHER_BOOKMARKS = "unfiled_____";

/** Prefer stored identity, then the oldest direct Foxy folder, then append one. */
export async function findOrCreateRoot(api, knownRootId) {
  if (knownRootId) {
    try {
      const [known] = await api.bookmarks.get(knownRootId);
      if (known?.type === "folder") return known.id;
    } catch (error) {
      console.warn("Foxy: could not read stored bookmark root", knownRootId, error);
    }
  }
  const children = await api.bookmarks.getChildren(OTHER_BOOKMARKS);
  const [root] = children
    .filter(node => node.type === "folder" && node.title === ROOT_TITLE)
    .sort((a, b) => a.dateAdded - b.dateAdded || a.index - b.index);
  if (root) return root.id;
  const created = await api.bookmarks.create({ parentId: OTHER_BOOKMARKS, title: ROOT_TITLE });
  return created.id;
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
  const children = root.children.filter(node => node.type === "folder");
  const pinned = children.find(node => isPinnedFolderTitle(node.title));
  return {
    pinned: pinned ? folderInfo(pinned) : null,
    folders: children.filter(node => node !== pinned).map(folderInfo),
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
