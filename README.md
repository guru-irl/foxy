# Foxy

A private Firefox add-on and browser theme.

- Replaces the new tab and home pages with a grid of your tabs and tab groups from every window.
- Saves groups and pinned tabs as bookmarks, so they survive a failed session restore and sync to your other devices through Firefox Sync.
- Ships a glass, neutral, borderless Firefox theme with bundled fonts.

**Platforms:** desktop Firefox 140+ on macOS, Windows and Linux, not Android. The theme supports glass blur on macOS only.

Version 3.1.0. Distributed as an unlisted add-on. Design: `docs/superpowers/specs/2026-10-03-foxy-grid-design.md`.

## Board

- **Tiles:** groups, PINNED, SAVED and a clock on a scrolling grid that fills the page edge to edge, with scrolling tab lists.
- **TABS rail:** ungrouped tabs stay on the right, with their own scroll. The Settings gear has its own cell below it.
- **Move and resize:** drag tile headers or corner handles. The tile follows the pointer; an outline and corner dots show the cells it will take, and tiles in the way slide aside. Release to place, Escape to cancel. Drag the rail edge to resize it.
- **Narrow windows:** overflowing tiles appear below. Saved places stay unchanged until you move them.
- **Windows:** this window comes first; others are labelled. Tile places do not change tab order.
- **Open a tab:** click it. A pin from another window moves here unless that setting is off.
- **Move tabs:** drag to a group, TABS or PINNED. Drop on empty grid space to create and name a group.
- **Groups:** click the name to rename or the dot to recolour, use the arrow to bring a group here, × to close it on this device.
- **Close a tab:** × on its row.
- **Rename a pin:** the pencil or F2. Enter or click away saves, Escape cancels, an empty name removes it.
- **Page closing:** picking a tab closes Foxy only when it has no history, without a Recently Closed entry.

## Settings

Open the gear in the bottom right corner. Changes apply immediately; Escape or the gear closes the pane.
The same settings are in about:addons, Foxy, Options.

| Setting | Values | Scope |
|---|---|---|
| Cell size | S 48, M 80, L 112, XL 144; custom 40 to 240 px (cells stretch a little to fill the width) | Per device |
| TABS rail width | 2 cells to half the available width; default 3 | Synced |
| Show clock, pinned, saved | On or off for each | Synced |
| Reset layout | Click twice within 3 seconds; clears all saved tile places | Synced |
| Time format | 24-hour or 12-hour | Synced |
| Show date | On or off | Synced |
| Transparency | Low, medium, high | Synced |
| Row density | Normal 32 px, compact 24 px | Per device |
| Other windows | Show or hide their tabs and groups | Synced |
| Move other-window pins here on click | On; off focuses their window instead | Synced |

Tile places sync with Firefox Sync's Add-ons enabled. Hidden tiles keep their places until a reset.

## Pinned tab names

- **Sidebar:** the theme gives pins on about 30 sites short names, such as YOUTUBE or GMAIL, matched by title.
- **Renamed pins:** the name is stored in the pin's bookmark and syncs to every device.
- **Site access:** Firefox asks once per site when renaming a pin. Devices without access show ALLOW.
- **Trade-off:** names replace page titles in windows and history, hiding unread counts.

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
| `storage` | Remember mappings and pending changes; tile layout and settings (synced), device settings (local) |
| `scripting` | Keep a renamed pin's title |
| Site access (optional) | Requested per site when you rename a pin there |

Foxy makes no network requests of its own.

## Limits

- Sync timing is up to Firefox Sync: seconds to minutes.
- Only URLs and titles are saved, not back and forward history.
- Ungrouped, unpinned tabs are not saved.

## Install

1. about:addons, gear, **Install Add-on From File**, pick `dist/foxy-<version>-signed.xpi`.
2. Click **Keep changes** when Firefox asks about the new tab and home pages.

To remove: uninstall in about:addons. The `Foxy` bookmark folders stay; delete them by hand if you want.

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
| `python3 scripts/smoke_firefox.py` | Real add-on checks in headless Firefox; `--keep-going` reports every failure |
| `python3 scripts/preview.py` | Headless screenshots in `dist/preview/` |
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
