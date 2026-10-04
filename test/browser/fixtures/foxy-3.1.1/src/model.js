// Pure functions shared by the page and the Node tests: no browser APIs, no DOM.

const COLORS = ["blue", "cyan", "gray", "green", "orange", "pink", "purple", "red", "yellow"];
const WEEKDAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
const MONTHS = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];

/** Map a tabGroups color to the sidebar's dot palette key. */
export function colorKey(color) {
  if (color === "grey") return "gray";
  return COLORS.includes(color) ? color : "gray";
}

/** 24-hour local time, e.g. "09:05". */
export function formatTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** English capitals without the year, e.g. "WEDNESDAY, 30 SEPTEMBER". */
export function formatDate(date) {
  return `${WEEKDAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** Milliseconds until the next minute starts (1 to 60000). */
export function msUntilNextMinute(date) {
  return 60000 - (date.getSeconds() * 1000 + date.getMilliseconds());
}

function pad(n) {
  return String(n).padStart(2, "0");
}
