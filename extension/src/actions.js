import { CLOSE_MESSAGE } from "./close.js";

/**
 * Switch to a tab, then optionally close the new tab page it was picked from.
 * If the switch fails (the tab closed in the meantime) the page stays open.
 * Switch and close failures are logged with console.warn.
 * @param {{tabs: {update: Function, remove: Function}, runtime: {sendMessage: Function}}} api  the WebExtension `browser` object
 * @param {number} targetTabId
 * @param {number} selfTabId  the new tab page's own tab
 * @param {{close?: boolean}} options  keep the page when it has Back history; defaults to closing
 * @returns {Promise<boolean>} whether the switch happened
 */
export async function activateTab(api, targetTabId, selfTabId, { close = true } = {}) {
  try {
    await api.tabs.update(targetTabId, { active: true });
  } catch (error) {
    console.warn("Foxy: could not switch to tab", targetTabId, error);
    return false;
  }
  if (!close) return true;
  try {
    await api.runtime.sendMessage(CLOSE_MESSAGE);
  } catch (error) {
    console.warn("Foxy: could not ask to close the page, closing it directly", error);
    try {
      await api.tabs.remove(selfTabId);
    } catch (closeError) {
      // The switch already happened, so a failed close only leaves this page open behind the tab.
      console.warn("Foxy: could not close the new tab page", selfTabId, closeError);
    }
  }
  return true;
}
