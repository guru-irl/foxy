# Foxy

A private Firefox add-on and browser theme.

- Replaces the new tab and home pages with widgets, group tiles and ungrouped tabs from every window.
- Saves groups and pinned tabs as bookmarks, so they survive a failed session restore and sync to your other devices through Firefox Sync.
- Switches to an open tab instead of opening a duplicate, including through Safe Links and sign-in pages.
- Lets local agents manage tabs and groups when you ask.
- Ships a glass, neutral, borderless Firefox theme with bundled fonts.

**Platforms:** desktop Firefox 140+ on macOS, Windows and Linux, not Android. The theme supports glass blur on macOS only.

Version 4.0.0. Distributed as an unlisted add-on. Design: `docs/superpowers/specs/2026-11-01-foxy-4.0-design.md` (layout); earlier specs in the same folder cover sync, agents and tiles.

## Board

- Widgets stack on the left. Group tiles fill the middle in up to four fixed-width columns. UNGROUPED TABS stays on the right, with the gear at its bottom right.
- Each column scrolls independently. On narrow pages, widgets move above the groups in the middle scroll.
- Drag either bar's inner edge to change its width. Both default to 304 px, between 240 px and a third of the page.
- Drag a widget by its header or empty space, or weather by its body, to reorder it. Its bottom edge changes its height.
- Drag a group header to reorder it, or focus the header and press Alt+Arrow. Its bottom edge sets 2 to 40 tab rows. Double-click the handle to fit 3 to 12 rows again.
- A neutral insertion line marks the drop. Release to save, Escape to cancel. Resizing the window never saves a layout.
- PINNED icons flow left to right. Hover or focus shows the name, other-window label and close button. Arrow keys move between icons.
- A muted pin dot means its name needs site access. Hover or focus for ALLOW. F2 or right-click renames a pin. Enter saves and Escape cancels.
- SAVED lists closed groups in the widgets bar. Click to open, or click × then DELETE? to delete everywhere.
- MEMORY shows Firefox's process total, system use and a five-minute sparkline. UNLOAD discards inactive, silent tabs by site. Per-site memory is unavailable. The helper is required.
- Weather uses your rounded location or a city from Settings. Larger boxes add condition, high and low, hourly forecasts, details and up to seven days. It refreshes every 15 minutes while visible and retains the last reading offline.
- This window's groups come first. Other windows are labelled. Changing tile order does not change tab order.
- Click a tab to open it. A pin from another window moves here unless that setting is off. Close it with ×.
- Drag tabs between groups, UNGROUPED TABS and PINNED. Drop on empty kanban space to create and name a group.
- Click a group name to rename it or its dot to recolour it. The arrow brings it here, and × closes it on this device.
- Picking a tab closes Foxy only when it has no history, without a Recently Closed entry.

## Settings

Open the gear inside the rail, or about:addons, Foxy, Options. Changes apply immediately. Escape or the gear closes the pane.

- Show or hide clock, pinned, saved, memory and weather independently.
- Reset layout needs two clicks within 3 seconds. It resets widget and group order, heights and both bar widths, without changing visibility or other settings.
- Choose a 24-hour or 12-hour clock, with an optional date.
- Weather offers °C with km/h or °F with mph. Search for a city or use your location. Location stays on this device.
- Cards have low, medium or high transparency. Row density is 32 px or compact 24 px and stays on this device.
- Other windows can be shown or hidden. Pins from another window can move here on click or focus their original window.
- Switch to an open tab instead of opening a duplicate can be turned off.
- Order, heights and bar widths sync with Firefox Sync's Add-ons enabled. Hidden widgets keep their order and height until Reset layout.

## Pinned tab names

- **Sidebar:** the theme gives pins on about 30 sites short names, such as YOUTUBE or GMAIL, matched by title.
- **Renamed pins:** the name is stored in the pin's bookmark and syncs to every device.
- **Site access:** Firefox asks once per site when renaming a pin. Devices without access show a muted top-left dot on the icon and ALLOW in its tooltip.
- **Trade-off:** names replace page titles in windows and history, hiding unread counts.

## Duplicate tabs

- **What:** a link that opens in the foreground (from mail, Teams or any app) for a page already open switches to that tab and closes the new one.
- **Matches:** same address ignoring `#…`, same container and private state; tabs in any window, pinned tabs and tabs in collapsed groups (the group expands).
- **Redirects:** the new tab is followed through Safe Links and sign-in pages for up to 2 minutes, until a page has loaded and stayed for 3 seconds; later clicks in that tab are never switched.
- **Left alone:** background tabs, bursts such as session restore or open all in tabs, the first 15 seconds after start, popups, and tabs Foxy opens.
- **Closed duplicates** skip Recently Closed, so Ctrl+Shift+T still reaches your own closed tabs.
- **Trade-off:** a tab you reopen with Ctrl+Shift+T while its page is open elsewhere is switched too, and its back and forward history is lost.

## Saved groups and Sync

- **Storage:** `Other Bookmarks/Foxy` holds `📌 Pinned` and group folders, such as `🔵 Reading`.
- **Closing:** a whole group or window keeps the group saved. Closing one tab removes its bookmark after 2 seconds.
- **SAVED:** groups closed here. Click to open. `N CAN'T REOPEN` counts blocked pages, such as `about:` or `file:`.
- **Delete everywhere:** × then `DELETE?` on a saved group.
- **After a restart:** if groups don't come back, a banner offers `RESTORE ALL` or `DISMISS`. Pins always reopen.
- **Other devices:** changes apply live, except to the tab you are looking at, which waits until you switch away.
- **Editing bookmarks:** rename folders to rename groups; add or move bookmarks to change tabs.
- **Merge leftovers:** first-run duplicates stay in `Other Bookmarks/Foxy merge leftovers`.
- **Private windows:** never shown or synced.

## Permissions

| Permission | Used for |
|---|---|
| `tabs` | Read, open, move, pin and close tabs |
| `tabGroups` | Read, create, move, rename and recolour groups |
| `bookmarks` | Save groups and pins |
| `storage` | Remember mappings and pending changes; board layout and settings (synced), device settings (local) |
| `scripting` | Keep a renamed pin's title |
| `nativeMessaging` | Connect the local helper: the agent CLI and the MEMORY tile |
| `geolocation` (optional) | Weather for where you are, asked by "Allow weather". Not needed for a searched city. Coordinates are rounded to 2 decimals before any request |
| Location data collection (optional) | Asked by "Allow weather"; until you allow it, weather sends nothing. Turn either off in about:addons: the tile asks again and the cached forecast and place name are deleted |
| Site access (optional) | Requested per site when you rename a pin there |

Foxy makes network requests only for weather, and only after you allow location data collection ("Allow weather"): Open-Meteo (forecast and city search) and BigDataCloud (place name). No API keys, no account, no cookies.

## Limits

- Sync timing is up to Firefox Sync: seconds to minutes.
- Only URLs and titles are saved, not back and forward history.
- Ungrouped, unpinned tabs are not saved.

## Install

1. about:addons, gear, **Install Add-on From File**, pick `dist/foxy-<version>-signed.xpi`.
2. Click **Keep changes** when Firefox asks about the new tab and home pages.

To remove: uninstall in about:addons. The `Foxy` bookmark folders stay; delete them by hand if you want.

## Agents

- **What:** agents list, create and manage groups through your running Firefox (Foxy 3.2.0 or newer; remove and delete need 3.4.0). macOS and Linux; Python 3, no packages. The same helper powers the MEMORY tile in Foxy 3.3.0, using macOS physical footprint (RSS fallback) or Linux PSS (RSS fallback). Windows has no helper memory measurement.
- **Install once** (keep this repo in place):
  - `python3 scripts/install_agent.py` registers the native host;
  - `ln -s "$PWD/skills/foxy-tabs" ~/.agents/skills/foxy-tabs` registers the skill.
- **Use:**

```sh
agent/foxy groups
agent/foxy tabs "To be reviewed"
agent/foxy add "To be reviewed" https://example.com/review
agent/foxy new "Dev server" http://localhost:3000 --color blue
agent/foxy add "Research" https://example.com/article --create
agent/foxy remove "To be reviewed" https://example.com/review
agent/foxy delete "Old work" --close-tabs
```

- **Behaviour:** tabs open in the background and never take focus; saved closed groups get bookmarks and stay closed; a missing group is refused unless `add --create`.
- **Safety:** remove or delete only what the user asks for. Prefer ungrouping to `--close`; report deleted URLs. Active tabs cannot be closed. An open group on another synced device may reappear there.
- **Exit codes:** 0 done, 1 refused, 2 Foxy not reachable. Every command accepts `--json`.
- **Update:** the helper runs from this repo, so `git pull` here before installing a newer Foxy. An older helper leaves MEMORY on "Memory unavailable".
- **Remove:** `python3 scripts/install_agent.py --uninstall`.

## Theme

- `theme/userChrome.css` styles the Firefox window, `theme/userContent.css` styles content pages, `theme/user.js` sets the preferences.
- **Install:** quit Firefox, then run `python3 scripts/install_theme.py`. It defaults to the macOS profile; use `--profile PATH` or `--firefox-dir PATH` elsewhere.
- **Backup:** existing files go to `<profile>/chrome/backup-<time>/`. The profile links to this repo; keep it in place.
- **Changes:** Firefox reads the theme only at startup, so quit and reopen after any change.
- **Undo:** quit Firefox, delete the four links, and move the backed-up files back (`user.js` goes in the profile folder, the rest in `chrome/`).

## Develop

The add-on lives in `extension/`; scripts and tests are at the repo root. No npm packages are needed.

| Command | What it does |
|---|---|
| `npm test` | Node and Python tests |
| `npm run test:browser` | DOM tests in headless Firefox |
| `npm run test:smoke` | Real add-on and duplicate-tab checks in headless Firefox |
| `python3 scripts/smoke_agent.py` | Agent CLI and memory end to end in headless Firefox (disposable native manifest) |
| `python3 scripts/preview.py` | Headless screenshots in `dist/preview/` |
| `python3 scripts/preview_v40.py` | Offline dark and light viewport matrix and contact sheet in `.spider/scratch/renders/` |
| `python3 scripts/check_private.py` | Scan for private data; run after committing, before pushing |

Every headless run uses a throwaway profile under `.spider/scratch/`, never your real one.

### Release

1. Save an AMO API key once in `~/.config/liquidfox-newtab/amo.env` (`AMO_JWT_ISSUER`, `AMO_JWT_SECRET`, mode 600).
2. Bump `version` in `extension/manifest.json` and `package.json`.
3. Run `python3 scripts/build.py && python3 scripts/sign.py`.

## Fonts

| Font | Name in CSS | Used for |
|---|---|---|
| EB Garamond | `Foxy Serif` | Clock |
| Google Sans Flex | `Foxy Sans` | Date and all other text |
| Cascadia Mono | `Foxy Mono` | URLs |

All three are under the SIL Open Font License. The fonts and licence files are in `extension/fonts/`.
