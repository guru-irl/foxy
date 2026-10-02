# Foxy

A private Firefox add-on and browser theme for macOS.

- Replaces the new tab and home pages with a clock and a board of your tabs and tab groups from every window.
- Saves groups and pinned tabs as bookmarks, so they survive a failed session restore and sync to your other devices through Firefox Sync.
- Ships a glass, neutral, borderless Firefox theme with bundled fonts.

Version 2.2.0. Unlisted and signed by Mozilla. Design: `docs/superpowers/specs/2026-10-01-foxy-design.md`.

## Board

- **Columns:** PINNED on the left, TABS (ungrouped tabs) on the right, and SAVED, the groups and `+ NEW GROUP` in a scrolling strip between them.
- **Windows:** this window's tabs and groups come first; other windows are labelled.
- **Open a tab:** click it. A pin from another window moves here.
- **Move tabs:** drag a tab to any group, TABS or PINNED. Dropping on PINNED pins it here; dropping on `+ NEW GROUP` creates a group.
- **Groups:** click the name to rename, click the dot to recolour, drag the header to reorder or move it to another window, use the arrow to bring it here, × to close it on this device.
- **Close a tab:** × on its row.
- **Rename a pin:** the pencil on its row, or F2. Enter or click away saves, Escape cancels, an empty name removes it.
- **Page closing:** after you pick a tab, the page closes only if it has no other history, so it stays out of Recently Closed Tabs.

## Pinned tab names

- **In the sidebar:** pinned tabs on well-known sites show a short name such as YOUTUBE, GMAIL, DISCORD, AZURE, DEVOPS or COPILOT (theme, about 30 sites, matched by title).
- **Renamed pins:** the name is stored in the pin's bookmark and syncs to every device.
- **Site access:** Firefox asks once per site, the first time you rename a pin there. On a device without access, the row shows ALLOW.
- **Trade-off:** the name replaces the page title everywhere, including the window title and history, so unread counts in titles are hidden.

## Saved groups and Sync

- **Storage:** `Other Bookmarks/Foxy` holds `📌 Pinned` and one folder per group, named with a colour emoji and the group name, for example `🔵 Reading`.
- **Closing:** a whole group or window keeps the group saved. Closing one tab removes its bookmark after 2 seconds.
- **SAVED:** groups not open on this device. Click to open one here. `N CAN'T REOPEN` counts pages Firefox won't let an add-on open, such as `about:` or `file:`.
- **Delete everywhere:** × then `DELETE?` on a saved group.
- **After a restart:** if groups don't come back, a banner offers `RESTORE ALL` or `DISMISS`. Pins always reopen.
- **Other devices:** changes apply live, except to the tab you are looking at, which waits until you switch away.
- **Editing bookmarks:** works too. Rename a folder to rename its group, or add or move bookmarks to change its tabs.
- **Merge leftovers:** duplicates from a first-run merge go to `Other Bookmarks/Foxy merge leftovers`. Nothing is deleted.
- **Private windows:** never shown or synced.

## Permissions

| Permission | Used for |
|---|---|
| `tabs` | Read, open, move, pin and close tabs |
| `tabGroups` | Read, create, move, rename and recolour groups |
| `bookmarks` | Save groups and pins |
| `storage` | Remember mappings and pending changes across restarts |
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
- **Install:** quit Firefox (Cmd+Q), then run `python3 scripts/install_theme.py`. Add `--profile PATH` or `--firefox-dir PATH` to pick another profile.
- **What it does:** backs up existing files to `<profile>/chrome/backup-<time>/`, then links the profile to the repo. Keep the repo where it is.
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
