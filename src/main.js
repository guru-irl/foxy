import { formatDate, formatTime, msUntilNextMinute } from "./model.js";

startClock(document.getElementById("time"), document.getElementById("date"));

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
