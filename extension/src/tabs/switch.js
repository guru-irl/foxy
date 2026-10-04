import { blankAndClose } from "../close.js";
import { DEFAULT_SETTINGS } from "../settings/store.js";
import { isOwn } from "./own.js";

const BURST_MS = 1000, CANDIDATE_MS = 10000, STARTUP_MS = 15000;
const withoutFragment = url => typeof url === "string" ? url.split("#", 1)[0] : "";
const webURL = url => typeof url === "string" && /^https?:/.test(url);

/** One controller per background lifetime. Listeners register before storage loads. */
export function createTabSwitch(api, { now = Date.now, settings = DEFAULT_SETTINGS, isFoxyTab = isOwn } = {}) {
  let started = now(), startupVersion = 0, recent = [], enabled = settings.switchToOpenTab !== false, settingsVersion = 0;
  const candidates = new Map();
  let switching = Promise.resolve();
  const readEnabled = value => typeof value?.switchToOpenTab === "boolean"
    ? value.switchToOpenTab : DEFAULT_SETTINGS.switchToOpenTab;
  const settingReady = api.storage.sync.get("settings").then(stored => {
    if (!settingsVersion) enabled = stored.settings === undefined ? enabled : readEnabled(stored.settings);
  }).catch(error => console.warn("Foxy: could not load tab switch setting", error));
  const startReady = api.storage.session.get("foxySwitchStartedAt").then(async stored => {
    if (startupVersion) return;
    if (Number.isFinite(stored.foxySwitchStartedAt)) started = stored.foxySwitchStartedAt;
    else await api.storage.session.set({ foxySwitchStartedAt: started });
  }).catch(error => console.warn("Foxy: could not load tab switch start time", error));
  const ready = Promise.all([settingReady, startReady]);

  function forget(id) {
    const candidate = candidates.get(id);
    if (candidate) { clearTimeout(candidate.expiry); candidates.delete(id); }
  }
  // The browser can close either tab between API calls. Never remove the new
  // tab unless expansion, activation and focus all succeeded.
  function check(id) {
    const candidate = candidates.get(id);
    if (!candidate) return;
    candidate.pending++;
    const run = switching.then(() => switchCandidate(id)).finally(() => {
      candidate.pending--;
      if (candidate.complete && !candidate.pending && candidates.get(id) === candidate) forget(id);
    });
    switching = run.catch(() => {});
    return run;
  }
  async function switchCandidate(id) {
    await ready;
    const candidate = candidates.get(id);
    if (!candidate || candidate.busy || !candidate.url || candidate.created - started < STARTUP_MS || !enabled || isFoxyTab(id)) return;
    candidate.busy = true;
    const url = candidate.url;
    const current = () => candidates.get(id) === candidate && candidate.url === url && enabled && !isFoxyTab(id);
    try {
      const source = await api.tabs.get(id);
      if (withoutFragment(source.url) !== withoutFragment(url) || (await api.windows.get(source.windowId)).type !== "normal") return;
      const matches = (await api.tabs.query({ windowType: "normal" })).filter(tab => tab.id !== id
        && tab.incognito === source.incognito && tab.cookieStoreId === source.cookieStoreId
        && withoutFragment(tab.url) === withoutFragment(url));
      matches.sort((a, b) => Number(b.windowId === source.windowId) - Number(a.windowId === source.windowId)
        || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0) || a.id - b.id);
      const match = matches[0];
      if (!match || !current()) return;
      if (match.groupId !== undefined && match.groupId !== -1) {
        const group = await api.tabGroups.get(match.groupId);
        if (group.collapsed) await api.tabGroups.update(match.groupId, { collapsed: false });
      }
      if (!current()) return;
      await api.tabs.update(match.id, { active: true });
      await api.windows.update(match.windowId, { focused: true });
      const live = await api.tabs.get(id);
      if (!current() || withoutFragment(live.url) !== withoutFragment(url)) return;
      await blankAndClose(api, id);
      forget(id);
    } catch { /* A tab or its window can disappear while switching. */ }
    finally { candidate.busy = false; }
  }
  function urlChanged(id, url) {
    const candidate = candidates.get(id);
    if (!candidate || candidate.complete || now() - candidate.created >= CANDIDATE_MS || !webURL(url) || candidate.url === url) return;
    candidate.url = url;
    void check(id);
  }
  api.runtime.onStartup.addListener(() => {
    startupVersion++; started = now(); recent = [];
    void api.storage.session.set({ foxySwitchStartedAt: started })
      .catch(error => console.warn("Foxy: could not save tab switch start time", error));
    for (const id of candidates.keys()) forget(id);
  });
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && Object.hasOwn(changes, "settings")) {
      settingsVersion++; enabled = readEnabled(changes.settings.newValue);
    }
  });
  api.tabs.onCreated.addListener(tab => {
    const created = now();
    recent = recent.filter(entry => created - entry.created <= BURST_MS);
    recent.push({ id: tab.id, created });
    if (recent.length >= 3) {
      for (const entry of recent) forget(entry.id);
      return;
    }
    if (!tab.active || isFoxyTab(tab.id)) return;
    const candidate = { created, complete: false, busy: false, pending: 0 };
    candidates.set(tab.id, candidate);
    candidate.expiry = setTimeout(() => forget(tab.id), CANDIDATE_MS);
    urlChanged(tab.id, tab.url);
  });
  const onUpdated = (id, changes, tab) => {
    if (Object.hasOwn(changes, "url")) urlChanged(id, changes.url);
    const candidate = candidates.get(id);
    if (candidate && changes.status === "complete" && (changes.url ?? tab?.url) !== "about:blank") {
      candidate.complete = true;
      if (!candidate.pending) forget(id);
    }
  };
  try { api.tabs.onUpdated.addListener(onUpdated, { properties: ["url", "status"] }); }
  catch (error) {
    console.warn("Foxy: filtered switch updates unavailable, listening to all updates", error);
    try { api.tabs.onUpdated.addListener(onUpdated); }
    catch (fallbackError) { console.warn("Foxy: could not listen to switch updates", fallbackError); }
  }
  api.tabs.onRemoved.addListener(forget);
  return { ready };
}
