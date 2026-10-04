export const tileKey = id => `tile:${id}`;

function validId(id) {
  return ["clock", "pinned", "saved"].includes(id) || (id.startsWith("group:") && id.length > 6);
}
function validRect(rect) {
  return rect !== null && typeof rect === "object" && !Array.isArray(rect)
    && ["x", "y", "w", "h"].every(key => Number.isInteger(rect[key])
      && rect[key] >= (key === "x" || key === "y" ? 0 : 1) && rect[key] <= 10000);
}
async function readTiles(api) {
  try { return await api.storage.sync.get(null); }
  catch (error) { console.warn("Foxy: could not load tile layout", error); return {}; }
}

export async function loadLayout(api) {
  const entries = await readTiles(api);
  return Object.entries(entries).flatMap(([key, rect]) => {
    const id = key.slice(5);
    return key.startsWith("tile:") && validId(id) && validRect(rect)
      ? [{ id, x: rect.x, y: rect.y, w: rect.w, h: rect.h }] : [];
  });
}

export async function saveTiles(api, tiles) {
  if (!tiles.length) return;
  const entries = Object.fromEntries(tiles.map(({ id, x, y, w, h }) => [tileKey(id), { x, y, w, h }]));
  try { await api.storage.sync.set(entries); }
  catch (error) { console.warn("Foxy: could not save tile layout", error); throw error; }
}

/** Load-time safety cap. Returns tile ids, not storage keys or folder ids. */
export async function pruneTiles(api, keepFolderIds) {
  const entries = await readTiles(api);
  if (Object.keys(entries).filter(key => key.startsWith("tile:")).length <= 400) return [];
  const keys = Object.keys(entries).filter(key => key.startsWith("tile:group:")
    && !keepFolderIds.has(key.slice(11)));
  if (!keys.length) return [];
  try { await api.storage.sync.remove(keys); }
  catch (error) { console.warn("Foxy: could not prune tile layout", error); throw error; }
  return keys.map(key => key.slice(5));
}

export function watchStorage(api, onChange) {
  const listener = (changes, area) => {
    const keys = Object.keys(changes).filter(key => area === "sync"
      ? key.startsWith("tile:") || key === "settings" : area === "local" && key === "deviceSettings");
    if (keys.length) onChange(keys);
  };
  api.storage.onChanged.addListener(listener);
  return () => api.storage.onChanged.removeListener(listener);
}
