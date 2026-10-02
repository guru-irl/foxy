export const DEFAULT_SETTINGS = Object.freeze({
  railCells: 3, showClock: true, showPinned: true, showSaved: true, timeFormat: "24",
  showDate: true, transparency: "medium", otherWindows: true, pinsMoveHere: true,
});
export const DEFAULT_DEVICE = Object.freeze({ cellSize: "M", customCell: 80, density: "normal" });

const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const boolean = value => typeof value === "boolean";
const syncedRules = {
  railCells: value => integer(value, 2, 10000),
  showClock: boolean, showPinned: boolean, showSaved: boolean, showDate: boolean,
  otherWindows: boolean, pinsMoveHere: boolean,
  timeFormat: value => ["24", "12"].includes(value),
  transparency: value => ["low", "medium", "high"].includes(value),
};
const deviceRules = {
  cellSize: value => ["S", "M", "L", "XL", "custom"].includes(value),
  customCell: value => integer(value, 40, 240),
  density: value => ["normal", "compact"].includes(value),
};

async function loadScope(api, area, key, defaults, rules) {
  let stored;
  try { stored = (await api.storage[area].get(key))[key]; }
  catch (error) { console.warn(`Foxy: could not load ${key}`, error); }
  const result = { ...defaults };
  if (stored !== null && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [key, validate] of Object.entries(rules)) {
      if (Object.hasOwn(stored, key) && validate(stored[key])) result[key] = stored[key];
    }
  }
  return result;
}

export async function loadSettings(api) {
  const [synced, device] = await Promise.all([
    loadScope(api, "sync", "settings", DEFAULT_SETTINGS, syncedRules),
    loadScope(api, "local", "deviceSettings", DEFAULT_DEVICE, deviceRules),
  ]);
  return { synced, device };
}

export async function saveSetting(api, scope, key, value) {
  const rules = scope === "synced" ? syncedRules : scope === "device" ? deviceRules : null;
  if (!rules || !Object.hasOwn(rules, key)) throw new TypeError("Unknown setting");
  if (!rules[key](value)) throw new TypeError("Invalid setting value");
  const settings = await loadSettings(api);
  settings[scope][key] = value;
  const area = scope === "synced" ? "sync" : "local", storageKey = scope === "synced" ? "settings" : "deviceSettings";
  try { await api.storage[area].set({ [storageKey]: settings[scope] }); }
  catch (error) { console.warn(`Foxy: could not save ${storageKey}`, error); throw error; }
  return settings;
}

export function cellPx(device) {
  if (device?.cellSize === "custom") {
    return Number.isInteger(device.customCell) ? Math.max(40, Math.min(240, device.customCell)) : 80;
  }
  switch (device?.cellSize) {
    case "S": return 48;
    case "L": return 112;
    case "XL": return 144;
    default: return 80;
  }
}

export function cardAlpha(transparency, scheme) {
  const light = scheme === "light";
  switch (transparency) {
    case "low": return light ? 0.85 : 0.75;
    case "high": return light ? 0.55 : 0.45;
    default: return light ? 0.7 : 0.6;
  }
}
