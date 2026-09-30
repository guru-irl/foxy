/**
 * Switch to a tab, then close the new tab page it was picked from.
 * If the switch fails (the tab closed in the meantime) the page stays open.
 * Switch and close failures are logged with console.warn.
 * @param {{tabs: {update: Function, remove: Function}}} api  the WebExtension `browser` object
 * @param {number} targetTabId
 * @param {number} selfTabId  the new tab page's own tab
 * @returns {Promise<boolean>} whether the switch happened
 */
export async function activateTab(api, targetTabId, selfTabId) {
  try {
    await api.tabs.update(targetTabId, { active: true });
  } catch (error) {
    console.warn("Liquid Fox New Tab: could not switch to tab", targetTabId, error);
    return false;
  }
  try {
    await api.tabs.remove(selfTabId);
  } catch (error) {
    // The switch already happened, so a failed close only leaves this page open behind the tab.
    // Log it because it may point to a bug (for example, a wrong own tab ID).
    console.warn("Liquid Fox New Tab: could not close the new tab page", selfTabId, error);
  }
  return true;
}
