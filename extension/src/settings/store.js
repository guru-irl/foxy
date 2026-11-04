import { validPlace } from "../weather/location.js";

export const DEFAULT_SETTINGS = Object.freeze({
  widgetsWidth: 304, railWidth: 304, showClock: true, showPinned: true, showSaved: true, showMemory: true, timeFormat: "24",
  showDate: true, transparency: "medium", otherWindows: true, pinsMoveHere: true, switchToOpenTab: true,
  showWeather: true, tempUnit: "C",
});
export const DEFAULT_DEVICE = Object.freeze({ density: "normal", weatherPlace: "auto" });

const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const boolean = value => typeof value === "boolean";
const syncedRules = {
  widgetsWidth: value => integer(value, 240, 10000),
  railWidth: value => integer(value, 240, 10000),
  showClock: boolean, showPinned: boolean, showSaved: boolean, showMemory: boolean, showDate: boolean,
  otherWindows: boolean, pinsMoveHere: boolean, switchToOpenTab: boolean,
  timeFormat: value => ["24", "12"].includes(value),
  transparency: value => ["low", "medium", "high"].includes(value),
  showWeather: boolean, tempUnit: value => ["C", "F"].includes(value),
};
const deviceRules = {
  density: value => ["normal", "compact"].includes(value),
  weatherPlace: validPlace,
};

async function loadScope(api, area, key, defaults, rules) {
  let stored;
  try { stored = (await api.storage[area].get(key))[key]; }
  catch (error) { console.warn(`Foxy: could not load ${key}`, error); }
  return validScope(stored, defaults, rules);
}

function validScope(stored, defaults, rules) {
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

// Saves run one at a time, so two quick changes in one page both persist.
let saving = Promise.resolve();

export function saveSetting(api, scope, key, value) {
  const run = saving.then(() => writeSetting(api, scope, key, value));
  saving = run.catch(() => {});
  return run;
}

// Merges one key into the stored object as it is (unknown keys from newer
// versions are kept). If the read fails nothing is written, so a passing
// storage error can never sync defaults over every device's settings.
async function writeSetting(api, scope, key, value) {
  const rules = scope === "synced" ? syncedRules : scope === "device" ? deviceRules : null;
  if (!rules || !Object.hasOwn(rules, key)) throw new TypeError("Unknown setting");
  if (!rules[key](value)) throw new TypeError("Invalid setting value");
  const area = scope === "synced" ? "sync" : "local", storageKey = scope === "synced" ? "settings" : "deviceSettings";
  let written;
  try {
    const stored = (await api.storage[area].get(storageKey))[storageKey];
    const base = stored !== null && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
    written = { ...base, [key]: value };
    await api.storage[area].set({ [storageKey]: written });
  } catch (error) {
    console.warn(`Foxy: could not save ${storageKey}`, error);
    throw error;
  }
  // Report what was written; only the other scope is read back.
  if (scope === "synced") {
    return { synced: validScope(written, DEFAULT_SETTINGS, rules),
      device: await loadScope(api, "local", "deviceSettings", DEFAULT_DEVICE, deviceRules) };
  }
  return { synced: await loadScope(api, "sync", "settings", DEFAULT_SETTINGS, syncedRules),
    device: validScope(written, DEFAULT_DEVICE, rules) };
}

export function cardAlpha(transparency, scheme) {
  const light = scheme === "light";
  switch (transparency) {
    case "low": return light ? 0.85 : 0.75;
    case "high": return light ? 0.55 : 0.45;
    default: return light ? 0.7 : 0.6;
  }
}
