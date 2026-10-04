import { migrateLegacy, validTileId, validTileRect } from "./layouts.js";

export const tileKey = (k, id) => `tile:${k}:${id}`;
export function parseTileKey(key) {
  const match = /^tile:([1-9]\d*):(.+)$/.exec(key);
  return match && Number.isSafeInteger(Number(match[1])) && validTileId(match[2])
    ? { k: Number(match[1]), id: match[2] } : null;
}
const metaWidth = key => {
  const match = /^layout:([1-9]\d*)$/.exec(key);
  return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
};
const timestamp = ms => Number.isFinite(ms) && ms >= 0 ? ms : 0;
function timestamps(entries) {
  const times = {};
  for (const key of Object.keys(entries)) {
    const k = metaWidth(key) ?? parseTileKey(key)?.k;
    if (k != null) times[k] = timestamp(entries[`layout:${k}`]?.t);
  }
  return times;
}
async function readTiles(api) {
  try { return await api.storage.sync.get(null); }
  catch (error) { console.warn("Foxy: could not load tile layout", error); return {}; }
}

export async function loadLayouts(api) {
  const entries = await readTiles(api), times = timestamps(entries), layouts = {};
  for (const [k, lastWriteMs] of Object.entries(times)) layouts[k] = { lastWriteMs, tiles: [] };
  for (const [key, rect] of Object.entries(entries)) {
    const parsed = parseTileKey(key);
    if (!parsed || !validTileRect(rect)) continue;
    const { k, id } = parsed, { x, y, w, h } = rect;
    layouts[k].tiles.push({ id, x, y, w, h });
  }
  const legacy = Object.keys(layouts).length ? null : migrateLegacy(entries);
  if (legacy) layouts[legacy.k] = { lastWriteMs: 0, tiles: legacy.tiles };
  return { layouts, legacy };
}

const shownWrites = new WeakMap(), shownTimes = new WeakMap();
/** Serialize local read/merge writes within this page; never emit sync traffic. */
export function markLayoutShown(api, k, now = Date.now()) {
  const area = api.storage.local, cached = shownTimes.get(area) ?? {};
  shownTimes.set(area, cached);
  const recent = () => Object.hasOwn(cached, k) && now - cached[k] < 60000;
  if (recent()) return Promise.resolve();
  const job = (shownWrites.get(area) ?? Promise.resolve()).then(async () => {
    if (recent()) return;
    const { layoutsShown = {} } = await area.get("layoutsShown");
    if (Object.hasOwn(layoutsShown, k) && now - timestamp(layoutsShown[k]) < 60000) {
      cached[k] = timestamp(layoutsShown[k]); return;
    }
    await area.set({ layoutsShown: { ...layoutsShown, [k]: now } });
    cached[k] = now;
  }).catch(error => { console.warn("Foxy: could not record shown layout", error); });
  shownWrites.set(area, job);
  return job;
}

/** Re-read after each successful write, or after a sync merge. */
export async function evictLayouts(api, inUse) {
  try {
    const entries = await api.storage.sync.get(null), times = timestamps(entries);
    if (Object.keys(times).length <= 4) return;
    const { layoutsShown = {} } = await api.storage.local.get("layoutsShown");
    const victims = [];
    while (Object.keys(times).length > 4) {
      const k = Object.keys(times).map(Number).filter(width => width !== inUse)
        .sort((a, b) => Math.max(times[a], timestamp(layoutsShown[a])) - Math.max(times[b], timestamp(layoutsShown[b])) || a - b)[0];
      victims.push(k); delete times[k];
    }
    await api.storage.sync.remove(Object.keys(entries).filter(key =>
      victims.some(k => key === `layout:${k}` || key.startsWith(`tile:${k}:`))));
  } catch (error) { console.warn("Foxy: could not evict tile layouts", error); throw error; }
}

async function writeTiles(api, k, tiles, { now = Date.now(), inUse = k } = {}) {
  await api.storage.sync.set({ ...Object.fromEntries(tiles.map(({ id, x, y, w, h }) =>
    [tileKey(k, id), { x, y, w, h }])), [`layout:${k}`]: { t: now } });
  await evictLayouts(api, inUse);
}
export async function saveTiles(api, k, tiles, options) {
  if (!tiles.length) return;
  try { await writeTiles(api, k, tiles, options); }
  catch (error) { console.warn("Foxy: could not save tile layout", error); throw error; }
}

/** Copy once at a writable publish. Old devices keep their legacy arrangement. */
export async function migrateLayouts(api, options) {
  try {
    const entries = await api.storage.sync.get(null);
    if (Object.keys(timestamps(entries)).length) return;
    const legacy = migrateLegacy(entries);
    if (legacy) await writeTiles(api, legacy.k, legacy.tiles, options);
  } catch (error) { console.warn("Foxy: could not migrate tile layout", error); throw error; }
}

/** The controller captures the source and write gates before queuing this job. */
export async function persistLayouts(api, { inUse, batches, migrate, prune, keep, evict }) {
  await markLayoutShown(api, inUse);
  if (migrate) await migrateLayouts(api, { inUse });
  for (const [k, writes] of batches) await saveTiles(api, k, writes, { inUse });
  if (prune) await pruneTiles(api, keep);
  if (evict) await evictLayouts(api, inUse);
}

const groupId = key => parseTileKey(key)?.id ?? (key.startsWith("tile:group:") ? key.slice(5) : null);
export async function removeGroupTiles(api, folderId) {
  try {
    const entries = await api.storage.sync.get(null);
    const keys = Object.keys(entries).filter(key => groupId(key) === `group:${folderId}`);
    if (keys.length) await api.storage.sync.remove(keys);
  } catch (error) { console.warn("Foxy: could not remove group tile layouts", error); throw error; }
}

/** Load-time safety cap counts all tile keys across layouts. */
export async function pruneTiles(api, keepFolderIds) {
  const entries = await readTiles(api);
  if (Object.keys(entries).filter(key => key.startsWith("tile:")).length <= 400) return [];
  const keys = Object.keys(entries).filter(key => groupId(key)?.startsWith("group:")
    && !keepFolderIds.has(groupId(key).slice(6)));
  if (!keys.length) return [];
  try { await api.storage.sync.remove(keys); }
  catch (error) { console.warn("Foxy: could not prune tile layout", error); throw error; }
  return [...new Set(keys.map(groupId))];
}

export function watchStorage(api, onChange) {
  const listener = (changes, area) => {
    const keys = Object.keys(changes).filter(key => area === "sync"
      ? key.startsWith("tile:") || key.startsWith("layout:") || key === "settings" : area === "local" && key === "deviceSettings");
    if (keys.length) onChange(keys, changes);
  };
  api.storage.onChanged.addListener(listener);
  return () => api.storage.onChanged.removeListener(listener);
}
