# Foxy: design

Date: 2026-10-01. Status: draft for review.
Supersedes the page layout in `2026-09-30-newtab-design.md` (Default New Tab 1.0.1).
Everything in that spec not changed here still holds: the page replaces the new
tab and home pages, is transparent over the theme's glass, clicking a tab
switches to it, and the page closes itself only when it is its tab's only
history entry (blank-then-close, no Recently Closed entry).

## 1. Summary

Foxy turns the new tab page into a kanban board of every tab group in every
window, and keeps tab groups and pinned tabs in a shared bookmarks folder so
they survive a failed session restore and are the same on every device
(Firefox Sync). The repo also ships the browser theme (userChrome.css,
userContent.css, user.js) and the fonts.

## 2. Decisions (from the design conversation)

| Topic | Decision |
|---|---|
| Name | Foxy (was Default New Tab). Same add-on ID, so it updates in place. |
| Repo | Private GitHub repo `guru-irl/foxy`; the local repo moves to `~/src/foxy`. |
| Layout | Kanban columns (not rows). |
| Right-most column | TABS: every tab that is not in a group and not pinned. |
| Pinned icon strip | Removed. PINNED is a column. |
| Windows | Groups, pins and tabs from every normal window are shown. |
| Drop position | Exactly where dropped (insertion line); the real tab order follows. |
| Pins follow you | Clicking a pinned tab from another window moves it here. Dropping on PINNED pins the tab in this window. |
| Groups | "Bring here" moves a whole group into this window. |
| New group | Drop a tab on "+ NEW GROUP"; a name field opens. |
| Editing | Click a group's name to rename it; click its dot to pick a colour. |
| Closing | × on a tab closes it; × on a group column closes the group on this device (it stays saved). |
| Column drag | Group columns can be dragged to reorder groups, and into another window. |
| Durability | Groups and pins live in bookmarks: one shared set for all devices. |
| Remote changes | Live, like Safari: other devices' changes apply to open groups here, except to the tab you are looking at, which waits until you switch away. |
| Fonts | EB Garamond SemiBold for the clock; Google Sans Flex for the date and other text; monospace (Cascadia Mono) for URLs and code-like text. |
| Pinned names (2026-10-02) | The sidebar shows short names for about 30 well-known sites, recognised by title; any pin can be renamed from the board, and the name follows the pin to every device (§14). |

## 3. Repository and packaging

```
foxy/
  extension/          the add-on (manifest, pages, src, background)
  extension/fonts/    GoogleSansFlex.ttf, EBGaramond.ttf, CascadiaMono.ttf,
                      OFL and TRADEMARKS files
                      (shared with the theme through a symlink)
  theme/              userChrome.css, userContent.css, user.js
  scripts/            build.py, sign.py, preview.py, install_theme.py,
                      check_private.py (+ tests)
  test/               node tests for extension/src
  docs/
```

- `build.py` packages `extension/` into the xpi (`dist/foxy-<version>.zip`).
  Nothing from `theme/` goes into the xpi.
- `theme/` becomes the source of truth for the browser theme. It starts as a
  copy of the profile's current `userChrome.css`, `userContent.css` and
  `user.js`. The Liquid Fox base part has no licence notice; the repo stays
  private for that reason.
- `scripts/install_theme.py` finds the default profile (profiles.ini),
  moves the profile's current `chrome/userChrome.css`, `chrome/userContent.css`,
  `chrome/fonts` and `user.js` into `chrome/backup-<timestamp>/`, and replaces
  them with symlinks to the repo's `theme/` files and `extension/fonts/`. Idempotent: a
  second run with the links already in place changes nothing. `--profile PATH`
  overrides the profile. Firefox still needs a restart to load changes.
- Danfo and Bebas Neue are removed from the repo, the xpi and the theme.
- Before every push: `scripts/check_private.py` checks that tracked files and
  commit messages contain no Microsoft internal names or URLs. Its pattern
  list lives outside the repo (`~/.config/foxy/scan-patterns.txt`).
- The signing credentials stay in `~/.config/liquidfox-newtab/amo.env`,
  outside the repo.
- The add-on keeps ID `{4408f971-7930-41ea-9f93-b01231e40861}`, so each
  signed version installs over the last.

## 4. Typography

The clock uses EB Garamond (OFL, variable wght 400 to 800), bundled as
`Foxy Serif`. The date and other text use Google Sans Flex (OFL, axes:
wght 1–1000, wdth 25–151, opsz 6–144, slnt −10–0, GRAD 0–100,
ROND 0–100). Roundness (ROND) is 0 everywhere. Only group titles are slanted.

| Role | Settings |
|---|---|
| Default text (page and Firefox's UI) | wght 400, wdth 100, opsz automatic |
| Clock | EB Garamond wght 600, lining and tabular figures, upright; clamp(96.8px, 12.1vw, 176px), 1.1 times the old size to match digit ink height. Ink starts at the PINNED title ink, with a measured lead-digit side-bearing correction. The colon has its own span, shifted 0.134em up and 0.004em right to centre its ink vertically and in its slot. |
| Date | Google Sans Flex wght 600, wdth 85, capitals, letter-spacing 0.12em, upright, "WEEKDAY, D MONTH"; ink aligned with the PINNED title |
| Group titles (board columns, sidebar group names) | wght 700, wdth 50, slnt −10, capitals, letter-spacing 0 (compressed). The Bebas Neue look. |
| Other column titles (PINNED, SAVED, TABS), sidebar pinned names, the "SEARCH" placeholder | Same as group titles, upright, letter-spacing 0 |
| Subheadings ("OTHER WINDOWS") | wght 600, wdth 90, capitals, small, letter-spacing 0.12em, faint |
| Actions ("+ NEW GROUP", "RESTORE ALL") | wght 700, wdth 80, capitals, upright |
| URLs and code-like text | Cascadia Mono (OFL, bundled), ligatures off |

- In the theme, Google Sans Flex becomes the font of every chrome element
  (`*` with `!important`); the existing monospace rules (address bar URL,
  dropdown URLs) keep winning by specificity. Also monospace: the link status
  line at the bottom of the window. Native macOS context menus are drawn by the
  system and keep the system font. Web pages and Firefox's about: pages are
  not changed.
- The theme loads the fonts from `chrome/fonts/` (a symlink to
  `extension/fonts/`); the page from the xpi's `fonts/`.
- Group title size: chosen so the capitals are exactly as tall as the 12px
  dot (Google Sans Flex capitals are 0.716em at the default optical size; the
  exact size is set from a pixel measurement in the headless preview). The dot
  keeps hanging off the text baseline (vertical-align), so the two share
  whole-pixel edges. The 1px nudge is recomputed for the new font's rounded
  ascent and descent.

## 5. Board layout

```
   21:56                 EB Garamond SemiBold, centred colon
   WEDNESDAY, 30 SEPTEMBER
   ↑ ink aligned with PINNED, not the card edge

   PINNED │ SAVED   DEV SERVER   COVERAGE   (more…)   + NEW GROUP │ TABS
   fixed  │ ← 24px fades only where more content is offscreen → │ fixed
   rows: top/bottom 24px fades only while more rows are hidden
```

- Clock and date on top. Their shared box inset is the board margin (24px)
  plus column padding (8px) plus title padding (10px), expressed with CSS
  layout variables. Optical corrections align their ink to the PINNED title's
  ink at x=43px within 1px at both clock clamp ends.
- PINNED is fixed on the left, TABS fixed on the right. Between them, a
  sideways-scrolling strip: SAVED (only when it has entries), the group
  columns, then "+ NEW GROUP".
- Column width 264px, gap 12px. Columns fill the height of the window below
  the date and scroll on their own. The board has 24px side margins.
  Mask-image fades the strip's content over 24px at the left when scrolled
  away from the start, and at the right when more remains. Row lists have
  equivalent top/bottom fades. Unscrollable content is never masked. Passive
  scroll listeners, ResizeObserver and render/scroll restoration update the
  edge attributes. No shadows or overlays; drop geometry stays unchanged.
  The fade also fades the thin scrollbar thumb at a faded edge.
- Group column order: this window's groups in tab strip order, then each other
  window's groups, windows ordered by most recent use (the latest
  `lastAccessed` of their tabs).
- A group column from another window shows "OTHER WINDOW" under its title and a
  "bring here" button in its header.
- PINNED and TABS list this window's tabs first, then an "OTHER WINDOWS"
  subheading and the other windows' tabs, window by window in the same order.
- Rows: favicon, title (default font), and on hover a × on the right. A tab
  showing the Foxy page itself is never listed.
- Column look: neutral glass cards, alpha 0.6 dark and 0.7 light.
  Group header: dot + group title (§4).
  PINNED, SAVED and TABS headers have no dot. "+ NEW GROUP" is a faint glass
  card with the action label centred.
- Drag feedback: the dragged row or column is faded; a 2px bright line shows
  the insertion point; the column under the pointer gets a lighter fill.
  PINNED and "+ NEW GROUP" light up the same way. No borders, outlines or
  shadows.
- Collapsed groups are shown like any other.

## 6. Board interactions

| Action | Result |
|---|---|
| Click a tab in this window | Switch to it; the page closes if it is its tab's only history entry. |
| Click a tab in another window | Switch to it and focus that window; same closing rule. |
| Click a pinned tab in another window | Move it into this window (pinned, at the end of this window's pins) and switch to it; same closing rule. |
| Drop a tab on a group column | Joins that group at the insertion point; moves to the group's window if needed. |
| Drop a tab on TABS | Leaves its group or is unpinned, and lands at the insertion point in the window of the row it was dropped next to (this window when the column is empty). |
| Drop a tab on PINNED | Moves into this window and is pinned at the insertion point; dropped among other windows' pins, it goes to the end of this window's pins. |
| Drop a tab on "+ NEW GROUP" | New group in this window with that tab; its name field opens. Enter or clicking elsewhere saves; Escape leaves it unnamed. Firefox picks the colour. |
| Click a group's name | Rename in place: Enter or clicking elsewhere saves, Escape cancels. |
| Click a group's dot | A row of the 9 colour dots appears under it; click one to apply. Escape or clicking elsewhere closes it. |
| Click "bring here" | The whole group moves into this window, after its last tab. |
| Drag a group column by its header | Reorders groups; dropped among another window's columns, the group moves to that window at that position. PINNED, SAVED, TABS and "+ NEW GROUP" don't move and aren't drop targets for columns. |
| × on a tab row | Closes the tab (a normal Recently Closed entry). |
| × on a group header | Closes all its tabs on this device. The group stays saved and appears in SAVED. |
| Click a SAVED entry | Opens that group in this window: tabs created unloaded, grouped, named and coloured. |
| × on a SAVED entry | Turns into "DELETE?"; a deliberate single click after 400ms deletes the group everywhere (removes its bookmarks folder). Double-clicks are ignored. Moving away cancels. |

- Dragging and editing never close the page; only clicking a tab can.
- After every move the page re-reads the real state. If a tab ended up in the
  wrong group (Firefox decides membership from the neighbouring tab), the move
  is corrected with an explicit `tabs.group` or `tabs.ungroup`.
- Live updates: the board listens to tab, group, window and bookmark events
  from all windows and redraws (keeping focus and scroll positions).

## 7. Cross-window mechanics (Firefox 157, checked in its source)

- `tabs.group({tabIds, groupId})` finds the group in any window
  (`getTabGroupById`) and adopts tabs from other windows (`addTabs` →
  `adoptTab`), keeping the page.
- `tabs.move(ids, {windowId, index})` adopts across windows; pinned tabs can
  only land within the pinned range and unpinned tabs after it.
- Moving a tab next to a grouped tab can make it join that group (DOM
  neighbour), hence the correction step in §6.
- `tabGroups.move(groupId, {windowId, index})` adopts a whole group into
  another window.
- Pinning: `tabs.update(id, {pinned: true})`, then `tabs.move` within the
  pinned range for position.
- New group: `tabs.group({tabIds, createProperties: {windowId}})`, then
  `tabGroups.update(id, {title})`.
- Private windows are not visible to the add-on and are not shown.

## 8. Shared groups and pins in bookmarks

### 8.1 Folder layout

```
Other Bookmarks
└── Foxy
    ├── 📌 Pinned
    ├── 🔴 Dev Server
    └── 🔵 Coverage
```

- One `Foxy` folder, shared by all devices through Firefox Sync (bookmarks
  sync must be on for cross-device use; without Sync it still gives local
  durability).
- A group is a folder named `<colour emoji> <name>`: red 🔴, orange 🟠,
  yellow 🟡, green 🟢, cyan 🩵, blue 🔵, purple 🟣, pink 🩷, gray 🩶. A
  folder without a known emoji is treated as gray; an unnamed group is the
  emoji alone.
- Each tab is a bookmark (URL and title), in tab order.
- `📌 Pinned` holds the pinned tabs. Pins are shared by all devices and are
  always open on every device.
- Editing in the Bookmarks UI works too: a folder added under Foxy is a new
  saved group, a bookmark dragged into a group folder is a new tab in that
  group, renaming a folder renames the group.

### 8.2 Identity

- The background keeps, in `storage.local`: the Foxy folder GUID; a map of
  open group ↔ folder GUID; a map of tab ↔ bookmark GUID; the set of folders
  open on this device; pending deferred changes (§8.5).
- Firefox's group and tab IDs change across restarts, so after startup the maps
  are rebuilt: open groups are matched to folders by name and colour, ties
  broken by the most shared URLs, then this device's previously open folders,
  then folder order; tabs are matched to bookmarks by URL within
  their folder, in order. Unmatched open groups get new folders. Unmatched
  folders are "saved, not open" here.
- Finding the Foxy folder: the oldest folder named `Foxy` directly under
  Other Bookmarks, so devices that each created one before Sync merged
  converge on the same folder; otherwise the stored GUID (renamed or moved);
  otherwise it is created. The contents of any other Foxy folder (and of the
  stored one, if it's no longer the chosen root) are moved into it; nothing
  is deleted.

Firefox Sync can dedupe never-uploaded local bookmarks and folders by silently
changing their GUIDs, without a WebExtension event. Disappearance without
`bookmarks.onRemoved` is lost identity, never deletion: missing mapped bookmarks
are rekeyed by URL to unused children, keeping their tabs; an unmatched mapping
is forgotten with its tab untouched. Missing stored folder GUIDs or outbound
GUID failures request one debounced, queued rebuild using the startup matcher,
retaining this device's open/missing intent and live deferred bookkeeping.
Explicit removals (including known descendants) are recorded for ten minutes
before reconciliation. Folder-removal cleanup requires removal or move-out
of Foxy evidence; confirmed bookmark moves retain their transfer semantics.

Merge leftovers go into `Foxy merge leftovers`, an unmanaged folder directly
under Other Bookmarks, created on first need and found by exact title. Surplus
pin occurrences, duplicate groups with the same trimmed name, colour and URL
multiset, and emptied extra root/pinned folders are moved there, never deleted.
Live tabs are remapped to their canonical bookmarks. Foxy never reads, opens,
shows as SAVED, matches or promotes anything in the archive.
Renaming another folder in Other Bookmarks to exactly `Foxy` merges it at the next browser startup, not live.

### 8.3 Tabs to bookmarks (outbound)

Every write is a single change against the mapped bookmark, never a rewrite
of a folder, so changes made on two devices both survive Sync's merge.

| Local change | Bookmark change |
|---|---|
| Tab joins a group (created, moved in, adopted) | Create a bookmark at the matching position; map it. |
| Tab moves within its group | Move its bookmark. |
| Tab leaves its group for another group | Move its bookmark into the other folder. |
| Tab leaves its group (ungrouped) or is closed | Remove its bookmark, after a 2s delay; skipped if by then the group itself is gone (a whole-group close keeps the folder intact). |
| Tab finishes loading a new URL or title | Update the bookmark. |
| Group renamed or recoloured | Rename the folder. |
| New group | Create a folder and its bookmarks. |
| Group closed or deleted in Firefox, or its window closed | No bookmark change; the folder becomes "saved, not open". |
| Tab pinned / unpinned | Add to / remove from `📌 Pinned`. |

- Removals during window close or quit (`isWindowClosing`) are never written.
- Not saved: tabs showing the Foxy page, `about:newtab`, `about:home`,
  `about:blank`; anything `bookmarks.create` rejects (logged).
- Writes are idempotent: if the bookmark already matches, nothing is written.
  That also absorbs the events caused by applying inbound changes.

### 8.4 Bookmarks to tabs (inbound)

Triggered by bookmark events inside the Foxy folder (local edits and Sync),
window focus changes, the board opening, and startup (§8.6).

| Bookmark change | Local result |
|---|---|
| Bookmark added to a folder whose group is open here | Open it as an unloaded tab in that group at that position. |
| Bookmark removed | Close the mapped tab. |
| Bookmark moved within or between open groups' folders | Move the mapped tab. |
| Bookmark URL changed | Load the new URL in the mapped tab. |
| Folder renamed | Rename or recolour the open group. |
| New folder | Appears in SAVED (not opened automatically). |
| Folder deleted while its group is open here | The group is ungrouped: its tabs stay open. |
| Pin added / removed | Open pinned (unloaded) in the most recently used window / close it. |

- URLs Firefox won't open from an add-on (about:, file:, chrome:, data:,
  javascript:) are skipped and shown as "can't reopen" in the SAVED entry.
- After a URL is applied from a bookmark, that tab's own URL changes for the
  next 10s are not written back (stops redirect ping-pong between devices).

### 8.5 Safety rule

A change that would close, move or navigate the tab currently shown in the
focused window is deferred until that tab is no longer shown, then applied
if still valid. Deferred changes are stored, so they survive the background
page going to sleep.

### 8.6 Startup and restore

- On browser startup the background waits for session restore to settle
  (no tab events for 3s, at most 20s) before rebuilding the maps.
- Pins: any pin in `📌 Pinned` that is not open is reopened (pinned,
  unloaded) in the most recently used window; local pins missing from the
  folder are added. So pins come back even if session restore fails.
- Groups: if folders recorded as open on this device are not open after
  startup, the board shows a banner: "N GROUPS DIDN'T COME BACK · RESTORE ALL ·
  DISMISS". They are also in SAVED individually. Restoring opens them as in
  §6. Groups whose window was closed on purpose also show up here; Dismiss
  clears the banner.
- First run on a device: create or find the Foxy folder, match (§8.2), write
  unmatched local groups and pins, open shared pins.

### 8.7 Limits

- Sync delivers changes on its own schedule (seconds to minutes).
- Only a tab's URL and title are kept, not its back/forward history; restored
  and remote tabs start fresh (logins survive through cookies).
- Tabs that are neither grouped nor pinned are not saved.
- Firefox's own "saved groups" feature is separate and unaffected.
- A group's `pendingOrder` holds outbound changes until a safe activation
  retries the order. A local navigation held across a browser restart is lost:
  rebuilding the session maps resets that hold and its last-synced history.

## 9. Architecture

- `extension/manifest.json`: MV3, name "Foxy", permissions `tabs`,
  `tabGroups`, `bookmarks`, `storage`, `scripting` (2.2.0); optional host
  access `*://*/*`, requested per site for pin names (§14.2). Background
  event page (module).
  New tab and home page overrides as before. Adding `bookmarks` shows a
  permission prompt once on update.
- Page (`newtab.html`, `src/page/*`):
  - `model.js`: pure; builds the board (columns, rows, sections) from
    windows, tabs, groups, saved folders, the current window and the page's
    own tab.
  - `render.js`: DOM for clock, columns, rows, banner, editors.
  - `dnd.js`: pure; turns a drag source and a drop point into a target
    (column, window, insertion index).
  - `moves.js`: pure planner from (model, source, target) to a list of API
    calls, plus an executor that runs them and applies the correction step.
  - `edit.js`: rename, colour picker, new group naming.
  - Moves, pins, group edits and closes are done by the page directly; the
    background sees them as events. Opening a SAVED group, deleting one, and
    Restore all are sent to the background as messages, so its maps stay
    right.
- Background (`background.js`, `src/sync/*`):
  - `codec.js`: folder title ↔ {colour, name}; pinned folder marker.
  - `tree.js`: reads the Foxy folder into {groups, pins} with GUIDs.
  - `maps.js`: identity maps in storage.local; rebuild after startup.
  - `outbound.js`: tab/group events → bookmark changes (§8.3).
  - `inbound.js`: bookmark changes → tab changes (§8.4), with the safety
    rule (§8.5).
  - `startup.js`: settle, rebuild, pins, banner state (§8.6).
  - `close.js`: the existing blank-then-close handler.
- All API access goes through an injected `api` object, as today, so every
  module is testable with a fake browser.

## 10. Errors

- Every API call is wrapped; failures are logged with a "Foxy:" prefix and
  the page or background re-reads the real state.
- A move that fails half way leaves Firefox in a valid state (each call is a
  single valid step); the board shows whatever is true.
- Sync conflicts resolve through Firefox Sync's bookmark merge; the next
  inbound pass applies the result.

## 11. Testing

- Node tests with a fake browser (windows, tabs, groups, bookmarks, events),
  extended from the current fakes. Pure modules get table tests: board model,
  drop targets, move plans for every row of §6, folder codec, map rebuilding.
- Sync tests: two fake devices sharing one bookmark tree through a fake Sync
  that merges and replays events; checks for convergence, no echo loops,
  whole-group close keeping the folder, window close and quit writing
  nothing, the safety rule, startup restore of pins and the banner.
- DOM tests in real (headless) Firefox: `scripts/browser_test.py` serves the
  repo on localhost, opens test pages that run the board against the fake
  browser (drag and drop with real DragEvents, editors, live updates), and
  collects the results over HTTP. No npm packages needed.
- Headless preview scenarios for layout (1, 3 and 8 groups; two windows;
  saved entries; banner; narrow window), used for pixel checks of the font
  metrics and dot alignment. Not shown to the user.
- Manual checks in Firefox (by the user): drag between windows, pins moving
  here, column drag, bookmarks appearing, a second device via Sync, and a
  restart with session restore off.

## 12. Delivery

1. Foxy base: rename, repo layout, private GitHub repo, theme in the repo
   with the install script, Google Sans Flex and Cascadia Mono everywhere.
   Signed and installed (1.1.0).
2. The board: layout, drag and drop, cross-window moves, pins, new group,
   rename, colour, close, column drag. Signed and installed (2.0.0).
3. Shared groups and pins in bookmarks, SAVED column, restore banner.
   Signed and installed (2.1.0).
4. Pinned names (§14): the theme's site list, and renaming pins from the
   board. Foxy 2.2.0.

## 13. Not included

Moving tabs with the keyboard; private windows; saving ungrouped tabs;
changing web pages' or about: pages' fonts; Firefox's own saved groups.
Page content is never changed, except the title of a renamed pin (§14.2).

## 14. Pinned names (2026-10-02)

Firefox 157 has no way to rename a tab. In the sidebar a tab's text is its
page title (the tab's `label` attribute). userChrome.css sees only that
label: tab icons are `data:` URIs (`Tabbrowser.setIcon` rejects remote
URLs), so the address is not visible to it. Extensions cannot set a tab's
label either; only the page's `document.title` changes it.

### 14.1 Built-in site names (theme)

- Pinned tabs in the vertical sidebar whose label matches a known site show
  the site's short name instead of the title, exactly as YOUTUBE and GMAIL do
  today (label shrunk to nothing, name drawn by `::before`, same font,
  colour and nudge). Unmatched pins keep showing their title.
- Only patterns that the site reliably puts in its titles. Checked against
  the user's history on 2026-10-02 where available (marked ✓); the others
  follow the sites' published title formats and are unverified.

| Name | Label patterns |
|---|---|
| YOUTUBE ✓ | ends `YouTube` |
| GMAIL ✓ | ends `Gmail` |
| DISCORD ✓ | starts `Discord`, ends `Discord`, contains `Discord \|` (unread counts come first: `(495) Discord \| #rspack \| TanStack`) |
| AZURE ✓ | ends `Microsoft Azure` |
| DEVOPS ✓ | ends `Azure DevOps`, ` - Repos`, ` - Pipelines`, ` - Boards`, ` - Test Plans`, ` - Artifacts` (Azure DevOps titles end with the hub, not the product) |
| COPILOT | contains `Microsoft 365 Copilot` or `M365 Copilot` (the M365 one, not consumer Copilot) |
| GITHUB ✓ | ends `GitHub` (only some GitHub pages; most end with `· owner/repo`) |
| SLACK | ends `Slack` |
| TEAMS | ends `Microsoft Teams` |
| OUTLOOK | ends `Outlook` |
| CALENDAR | contains `Google Calendar` |
| DRIVE | ends `Google Drive` |
| DOCS | ends `Google Docs` |
| SHEETS | ends `Google Sheets` |
| SLIDES | ends `Google Slides` |
| MEET | starts `Meet -` or contains `Google Meet` |
| WHATSAPP | ends `WhatsApp` |
| TELEGRAM | contains `Telegram` (an unread count may come first) |
| X | ends `/ X` |
| REDDIT | ends `Reddit` or contains ` : r/` |
| LINKEDIN | ends `LinkedIn` |
| CHATGPT | is `ChatGPT` |
| CLAUDE | ends `Claude` |
| FIGMA | ends `Figma` |
| JIRA | ends `Jira` |
| CONFLUENCE | ends `Confluence` |
| NOTION | ends `Notion` |
| SPOTIFY | starts `Spotify` |
| NETFLIX | ends `Netflix` |
| TWITCH | ends `Twitch` |
| INSTAGRAM | ends `Instagram` |
| FACEBOOK | ends `Facebook` |
| AMAZON | starts `Amazon` |

- Matching is case-sensitive on the label (CSS attribute selectors). A label
  that matches an *ends* or *is* pattern uses that entry over any *starts* or
  *contains* match, because a site's own title suffix is the most reliable
  signal: "Amazon layoffs explained - YouTube" is YOUTUBE and "Invite via
  Google Meet - me@example.com - Gmail" is GMAIL. Among *starts*/*contains*
  matches, and among *ends*/*is* matches, the later table entry wins (DEVOPS
  after AZURE; DRIVE, DOCS, SHEETS and SLIDES after GMAIL). Changed after review on 2026-10-02; the first
  draft used table order alone, which let broad starts/contains patterns
  override YOUTUBE and GMAIL.
- A renamed pin (§14.2) has its name as its label, so it is shown as named;
  it matches a list entry only if the name itself does.

### 14.2 Renaming a pin (Foxy 2.2.0)

**Where the name lives.** In the pin's bookmark in `📌 Pinned`, so it
syncs to every device and survives restarts and failed restores. A named
pin's bookmark title is `✏️ <name>`; any other title is an unnamed pin
(its title follows the page as today). Decoding accepts `✏` with or without
U+FE0F, trims, collapses whitespace runs to one space, and treats an empty
name as unnamed. Board renames reject names over 200 characters after this
normalisation; the editor input is limited to 200 characters. Renaming the bookmark in
the Bookmarks UI to or from that form names or unnames the pin too.
Outbound prefixes U+200B (zero width space) to page titles in groups and pins
whose trimmed form starts with `✏`, so only an explicit rename or a Bookmarks
UI edit names a pin.

**How it shows.** The tab's page title is set to the name and kept there by a
script Foxy injects into that tab (`scripting.executeScript`, top frame,
isolated world). The script:
- remembers the page's own latest title, sets `document.title` to the name,
  and watches the document for title changes (`<title>` added, replaced or
  edited), putting the name back each time, before Firefox reads the title
  for the tab label where possible;
- is idempotent: injecting it again updates the name and keeps one watcher;
- given no name, stops watching and restores the page's latest own title;
- before entering the back/forward cache, stops watching, restores the page's
  latest own title and forgets its name; a still-named pin gets a fresh keeper
  when the restored tab finishes loading.

The background applies a pin's name (or its removal) when: the pin is
renamed from the board; its bookmark title changes (another device, or the
Bookmarks UI); its tab is re-pinned before delayed bookmark removal; its
tab finishes loading (`status: complete`); the session is rebuilt at startup;
host permission is granted (`permissions.onAdded`).
It skips tabs that are discarded or still loading (they get it on
`complete`), and tabs on origins without permission. Injection failures
(restricted pages such as addons.mozilla.org, about: pages, closed tabs) are
logged with the "Foxy:" prefix and never retried in a loop.

**Sync rules.**
- Outbound never writes the title of a named pin's bookmark; URL changes
  still update its URL. Unnamed pins otherwise follow §8.3.
- Removing a pin's name writes the restored page title, else the last known
  page title, else the URL, never the bare name. Each device remembers the
  name it last displayed, so later events and moves leave the unnamed title
  alone while that name is still shown. A top-level document commit
  (`status: loading` together with a URL, including same-URL reloads in Firefox
  157) clears this guard, unlike a same-document URL change after the page has
  loaded or an unfinished load, so even a real page title equal to the old name
  can replace the fallback.
  Rebuilds recover a still-unloaded pin's raw tab title as its guard when its
  normalised label matches the name, or retain its previous shown name by
  bookmark and URL if it was unnamed while this device was closed.
- Inbound pins opened from a named bookmark use the name, not the raw
  bookmark title, as the unloaded tab's title.
- Unpinning a tab removes its bookmark as today, so the name goes with it.
- Two devices renaming the same pin: Firefox Sync's bookmark merge decides.

**Permission.** `scripting` is a required permission; host access is
optional (`optional_host_permissions: ["*://*/*"]`) and requested per site
(`<scheme>://<host>/*`, http and https only) when a pin is renamed there.
Firefox only allows the request from a user action, so the board calls
`permissions.request` synchronously in the Enter or click handler, then
sends the rename regardless of the answer. The name is saved either way.
Permissions are per device: on a device without access to a named pin's
current site, the board shows ALLOW on that pin's row; clicking it requests
access, and the name then applies through `permissions.onAdded`.

**Board.**
- Every PINNED row (this window and other windows) has a rename button: a
  pencil drawn in CSS from an inline SVG mask, beside ×, shown on hover and
  focus like ×. F2 on a focused pinned row also starts the rename.
- The editor replaces the row's label in place, with the same behaviour as
  the group name editor (Enter saves, Escape cancels, blur saves; the row is
  not draggable while editing). It starts with the pin's name, or its title
  when unnamed, selected. Saving unchanged text cancels without requesting
  access or renaming. Saving an empty name removes the name.
- A named pin's row shows its name even where the title is not applied yet
  (no permission, unloaded tab).
- The page asks the background for pin names with `foxy:pins` →
  `{ pins: { [tabId]: { name, origin, allowed } } }` (named pins only) and
  renames with `foxy:rename-pin { tabId, name }` → `{ ok }`, where `name` is
  a string or null.

**Trade-offs (accepted by the user on 2026-10-02).** The name replaces the
page's title everywhere Firefox shows it: the tab, the window title, history
and the pin's bookmark. Unread counts in the title ("(495)") are no longer
visible. A pinned tab whose title no longer changes also no longer gets
Firefox's "title changed" attention mark.
