import { activateTab } from "./actions.js";
import { buildModel, formatDate, formatTime, msUntilNextMinute } from "./model.js";
import { renderGroups, renderPinned } from "./render.js";

const api = globalThis.browser;

startClock(document.getElementById("time"), document.getElementById("date"));
startTabs(document.getElementById("pinned"), document.getElementById("groups")).catch((error) => {
  console.error("Liquid Fox New Tab: could not show tabs", error);
});

// Updates on each minute boundary, and again whenever the page becomes visible,
// because Firefox throttles timers in background tabs.
function startClock(timeEl, dateEl) {
  let timer = 0;
  const tick = () => {
    const now = new Date();
    timeEl.textContent = formatTime(now);
    dateEl.textContent = formatDate(now);
    clearTimeout(timer);
    timer = setTimeout(tick, msUntilNextMinute(now));
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tick();
  });
  tick();
}

// Shows this window's pinned tabs and tab groups and keeps them current: any
// tab or group change schedules one re-read and redraw per animation frame.
async function startTabs(pinnedEl, groupsEl) {
  const self = await api.tabs.getCurrent();
  let queued = false;

  const pick = async (tabId) => {
    if (!(await activateTab(api, tabId, self.id))) schedule();
  };

  async function refresh() {
    const tabs = await api.tabs.query({ windowId: self.windowId });
    let groups = [];
    try {
      groups = await api.tabGroups.query({ windowId: self.windowId });
    } catch (error) {
      console.error("Liquid Fox New Tab: could not read tab groups", error);
    }
    const model = buildModel(tabs, groups, self.id);
    renderPinned(pinnedEl, model.pinned, pick);
    renderGroups(groupsEl, model.groups, pick);
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      refresh().catch((error) => console.error("Liquid Fox New Tab: refresh failed", error));
    });
  }

  const events = [
    api.tabs.onCreated,
    api.tabs.onRemoved,
    api.tabs.onUpdated,
    api.tabs.onMoved,
    api.tabs.onAttached,
    api.tabs.onDetached,
    api.tabGroups?.onCreated,
    api.tabGroups?.onUpdated,
    api.tabGroups?.onMoved,
    api.tabGroups?.onRemoved,
  ];
  for (const event of events) event?.addListener(schedule);

  await refresh();
}
