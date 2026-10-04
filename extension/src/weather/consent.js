// Weather sends a rounded position (or a searched city) to Open-Meteo and
// BigDataCloud, declared as the optional data collection permission
// `locationInfo`. "My location" also needs the optional `geolocation`
// permission. Nothing location related happens until they are granted.

export const LOCATION_INFO = Object.freeze({ data_collection: ["locationInfo"] });
const MY_LOCATION = Object.freeze({ permissions: ["geolocation"], data_collection: ["locationInfo"] });

/** What weather for `want` ("auto" or a place key) needs; without `want`, the city search. */
const needs = want => (want === "auto" ? MY_LOCATION : LOCATION_INFO);

/** Whether weather for `want` may make requests. A missing or failing API means no. */
export async function hasConsent(api, want) {
  try { return !!api?.permissions?.contains && await api.permissions.contains(needs(want)) === true; }
  catch (error) { console.warn("Foxy: could not check the location permission", error); return false; }
}

/** Ask for everything `want` needs in one prompt. Call from a click handler, before any await. */
export function requestConsent(api, want) {
  try { return Promise.resolve(api.permissions.request(needs(want))).then(granted => granted === true, () => false); }
  catch (error) { console.warn("Foxy: could not ask for the location permission", error); return Promise.resolve(false); }
}

function affected(perms, kinds) {
  const which = new Set();
  if (kinds.includes("locationInfo") && Array.isArray(perms?.data_collection) && perms.data_collection.includes("locationInfo")) which.add("locationInfo");
  if (kinds.includes("geolocation") && Array.isArray(perms?.permissions) && perms.permissions.includes("geolocation")) which.add("geolocation");
  return which;
}

/**
 * Call `listener(granted, which)` when one of `kinds` is granted or revoked
 * (for example in about:addons); `which` is the set of kinds that changed.
 */
export function watchConsent(api, listener, kinds = ["locationInfo"]) {
  const added = perms => { const which = affected(perms, kinds); if (which.size) listener(true, which); };
  const removed = perms => { const which = affected(perms, kinds); if (which.size) listener(false, which); };
  api?.permissions?.onAdded?.addListener(added);
  api?.permissions?.onRemoved?.addListener(removed);
  return () => {
    api?.permissions?.onAdded?.removeListener(added);
    api?.permissions?.onRemoved?.removeListener(removed);
  };
}
