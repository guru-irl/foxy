/**
 * Switch to a tab, then close the new tab page it was picked from.
 * If the switch fails (the tab closed in the meantime) the page stays open.
 * @param {{tabs: {update: Function, remove: Function}}} api  the WebExtension `browser` object
 * @param {number} targetTabId
 * @param {number} selfTabId  the new tab page's own tab
 * @returns {Promise<boolean>} whether the switch happened
 */
export async function activateTab(api, targetTabId, selfTabId) {
  try {
    await api.tabs.update(targetTabId, { active: true });
  } catch {
    return false;
  }
  try {
    await api.tabs.remove(selfTabId);
  } catch {
    // Already closed (for example by the user). The switch still happened.
  }
  return true;
}
