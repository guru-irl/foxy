export const CLOSE_MESSAGE = { type: "blank-and-close" };

/** Replace the sending page's history entry with about:blank before closing it. */
export async function blankAndClose(api, tabId, { timeoutMs = 2000 } = {}) {
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const onUpdated = (id, changeInfo, tab) => {
    if (id === tabId && changeInfo.status === "complete" && tab.url === "about:blank") finish();
  };
  api.tabs.onUpdated.addListener(onUpdated);
  const timer = setTimeout(finish, timeoutMs);
  try {
    try {
      await api.tabs.update(tabId, { url: "about:blank", loadReplace: true });
    } catch (error) {
      console.warn("Liquid Fox New Tab: could not blank the page before closing it", tabId, error);
      finish();
    }
    await completed;
  } finally {
    api.tabs.onUpdated.removeListener(onUpdated);
    clearTimeout(timer);
  }
  try {
    await api.tabs.remove(tabId);
  } catch (error) {
    console.warn("Liquid Fox New Tab: could not close the new tab page", tabId, error);
  }
}

/** Accept a close request only from a tab in this extension; never trust message tab ids. */
export function handleMessage(api, message, sender) {
  if (message?.type !== CLOSE_MESSAGE.type || sender?.id !== api.runtime.id || !Number.isInteger(sender.tab?.id)) {
    return undefined;
  }
  return blankAndClose(api, sender.tab.id);
}
