import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLOR_EMOJI, encodeFolderTitle, decodeFolderTitle, isPinnedFolderTitle,
  isSyncableUrl, isOpenableUrl,
} from "../extension/src/sync/codec.js";

const colors = [
  ["red", "🔴"], ["orange", "🟠"], ["yellow", "🟡"], ["green", "🟢"],
  ["cyan", "🩵"], ["blue", "🔵"], ["purple", "🟣"], ["pink", "🩷"], ["grey", "🩶"],
];

for (const [color, emoji] of colors) {
  test(`${color} folder titles round trip with the specified emoji`, () => {
    assert.equal(COLOR_EMOJI[color], emoji);
    const encoded = encodeFolderTitle({ title: "Dev Server", color });
    assert.equal(encoded, `${emoji} Dev Server`);
    assert.deepEqual(decodeFolderTitle(encoded), { title: "Dev Server", color });
  });

  test(`${color} unnamed folders and VS16 variants decode without losing characters`, () => {
    assert.equal(encodeFolderTitle({ title: "", color }), emoji);
    assert.deepEqual(decodeFolderTitle(emoji), { title: "", color });
    assert.deepEqual(decodeFolderTitle(` ${emoji}\uFE0F   🦊 Work  `), { title: "🦊 Work", color });
    assert.deepEqual(decodeFolderTitle(`${emoji}\uFE0F`), { title: "", color });
    assert.deepEqual(decodeFolderTitle(`${emoji}Work`), { title: "Work", color });
  });
}

test("encoding trims names and defaults unknown colours to grey", () => {
  assert.equal(encodeFolderTitle({ title: "  Work  ", color: "blue" }), "🔵 Work");
  assert.equal(encodeFolderTitle({ title: "  ", color: "red" }), "🔴");
  for (const color of ["unknown", "gray", "toString", undefined]) {
    assert.equal(encodeFolderTitle({ title: "Work", color }), "🩶 Work");
  }
});

test("decoding preserves unknown prefixes and defaults unmarked folders to grey", () => {
  for (const [text, title] of [["  Work  ", "Work"], [" ⚫ Work ", "⚫ Work"], ["", ""], ["   ", ""]]) {
    assert.deepEqual(decodeFolderTitle(text), { title, color: "grey" });
  }
});

test("only the reserved pinned title is recognized, including VS16 and outer spaces", () => {
  for (const text of ["📌 Pinned", "📌\uFE0F Pinned", "  📌 Pinned  "]) {
    assert.equal(isPinnedFolderTitle(text), true, text);
  }
  for (const text of ["Pinned", "📌", "📌 pinned", "📌 Pinned Work", "🔴 Pinned", ""]) {
    assert.equal(isPinnedFolderTitle(text), false, text);
  }
});

test("outbound URL policy excludes empty, new-tab and this extension's pages only", () => {
  const base = "moz-extension://foxy-test/";
  const cases = [
    ["", false], [undefined, false], [null, false],
    ["about:newtab", false], ["about:home", false], ["about:blank", false],
    [base, false], [`${base}newtab.html`, false], [`${base}nested/page.html?x=1#top`, false],
    ["https://example.com/", true], ["http://example.com/", true],
    ["about:config", true], ["file:///notes.txt", true], ["chrome://browser/content/", true],
    ["data:text/plain,hello", true], ["javascript:void(0)", true],
    ["moz-extension://another/page.html", true], ["moz-extension://foxy-test-other/page.html", true],
    ["https://example.com/?next=moz-extension://foxy-test/", true],
  ];
  for (const [url, expected] of cases) assert.equal(isSyncableUrl(url, base), expected, String(url));
});

test("inbound URL policy allows only valid HTTP(S) URLs", () => {
  const cases = [
    ["https://example.com/a?b=1#c", true], ["http://localhost:8080/", true],
    ["HTTPS://example.com/", true], ["about:blank", false],
    ["about:newtab", false], ["about:home", false], ["about:config", false],
    ["about:blank#fragment", false], ["file:///notes.txt", false], ["chrome://browser/content/", false],
    ["data:text/plain,hello", false], ["javascript:void(0)", false], ["ftp://example.com/", false],
    ["moz-extension://foxy-test/newtab.html", false], ["", false], [undefined, false], [null, false],
    ["not a URL", false], ["/relative", false], ["https://", false],
  ];
  for (const [url, expected] of cases) assert.equal(isOpenableUrl(url), expected, String(url));
});
