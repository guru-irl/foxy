# Liquid Fox New Tab: design

Date: 2026-09-30. Status: approved in chat (three design sections, all "go").

## Goal

Replace Firefox's new tab page (and home page) with a page that shows a big clock, the date,
the current window's pinned tabs and its tab groups. Clicking a tab switches to it and closes
the new tab page only if it is its tab's only history entry (`history.length === 1`).
It sits on the user's "Liquid Fox" glass theme (userChrome.css), so the page is
transparent and the window's glass shows through.

## Context and constraints

- Firefox 157 release on macOS. Release Firefox only installs Mozilla-signed add-ons, so the
  add-on is signed through the user's addons.mozilla.org (AMO) account as an **unlisted**
  add-on (never published).
- `registry.npmjs.org` is blocked on this machine (TLS failure, likely endpoint security), so
  `web-ext` is not available. Signing talks to the AMO v5 API directly with Python's standard
  library. `addons.mozilla.org`, `raw.githubusercontent.com` and `github.com` are reachable.
- Checked in Firefox 157's own files: the `tabGroups` API exists (query, get, update, move;
  onCreated, onUpdated, onMoved, onRemoved; permission `tabGroups`; colors blue, cyan, grey,
  green, orange, pink, purple, red, yellow), tabs have `groupId`, and
  `chrome_url_overrides.newtab` / `chrome_settings_overrides.homepage` are supported.
- An add-on new tab page is treated by Firefox as a "blank"/initial page: the address bar is
  focused when a new tab opens and stays empty (from Firefox source, not tested). The first
  time, Firefox shows a one-time "an extension changed your new tab" notice.
- Firefox does not preload a replacement new tab page (NewTabPagePreloading skips it when the
  new tab URL is overridden), so each new tab loads fresh.
- User taste: neutral black/grey glass, no borders, outlines or drop shadows, near-opaque glass
  where text sits, color only as small bright accents, even spacing.

## Decisions

| Topic | Decision |
|---|---|
| Delivery | Private add-on, unlisted AMO signing, installed from file |
| Search | No search box in the page. The address bar comes back on new tabs |
| Top of page | 24-hour clock without seconds in Danfo; date in Bebas Neue below it |
| Tabs shown | Current window only: pinned tabs, then tab groups. Ungrouped tabs are not shown |
| Click | Switch to the tab; blank and close this page only when it is its tab's only history entry |
| Group card | Header (color dot + name) and one row per tab (icon + title); scrolls after 8 rows |
| Home page | The add-on also replaces the home page, so new windows show the same page |
| Code | Plain HTML/CSS/JS modules, no framework, no build step |

## Architecture

Repo: `~/src/liquidfox-newtab/` (local git only).

| File | Responsibility |
|---|---|
| `manifest.json` | MV3 manifest: new tab + home page override, permissions `tabs` and `tabGroups`, module background script, gecko id, `strict_min_version` 140.0, `data_collection_permissions.required = ["none"]` |
| `newtab.html` | Page skeleton: clock, date, pinned strip, groups grid |
| `newtab.css` | All page styling |
| `src/model.js` | Pure functions: sort tabs into pinned + groups, group color key, time text, date text, delay to next minute |
| `src/actions.js` | `activateTab`: switch; request close when passed a close flag; stays open on failure |
| `src/render.js` | DOM building for the pinned strip and the group cards (text only, no HTML strings) |
| `src/main.js` | Wires the browser API: reads tabs, checks `history.length === 1` for the close flag, listens for changes, runs the clock |
| `background.js` | Module event page: listens for blank-and-close requests from the page |
| `src/close.js` | Blanks the requesting tab's history entry before closing it |
| `fonts/` | Danfo (variable, ELSH axis) and Bebas Neue, both OFL, with licence files |
| `icons/globe.svg` | Fallback icon for tabs without a usable favicon |
| `preview/` | Fake `browser` API + fixtures, for headless screenshots |
| `scripts/preview.py` | Headless Firefox screenshots of fixture scenarios with a throwaway profile |
| `scripts/build.py` | Zips only the add-on files into `dist/liquidfox-newtab-<version>.zip` |
| `scripts/sign.py` | AMO v5 signing: upload, wait for validation, create/update, wait for signing, download |

The page reads the tabs itself while it is open. The module background event page
(`background.js`, `src/close.js`) only blanks, flushes and closes the page on request after a
click when `src/main.js` passes `close: history.length === 1`. After blanking, discard
flushes SessionStore's cached history before closing; a tab whose only history entry is
about:blank stays out of Recently Closed Tabs. Closing the page with Cmd+W (or any way
other than clicking a tab on it) still adds a "New Tab" entry to Recently Closed Tabs.

## Behavior

- On load, the page gets its own tab (`tabs.getCurrent`) and window, then queries that
  window's tabs and tab groups.
- Pinned tabs in tab order. Groups ordered by their first tab's index (sidebar order); each
  group's tabs in tab order. Left out: the page's own tab (it can sit inside a group when
  opened with "New tab in group"), tabs with `hidden: true`, and groups that end up empty.
- Unloaded (discarded) tabs are shown like any other.
- Any change (tabs created, removed, updated, moved, attached, detached; groups created,
  updated, moved, removed) schedules one re-query and re-render per animation frame.
- Re-render keeps each card's scroll position (keyed by group id).
- Titles and names are set with `textContent`; nothing is parsed as HTML.
- Click (or Enter/Space on the focused button): `src/main.js` passes
  `close: history.length === 1` to `activateTab`, which switches via
  `tabs.update(id, {active: true})`. With that flag, it asks the background to replace
  this page's history entry with about:blank, flush it and close it. If the update
  rejects (tab gone), the page stays open and redraws. With more than one history
  entry (Home in an existing tab), it switches without closing.
- Tab title fallback: the URL, then an empty string.
- Group name fallback: `Unnamed group` (shown in capitals by Bebas Neue).
- Group color: API `grey` maps to the sidebar's `gray`; unknown colors fall back to `gray`.
- Clock: `HH:MM` 24-hour local time, updated on each minute boundary and again whenever the
  page becomes visible (background timers are throttled).
- Date: `WEEKDAY D MONTH` in English capitals, e.g. `WEDNESDAY 30 SEPTEMBER`. No year.
- Favicons load from `favIconUrl`; missing or failing icons (including `chrome://` icons an
  add-on cannot load) show the globe.
- If `tabGroups.query` fails, pinned tabs still show. The clock does not depend on tab code.
- Private windows keep Firefox's private page (the add-on is not allowed in private windows).

## Layout and look

- Page and body backgrounds transparent. Column `min(860px, 100% - 64px)` wide, centered,
  starting 10vh from the top, 64px bottom margin, scrolls if needed.
- Time: Danfo, `clamp(88px, 11vw, 160px)`, line-height 1, normal weight (the face is heavy;
  no synthetic bold), centered, near-white `light-dark(rgba(0,0,0,.85), rgba(255,255,255,.92))`.
- Date: Bebas Neue 22px, letter-spacing 0.12em, muted
  `light-dark(rgba(0,0,0,.55), rgba(255,255,255,.6))`, centered, 8px under the time.
- Pinned strip: 40px under the date, full column width, 8px padding, radius 20px, fill
  `light-dark(rgba(0,0,0,.04), rgba(255,255,255,.06))`. Tiles 40x40, radius 10px, 20px icon,
  8px gaps, centered, wrapping. Title as tooltip. Hidden when there are no pinned tabs.
- Groups: 12px under the strip (40px under the date when there is no strip). Flex-wrap, gap
  12px, centered. Card width `(100% - 2 * 12px) / 3`; below 640px of column width
  `(100% - 12px) / 2`; below 420px full width. Cards in one row share the tallest height.
  Hidden when there are no groups.
- Card: padding 8px, radius 12px, fill `light-dark(rgba(246,246,247,.85), rgba(22,22,24,.78))`.
- Card header: 32px tall; 12px dot with the sidebar's gradient and glow; name in Bebas Neue
  15px, letter-spacing 0.06em, color `light-dark(rgba(0,0,0,.62), rgba(255,255,255,.68))`,
  nudged down 0.05em, ellipsis. Dot center lines up with the row icons below (10px start
  padding for the dot, 8px for rows).
- Rows: 32px tall, 8px inline padding, 16px icon, 8px gap, system UI font 13px, ellipsis.
  Hover fill `light-dark(rgba(0,0,0,.06), rgba(255,255,255,.08))`, radius 8px. Pressed and
  keyboard focus use `light-dark(rgba(0,0,0,.1), rgba(255,255,255,.12))`; no focus outline.
- Card list scrolls after 8 rows (`max-height: 8 * 32px`), thin scrollbar, thumb
  `light-dark(rgba(0,0,0,.2), rgba(255,255,255,.18))`, transparent track, no edge shadow.
- Dot colors (g1 = light end at 75% opacity, g2 = solid end; `linear-gradient(135deg, g1, g2)`,
  glow `0 0 6px` of g2 at 50%):

  | Color | g1 | g2 |
  |---|---|---|
  | red | oklch(0.86 0.10 45) | oklch(0.72 0.17 18) |
  | orange | oklch(0.90 0.10 80) | oklch(0.77 0.16 52) |
  | yellow | oklch(0.96 0.11 108) | oklch(0.87 0.15 85) |
  | green | oklch(0.91 0.13 135) | oklch(0.76 0.16 158) |
  | cyan | oklch(0.92 0.09 185) | oklch(0.77 0.13 220) |
  | blue | oklch(0.88 0.09 228) | oklch(0.70 0.16 258) |
  | purple | oklch(0.87 0.10 325) | oklch(0.71 0.17 295) |
  | pink | oklch(0.90 0.09 355) | oklch(0.74 0.17 5) |
  | gray | oklch(0.93 0.01 250) | oklch(0.72 0.02 250) |

## Signing and install

- Credentials: `~/.config/liquidfox-newtab/amo.env` (mode 600, created by the user) with
  `AMO_JWT_ISSUER=...` and `AMO_JWT_SECRET=...`. Never in the repo, never in chat.
- `scripts/build.py` → `scripts/sign.py`: upload with channel `unlisted`, poll until
  processed, stop on validation errors, `PUT /addons/addon/<guid>/` with the upload uuid,
  poll the version until its file status is `public`, download the signed `.xpi` to `dist/`.
- The user installs the `.xpi` from about:addons ("Install Add-on From File"), then clicks
  "Keep changes" on Firefox's notices. Later versions (bumped `version`) update in place.

## Profile changes at install time (outside this repo)

- userChrome.css section 5: remove the rule that hides the address bar on blank pages.
  Keep the transparent-page backstop logic (it keys off the empty address bar).
- userContent.css's new tab search styling stays; it then only affects Firefox Home.

## Testing

1. `node --test`: model (sorting, exclusions, fallbacks, colors, time incl. `00:00`, date,
   next-minute delay), actions (switch then request blank-and-close; stays open on failure),
   background close flow, manifest (fields and that every referenced file exists).
2. `python3 -m unittest`: JWT creation, credentials parsing, multipart encoding, build
   contents.
3. Headless screenshots of fixture scenarios (clock only; 1, 2, 3 and 5 groups; long group;
   missing and failing icons; unnamed group; light scheme; narrow widths) with a throwaway
   profile, never the user's profile.
4. AMO's validator runs on upload and must report no errors.
5. The user checks the installed add-on in their Firefox.

## Undo

Remove the add-on in about:addons; Firefox's new tab page and home page return. The
address-bar rule can be restored from `chrome/userChrome.css.bak-before-newtab`, made
right before the rule is removed.
