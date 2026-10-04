// Weather sends a rounded position (or a searched city) to Open-Meteo and
// BigDataCloud, declared as the optional data collection permission
// `locationInfo`. Nothing location related happens until it is granted.

export const LOCATION_INFO = Object.freeze({ data_collection: ["locationInfo"] });

/** Whether weather may make requests. A missing or failing API means no. */
export async function hasConsent(api) {
  try { return !!api?.permissions?.contains && await api.permissions.contains(LOCATION_INFO) === true; }
  catch (error) { console.warn("Foxy: could not check the location permission", error); return false; }
}

/** Ask for the permission. Call from a click handler, before any await. */
export function requestConsent(api) {
  try { return Promise.resolve(api.permissions.request(LOCATION_INFO)).then(granted => granted === true, () => false); }
  catch (error) { console.warn("Foxy: could not ask for the location permission", error); return Promise.resolve(false); }
}

const concerns = perms => Array.isArray(perms?.data_collection) && perms.data_collection.includes("locationInfo");

/** Call `listener(granted)` when the permission is granted or revoked (for example in about:addons). */
export function watchConsent(api, listener) {
  const added = perms => { if (concerns(perms)) listener(true); };
  const removed = perms => { if (concerns(perms)) listener(false); };
  api?.permissions?.onAdded?.addListener(added);
  api?.permissions?.onRemoved?.addListener(removed);
  return () => {
    api?.permissions?.onAdded?.removeListener(added);
    api?.permissions?.onRemoved?.removeListener(removed);
  };
}
