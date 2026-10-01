export const STATE_KEY = "foxySync";

/** All durable bookkeeping belongs in local storage, not event-page globals. */
export function emptyState() {
  return {
    rootId: null, pinnedId: null, groups: {}, tabs: {}, openFolders: [], missing: [],
    cantReopen: {}, deferred: [], quietUntil: {}, pendingRemovals: {}, failedCreates: {},
    removedIds: {}, folderSnapshots: {},
  };
}

export async function loadState(api) {
  try {
    const stored = await api.storage.local.get(STATE_KEY);
    const state = stored[STATE_KEY];
    if (!validState(state)) return emptyState();
    if (!entries(state.pendingRemovals, entry => record(entry)
      && string(entry.bookmarkId) && string(entry.folderId) && Number.isFinite(entry.due))) state.pendingRemovals = {};
    if (!entries(state.failedCreates, string)) state.failedCreates = {};
    if (!entries(state.removedIds, Number.isFinite)) state.removedIds = {};
    if (!entries(state.folderSnapshots, entry => record(entry) && string(entry.title)
      && string(entry.color) && strings(entry.urls))) state.folderSnapshots = {};
    return state;
  } catch (error) {
    console.warn("Foxy: could not load sync state", error);
    return emptyState();
  }
}

export const isBookmarkNotFound = error => error?.message === "Bookmark not found";

/** Tree/mutation errors vary by method. Only a get(id) probe proves absence. */
export async function probeMissingBookmark(api, id) {
  if (!id) return false;
  try { return (await api.bookmarks.get(id)).length === 0; }
  catch (error) { return isBookmarkNotFound(error); }
}

export function pruneRemovedIds(state, at = Date.now()) {
  const referenced = new Set([state.rootId, state.pinnedId,
    ...state.openFolders, ...state.missing, ...state.deferred]);
  for (const entry of [...Object.values(state.tabs), ...Object.values(state.pendingRemovals)]) {
    referenced.add(entry.bookmarkId);
    referenced.add(entry.folderId);
  }
  // Group identities also own their pending-order and return/rebind work.
  for (const entry of Object.values(state.groups)) referenced.add(entry.folderId);
  for (const [id, moves] of Object.entries(state.expectedMoves ?? {})) {
    referenced.add(id);
    if (Array.isArray(moves)) for (const move of moves) referenced.add(move?.parentId);
  }
  let changed = false;
  for (const [id, time] of Object.entries(state.removedIds ?? {})) {
    if (at - time > 600000 && !referenced.has(id)) { delete state.removedIds[id]; changed = true; }
  }
  return changed;
}

export function wasRemoved(state, id, at = Date.now()) {
  const time = state.removedIds?.[id];
  // TTL applies only when pruning unreferenced evidence, not during a retry.
  return Number.isFinite(time);
}

/** Called on onRemoved, before queued reconciliation can discard the mappings. */
export function recordRemoved(state, id, info, at = Date.now()) {
  pruneRemovedIds(state, at);
  state.removedIds ??= {};
  const ids = new Set([id]);
  if (info?.node?.type === "folder") {
    if (id === state.rootId) {
      ids.add(state.pinnedId);
      for (const entry of Object.values(state.groups)) ids.add(entry.folderId);
      for (const folder of [...state.openFolders, ...state.missing]) ids.add(folder);
    }
    for (const entry of [...Object.values(state.tabs), ...Object.values(state.pendingRemovals)]) {
      if (id === state.rootId || entry.folderId === id) ids.add(entry.bookmarkId);
    }
    function descendants(node) {
      for (const child of node?.children ?? []) { ids.add(child.id); descendants(child); }
    }
    descendants(info.node);
  }
  for (const removed of ids) if (removed) state.removedIds[removed] = at;
}

/** Write failures propagate to the queue, which logs them and keeps draining. */
export async function saveState(api, state) {
  await api.storage.local.set({ [STATE_KEY]: state });
}

/**
 * Run jobs FIFO, returning each result with a non-rejecting internal tail.
 * Jobs must never await run() or idle() of their own queue: that deadlocks.
 * Call inner work's function directly; enqueue follow-up work without awaiting it.
 */
export function createQueue() {
  let tail = Promise.resolve();
  return {
    run(fn) {
      const result = tail.then(() => fn());
      tail = result.catch(error => { console.error("Foxy: sync task failed", error); });
      return result;
    },
    async idle() {
      let t;
      do { t = tail; await t; } while (t !== tail);
    },
  };
}

export function folderOfGroup(state, groupId) {
  return state.groups[groupId]?.folderId ?? null;
}

export function groupOfFolder(state, folderId) {
  const match = Object.entries(state.groups).find(([, entry]) => entry.folderId === folderId);
  return match ? Number(match[0]) : null;
}

export function tabsInFolder(state, folderId) {
  return Object.entries(state.tabs).filter(([, entry]) => entry.folderId === folderId)
    .map(([tabId, entry]) => [Number(tabId), entry]);
}

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const string = value => typeof value === "string";
const strings = value => Array.isArray(value) && value.every(string);
const nullableId = value => value === null || string(value);
const entries = (value, valid) => record(value) && Object.values(value).every(valid);

function validState(value) {
  return record(value) && nullableId(value.rootId) && nullableId(value.pinnedId)
    && entries(value.groups, entry => record(entry) && string(entry.folderId) && string(entry.title))
    && entries(value.tabs, entry => record(entry) && string(entry.bookmarkId) && string(entry.folderId)
      && string(entry.url) && string(entry.title))
    && strings(value.openFolders) && strings(value.missing) && strings(value.deferred)
    && entries(value.cantReopen, strings) && entries(value.quietUntil, Number.isFinite);
}
