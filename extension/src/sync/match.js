/** Match identities greedily in group order, then shared URLs and folder index. */
export function matchGroups(open, folders) {
  const pairs = [], unmatchedGroups = [], used = new Set();
  for (const group of open) {
    const urls = new Set(group.urls);
    let best = null, bestOverlap = -1;
    for (const folder of folders) {
      if (used.has(folder.id) || group.title.trim() !== folder.name.trim() || group.color !== folder.color) continue;
      const overlap = [...new Set(folder.bookmarks.map(bookmark => bookmark.url))]
        .filter(url => urls.has(url)).length;
      if (overlap > bestOverlap || (overlap === bestOverlap && folder.index < best.index)) {
        best = folder;
        bestOverlap = overlap;
      }
    }
    if (best) {
      pairs.push({ groupId: group.groupId, folderId: best.id });
      used.add(best.id);
    } else {
      unmatchedGroups.push(group.groupId);
    }
  }
  return { pairs, unmatchedGroups, unmatchedFolders: folders.filter(folder => !used.has(folder.id)).map(folder => folder.id) };
}

/** Preserve input order and consume duplicate URL bookmarks one at a time. */
export function matchTabs(tabs, bookmarks) {
  const pairs = [], unmatchedTabs = [], used = new Set();
  for (const tab of tabs) {
    const bookmark = bookmarks.find(candidate => !used.has(candidate.id) && candidate.url === tab.url);
    if (bookmark) {
      pairs.push({ tabId: tab.tabId, bookmarkId: bookmark.id });
      used.add(bookmark.id);
    } else {
      unmatchedTabs.push(tab.tabId);
    }
  }
  return { pairs, unmatchedTabs, unmatchedBookmarks: bookmarks.filter(bookmark => !used.has(bookmark.id)).map(bookmark => bookmark.id) };
}
