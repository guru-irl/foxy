export const ROOT_TITLE = "Foxy";
export const PINNED_TITLE = "📌 Pinned";
export const COLOR_EMOJI = Object.freeze({
  red: "🔴", orange: "🟠", yellow: "🟡", green: "🟢", cyan: "🩵",
  blue: "🔵", purple: "🟣", pink: "🩷", grey: "🩶",
});

/** Encode a Firefox group as an emoji-prefixed bookmark folder title. */
export function encodeFolderTitle({ title = "", color }) {
  const emoji = Object.hasOwn(COLOR_EMOJI, color) ? COLOR_EMOJI[color] : COLOR_EMOJI.grey;
  const name = title.trim();
  return name ? `${emoji} ${name}` : emoji;
}

/** Match known emoji prefixes, including optional presentation selectors. */
export function decodeFolderTitle(text) {
  const trimmed = text.trim();
  for (const [color, emoji] of Object.entries(COLOR_EMOJI)) {
    if (!trimmed.startsWith(emoji)) continue;
    const name = trimmed.slice(emoji.length).replace(/^\uFE0F/, "").trim();
    return { title: name, color };
  }
  return { title: trimmed, color: "grey" };
}

export function isPinnedFolderTitle(text) {
  return text.trim().replace(/^📌\uFE0F/, "📌") === PINNED_TITLE;
}

/** Bookmark creation decides legality for other URLs; don't save our own pages. */
export function isSyncableUrl(url, extensionBaseUrl) {
  return typeof url === "string" && url.length > 0
    && !["about:newtab", "about:home", "about:blank"].includes(url)
    && !(extensionBaseUrl && url.startsWith(extensionBaseUrl));
}

export function isOpenableUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
