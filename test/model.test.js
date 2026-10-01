import { test } from "node:test";
import assert from "node:assert/strict";
import { colorKey, formatDate, formatTime, msUntilNextMinute } from "../extension/src/model.js";

test("colorKey maps grey to gray and unknown colors to gray", () => {
  for (const color of ["blue", "cyan", "green", "orange", "pink", "purple", "red", "yellow"]) {
    assert.equal(colorKey(color), color);
  }
  assert.equal(colorKey("grey"), "gray");
  assert.equal(colorKey("gray"), "gray");
  assert.equal(colorKey("magenta"), "gray");
  assert.equal(colorKey(undefined), "gray");
});

test("formatTime is 24-hour HH:MM with leading zeros", () => {
  assert.equal(formatTime(new Date(2026, 8, 30, 0, 0, 0)), "00:00");
  assert.equal(formatTime(new Date(2026, 8, 30, 9, 5, 59)), "09:05");
  assert.equal(formatTime(new Date(2026, 8, 30, 17, 24)), "17:24");
  assert.equal(formatTime(new Date(2026, 8, 30, 23, 59)), "23:59");
});

test("formatDate is WEEKDAY, D MONTH in English capitals", () => {
  assert.equal(formatDate(new Date(2026, 8, 30)), "WEDNESDAY, 30 SEPTEMBER");
  assert.equal(formatDate(new Date(2027, 0, 3)), "SUNDAY, 3 JANUARY");
});

test("msUntilNextMinute counts to the next :00", () => {
  assert.equal(msUntilNextMinute(new Date(2026, 8, 30, 12, 0, 0, 0)), 60000);
  assert.equal(msUntilNextMinute(new Date(2026, 8, 30, 12, 0, 59, 999)), 1);
  assert.equal(msUntilNextMinute(new Date(2026, 8, 30, 12, 0, 30, 250)), 29750);
});
