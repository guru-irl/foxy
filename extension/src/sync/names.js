import { decodePinTitle } from "./codec.js";

/** Firefox match patterns grant a host, not a path or port. */
export function pinOrigin(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? `${parsed.protocol}//${parsed.hostname}/*` : null;
  } catch { return null; }
}

/** Serialized by executeScript: everything this function uses must live here. */
export function keepPinTitle(name) {
  if (name !== null) name = name.trim().replace(/\s+/gu, " ");
  const key = "__foxyPinTitle";
  let keeper = globalThis[key];
  if (keeper) {
    // Consume a page edit even if its observer callback has not run yet.
    if (document.title !== keeper.name) keeper.pageTitle = document.title;
    keeper.observer.disconnect();
  }
  if (name === null) {
    if (keeper) document.title = keeper.pageTitle;
    delete globalThis[key];
    return keeper?.pageTitle;
  }
  if (!keeper) keeper = { pageTitle: document.title };
  if (!globalThis[`${key}Hide`]) {
    globalThis[`${key}Hide`] = true;
    // Back must not revive a name that was removed while this page was cached.
    // One listener per document, acting on whichever keeper is current.
    window.addEventListener("pagehide", event => {
      const current = globalThis[key];
      if (!event.persisted || !current) return;
      current.observer.disconnect();
      if (document.title === current.name) document.title = current.pageTitle;
      delete globalThis[key];
    });
  }
  keeper.name = name;
  const watch = () => {
    keeper.root = document.documentElement;
    keeper.head = document.head;
    keeper.observer.observe(document, { childList: true });
    if (keeper.root) keeper.observer.observe(keeper.root, { childList: true });
    if (keeper.head) keeper.observer.observe(keeper.head, { subtree: true, childList: true, characterData: true });
  };
  const write = () => {
    keeper.observer.disconnect();
    document.title = keeper.name;
    watch();
  };
  keeper.observer ??= new MutationObserver(() => {
    if (keeper.root !== document.documentElement || keeper.head !== document.head) {
      keeper.observer.disconnect();
      watch();
    }
    if (document.title === keeper.name) return;
    keeper.pageTitle = document.title;
    write();
  });
  globalThis[key] = keeper;
  write();
}

/** Called only inside the sync queue. Bookmark titles remain the source of truth. */
export function createNames({ api, getState, save }) {
  const warn = error => console.warn("Foxy: could not apply pin name", error);
  async function nameOf(entry) {
    if (entry.folderId !== getState().pinnedId) return null;
    const [node] = await api.bookmarks.get(entry.bookmarkId);
    return node?.parentId === getState().pinnedId ? decodePinTitle(node.title) : null;
  }
  async function allowed(origin) {
    return origin ? api.permissions.contains({ origins: [origin] }) : false;
  }
  async function apply(tabId, removing = false) {
    try {
      const entry = getState().tabs[tabId];
      if (!entry || (entry.folderId !== getState().pinnedId && !entry.appliedName)) return;
      const tab = await api.tabs.get(Number(tabId));
      if (tab.incognito || tab.discarded || tab.status !== "complete") return;
      const name = tab.pinned && !removing ? await nameOf(entry) : null;
      if (name === null && !entry.appliedName) return;
      if (!await allowed(pinOrigin(tab.url))) return;
      const results = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] },
        world: "ISOLATED", func: keepPinTitle, args: [name] });
      const restored = results?.[0]?.result;
      const pageTitle = name === null && typeof restored === "string" && restored !== entry.appliedName ? restored : undefined;
      const changed = (entry.appliedName ?? null) !== name || (name !== null && entry.shownName !== name);
      if (name === null) delete entry.appliedName;
      else {
        entry.appliedName = name;
        entry.shownName = name;
      }
      if (changed) await save();
      return pageTitle;
    } catch (error) { warn(error); }
  }
  async function applyAll() {
    for (const id of Object.keys(getState().tabs)) await apply(Number(id));
  }
  async function pins() {
    const pins = {};
    for (const [id, entry] of Object.entries(getState().tabs)) {
      if (entry.folderId !== getState().pinnedId) continue;
      try {
        const tab = await api.tabs.get(Number(id));
        if (!tab.pinned || tab.incognito) continue;
        const name = await nameOf(entry);
        if (name === null) continue;
        const origin = pinOrigin(tab.url);
        pins[id] = { name, origin, allowed: origin ? await allowed(origin) : null };
      } catch (error) { warn(error); }
    }
    return { pins };
  }
  return { apply, applyAll, pins };
}
