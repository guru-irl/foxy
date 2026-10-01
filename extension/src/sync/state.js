export const STATE_KEY = "foxySync";

/** All durable bookkeeping belongs in local storage, not event-page globals. */
export function emptyState() {
  return {
    rootId: null, pinnedId: null, groups: {}, tabs: {}, openFolders: [], missing: [],
    cantReopen: {}, deferred: [], quietUntil: {}, pendingRemovals: {}, failedCreates: {},
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
    return state;
  } catch (error) {
    console.warn("Foxy: could not load sync state", error);
    return emptyState();
  }
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
