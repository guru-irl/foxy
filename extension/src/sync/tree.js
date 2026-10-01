import { matchTabs } from "./match.js";
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

export const MERGE_ARCHIVE_TITLE = "Foxy merge leftovers";

/** Move leftovers outside Foxy. Keep every GUID, but never manage the archive. */
export async function mergeRoots(api, knownRootId) {
  const rootId = await findOrCreateRoot(api, knownRootId);
  const pinnedId = await ensurePinnedFolder(api, rootId);
  const kept = await readTree(api, rootId), folderRemaps = {}, bookmarkRemaps = {};
  let archiveId;
  async function archive(id) {
    if (!archiveId) {
      const found = (await api.bookmarks.getChildren(OTHER_BOOKMARKS))
        .find(node => node.type === "folder" && node.title === MERGE_ARCHIVE_TITLE);
      archiveId = found?.id ?? (await api.bookmarks.create({ parentId: OTHER_BOOKMARKS, title: MERGE_ARCHIVE_TITLE })).id;
    }
    await api.bookmarks.move(id, { parentId: archiveId });
  }
  function recordBookmarks(bookmarks, folderId) {
    for (const node of bookmarks) bookmarkRemaps[node.id] = { bookmarkId: node.id, folderId };
  }
  recordBookmarks(kept.pinned.bookmarks, pinnedId);
  for (const folder of kept.folders) recordBookmarks(folder.bookmarks, folder.id);
  const extraPins = [...kept.extraPinned];
  for (const extra of await findExtraRoots(api, rootId, knownRootId)) {
    const snapshot = await readTree(api, extra);
    const pins = [snapshot.pinned, ...snapshot.extraPinned].filter(Boolean);
    extraPins.push(...pins);
    const groups = new Map(snapshot.folders.map(folder => [folder.id, folder]));
    for (const child of await api.bookmarks.getChildren(extra)) {
      const folder = groups.get(child.id);
      const same = folder && kept.folders.find(candidate => sameGroup(candidate, folder));
      if (same) {
        folderRemaps[folder.id] = same.id;
        const matches = matchTabs(folder.bookmarks.map(node => ({ tabId: node.id, url: node.url })), same.bookmarks);
        for (const pair of matches.pairs) bookmarkRemaps[pair.tabId] = { bookmarkId: pair.bookmarkId, folderId: same.id };
        await archive(folder.id);
      } else {
        await api.bookmarks.move(child.id, { parentId: rootId });
        if (folder) {
          kept.folders.push(folder);
          recordBookmarks(folder.bookmarks, folder.id);
        }
      }
    }
    if (!(await api.bookmarks.getChildren(extra)).length) await archive(extra);
  }
  for (const extra of extraPins) {
    folderRemaps[extra.id] = pinnedId;
    // Consume counterparts once per occurrence, not once per distinct URL.
    const matches = matchTabs(extra.bookmarks.map(node => ({ tabId: node.id, url: node.url })), kept.pinned.bookmarks);
    for (const pair of matches.pairs) {
      bookmarkRemaps[pair.tabId] = { bookmarkId: pair.bookmarkId, folderId: pinnedId };
      await archive(pair.tabId);
    }
    for (const id of matches.unmatchedTabs) {
      await api.bookmarks.move(id, { parentId: pinnedId });
      const node = extra.bookmarks.find(node => node.id === id);
      kept.pinned.bookmarks.push(node);
      recordBookmarks([node], pinnedId);
    }
    if (!(await api.bookmarks.getChildren(extra.id)).length) await archive(extra.id);
  }
  return { rootId, pinnedId, folderRemaps, bookmarkRemaps };
}

function sameGroup(a, b) {
  if (a.name.trim() !== b.name.trim() || a.color !== b.color || a.bookmarks.length !== b.bookmarks.length) return false;
  return matchTabs(a.bookmarks.map(node => ({ tabId: node.id, url: node.url })), b.bookmarks).unmatchedTabs.length === 0;
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
