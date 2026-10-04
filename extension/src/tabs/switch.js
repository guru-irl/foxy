import { blankAndClose } from "../close.js";
import { DEFAULT_SETTINGS } from "../settings/store.js";
import { isOwn } from "./own.js";
import { isHop as defaultIsHop } from "./hops.js";

const BURST_MS = 1000, SETTLE_MS = 3000, MAX_MS = 120000, STARTUP_MS = 15000;
const withoutFragment = url => typeof url === "string" ? url.split("#", 1)[0] : "";
const webURL = url => typeof url === "string" && /^https?:/.test(url);

/** One controller per background lifetime. Listeners register before storage loads. */
export function createTabSwitch(api, { now = Date.now, settings = DEFAULT_SETTINGS, isFoxyTab = isOwn, isHop = defaultIsHop } = {}) {
  let started = now(), startupVersion = 0, recent = [], enabled = settings.switchToOpenTab !== false, settingsVersion = 0;
  const candidates = new Map(), burstIds = new Set();
  let events = Promise.resolve();
  const readEnabled = value => typeof value?.switchToOpenTab === "boolean"
    ? value.switchToOpenTab : DEFAULT_SETTINGS.switchToOpenTab;
  const expired = candidate => now() >= candidate.created + MAX_MS
    || (candidate.settleAt !== null && now() >= candidate.settleAt);
  async function persist(extra = {}) {
    for (const [id, candidate] of candidates) if (expired(candidate)) candidates.delete(id);
    await api.storage.session.set({ foxySwitchCandidates: Object.fromEntries(candidates), ...extra });
  }
  const settingReady = api.storage.sync.get("settings").then(stored => {
    if (!settingsVersion) enabled = stored.settings === undefined ? enabled : readEnabled(stored.settings);
  }).catch(error => console.warn("Foxy: could not load tab switch setting", error));
  const sessionReady = api.storage.session.get(["foxySwitchStartedAt", "foxySwitchCandidates"]).then(async stored => {
    if (startupVersion) return;
    for (const [id, candidate] of Object.entries(stored.foxySwitchCandidates ?? {})) candidates.set(Number(id), candidate);
    if (Number.isFinite(stored.foxySwitchStartedAt)) started = stored.foxySwitchStartedAt;
    else await api.storage.session.set({ foxySwitchStartedAt: started });
  }).catch(error => console.warn("Foxy: could not load tab switch session", error));
  const ready = Promise.all([settingReady, sessionReady]).then(async () => {
    if (!enabled && candidates.size) { candidates.clear(); await persist(); }
  });
  function enqueue(action) {
    // Do not return this promise from listeners: watches survive idle in session
    // storage rather than holding the background alive with a pending listener.
    events = events.then(() => ready).then(action)
      .catch(error => console.warn("Foxy: could not handle tab switch event", error));
  }
  // The browser can close either tab between API calls. Never remove the new
  // tab unless expansion, activation and focus all succeeded.
  async function switchCandidate(id) {
    const candidate = candidates.get(id);
    if (!candidate || burstIds.has(id) || expired(candidate) || !webURL(candidate.url) || isHop(candidate.url)
      || candidate.created - started < STARTUP_MS || !enabled || isFoxyTab(id)) return;
    const url = candidate.url;
    const current = () => candidates.get(id) === candidate && candidate.url === url && enabled
      && !burstIds.has(id) && !isFoxyTab(id) && !expired(candidate);
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
      candidates.delete(id);
      await persist();
    } catch { /* A tab or its window can disappear while switching. */ }
  }
  api.runtime.onStartup.addListener(() => {
    startupVersion++;
    const time = now();
    enqueue(async () => {
      started = time; recent = []; burstIds.clear(); candidates.clear();
      await persist({ foxySwitchStartedAt: started });
    });
  });
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && Object.hasOwn(changes, "settings")) {
      settingsVersion++;
      enqueue(async () => {
        enabled = readEnabled(changes.settings.newValue);
        if (!enabled) { candidates.clear(); await persist(); }
      });
    }
  });
  api.tabs.onCreated.addListener(tab => {
    const created = now();
    // Record arrivals synchronously so a burst can cancel a check already
    // awaiting an API. Candidate mutations and session writes stay serialized.
    recent = recent.filter(entry => created - entry.created <= BURST_MS);
    recent.push({ id: tab.id, created });
    const burst = recent.length >= 3 ? recent.map(entry => entry.id) : [];
    for (const id of burst) burstIds.add(id);
    enqueue(async () => {
      if (burst.length) {
        for (const id of burst) candidates.delete(id);
        await persist();
        for (const id of burst) burstIds.delete(id);
        return;
      }
      if (!enabled || !tab.active || burstIds.has(tab.id) || isFoxyTab(tab.id) || created - started < STARTUP_MS) return;
      candidates.set(tab.id, { created, url: tab.url ?? "", settleAt: null });
      await persist();
      await switchCandidate(tab.id);
    });
  });
  const onUpdated = (id, changes, tab) => {
    enqueue(async () => {
      const candidate = candidates.get(id);
      if (!candidate) return;
      // Check stored deadlines before applying a new URL. A navigation after
      // settlement or the cap must not revive a watch, even after idle.
      if (expired(candidate)) { candidates.delete(id); await persist(); return; }
      let changed = false, check = false;
      if (Object.hasOwn(changes, "url") && candidate.url !== changes.url) {
        candidate.url = changes.url; candidate.settleAt = null; changed = true;
        check = webURL(candidate.url) && !isHop(candidate.url);
      }
      const url = changes.url ?? tab?.url ?? candidate.url;
      if (changes.status === "complete" && url && url !== "about:blank" && !isHop(url)) {
        candidate.settleAt = now() + SETTLE_MS; changed = true;
      }
      if (changed) await persist();
      if (check) await switchCandidate(id);
    });
  };
  try { api.tabs.onUpdated.addListener(onUpdated, { properties: ["url", "status"] }); }
  catch (error) {
    console.warn("Foxy: filtered switch updates unavailable, listening to all updates", error);
    try { api.tabs.onUpdated.addListener(onUpdated); }
    catch (fallbackError) { console.warn("Foxy: could not listen to switch updates", fallbackError); }
  }
  api.tabs.onRemoved.addListener(id => {
    enqueue(async () => { if (candidates.delete(id)) await persist(); });
  });
  return { ready };
}
