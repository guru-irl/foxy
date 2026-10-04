import { migrateLegacy, validTileId, validTileRect } from "./layouts.js";

export const tileKey = (k, id) => `tile:${k}:${id}`;
export function parseTileKey(key) {
  const match = /^tile:([1-9]\d*):(.+)$/.exec(key);
  return match && Number.isSafeInteger(Number(match[1])) && validTileId(match[2])
    ? { k: Number(match[1]), id: match[2] } : null;
}
function timestamps(entries) {
  const raw = entries.layouts;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([k, ms]) =>
    /^[1-9]\d*$/.test(k) && Number.isSafeInteger(Number(k)) && Number.isFinite(ms) && ms >= 0));
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
    const { k, id } = parsed;
    layouts[k] ??= { lastWriteMs: 0, tiles: [] };
    const { x, y, w, h } = rect;
    layouts[k].tiles.push({ id, x, y, w, h });
  }
  const legacy = migrateLegacy(entries);
  if (legacy) {
    const current = layouts[legacy.k] ?? { lastWriteMs: 0, tiles: [] };
    layouts[legacy.k] = { ...current,
      tiles: [...new Map([...current.tiles, ...legacy.tiles].map(t => [t.id, t])).values()] };
  }
  return { layouts, legacy };
}

async function writeTiles(api, entries, k, tiles, { now = Date.now(), inUse = k } = {}) {
  const times = timestamps(entries);
  // Include tile-only layouts whose metadata has not arrived through sync yet.
  for (const key of Object.keys(entries)) {
    const parsed = parseTileKey(key);
    if (parsed) times[parsed.k] ??= 0;
  }
  if (!Object.hasOwn(times, k) && Object.keys(times).length >= 4) {
    const evicted = Object.keys(times).map(Number).filter(width => width !== inUse)
      .sort((a, b) => times[a] - times[b] || a - b)[0];
    await api.storage.sync.remove(Object.keys(entries).filter(key => key.startsWith(`tile:${evicted}:`)));
    delete times[evicted];
  }
  times[k] = now;
  await api.storage.sync.set({ ...Object.fromEntries(tiles.map(({ id, x, y, w, h }) =>
    [tileKey(k, id), { x, y, w, h }])), layouts: times });
}

export async function saveTiles(api, k, tiles, options) {
  if (!tiles.length) return;
  try { await writeTiles(api, await api.storage.sync.get(null), k, tiles, options); }
  catch (error) { console.warn("Foxy: could not save tile layout", error); throw error; }
}

/** Called only at a writable publish. Failed sets never remove legacy data. */
export async function migrateLayouts(api, options) {
  try {
    const entries = await api.storage.sync.get(null), legacy = migrateLegacy(entries);
    if (!legacy) return;
    await writeTiles(api, entries, legacy.k, legacy.tiles, options);
    await api.storage.sync.remove(legacy.keys);
  } catch (error) { console.warn("Foxy: could not migrate tile layout", error); throw error; }
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
      ? key.startsWith("tile:") || key === "layouts" || key === "settings" : area === "local" && key === "deviceSettings");
    if (keys.length) onChange(keys);
  };
  api.storage.onChanged.addListener(listener);
  return () => api.storage.onChanged.removeListener(listener);
}
