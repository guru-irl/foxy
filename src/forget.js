// Firefox leaves its own new tab page out of Recently Closed Tabs, but not an
// add-on's page. These helpers find and forget closed entries that are only
// this page, so Cmd+Shift+T reopens what the user actually closed.

/**
 * Closed tabs that are this page (and still have an open window to forget them
 * from), and closed windows whose tabs are all this page. Firefox would not
 * have saved either for its own new tab page.
 * @param {Array<{tab?: {sessionId: string, windowId?: number | null, url?: string}, window?: {sessionId: string, tabs?: Array<{url?: string}>}}>} sessions
 * @param {string} pageUrl
 * @returns {{tabs: Array<{windowId: number, sessionId: string}>, windows: string[]}}
 */
export function closedPagesToForget(sessions, pageUrl) {
  const tabs = [];
  const windows = [];
  for (const { tab, window } of sessions) {
    if (tab) {
      if (tab.url === pageUrl && Number.isInteger(tab.windowId)) {
        tabs.push({ windowId: tab.windowId, sessionId: tab.sessionId });
      }
    } else if (window?.tabs?.length && window.tabs.every((closed) => closed.url === pageUrl)) {
      windows.push(window.sessionId);
    }
  }
  return { tabs, windows };
}

/**
 * Forgets every closed entry that is only this page. A failed forget (for
 * example an entry already gone) is logged and skipped.
 * @returns {Promise<number>} how many entries it tried to forget
 */
export async function forgetClosedPages(api, pageUrl) {
  const sessions = await api.sessions.getRecentlyClosed();
  const { tabs, windows } = closedPagesToForget(sessions, pageUrl);
  for (const { windowId, sessionId } of tabs) {
    try {
      await api.sessions.forgetClosedTab(windowId, sessionId);
    } catch (error) {
      console.warn("Liquid Fox New Tab: could not forget a closed tab", sessionId, error);
    }
  }
  for (const sessionId of windows) {
    try {
      await api.sessions.forgetClosedWindow(sessionId);
    } catch (error) {
      console.warn("Liquid Fox New Tab: could not forget a closed window", sessionId, error);
    }
  }
  return tabs.length + windows.length;
}

/**
 * A runner for forgetClosedPages that does one pass at a time. Calls made
 * during a pass (our own forget calls fire sessions.onChanged too) add exactly
 * one more pass after it. A failed read is logged; the next call works again.
 * @returns {() => Promise<void>}
 */
export function createForgetter(api, pageUrl) {
  let running = null;
  let again = false;
  return function forget() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          try {
            await forgetClosedPages(api, pageUrl);
          } catch (error) {
            console.warn("Liquid Fox New Tab: could not read recently closed tabs", error);
          }
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}
