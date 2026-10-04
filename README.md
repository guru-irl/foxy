# Foxy

A private Firefox add-on and browser theme.

- Replaces the new tab and home pages with a grid of your tabs and tab groups from every window.
- Saves groups and pinned tabs as bookmarks, so they survive a failed session restore and sync to your other devices through Firefox Sync.
- Switches to an open tab instead of opening a duplicate, including through Safe Links and sign-in pages.
- Lets local agents add tabs to your groups.
- Ships a glass, neutral, borderless Firefox theme with bundled fonts.

**Platforms:** desktop Firefox 140+ on macOS, Windows and Linux, not Android. The theme supports glass blur on macOS only.

Version 3.3.1. Distributed as an unlisted add-on. Design: `docs/superpowers/specs/2026-10-03-foxy-grid-design.md`, `2026-10-04-foxy-3.2-design.md` and `2026-10-04-foxy-3.3-design.md`.

## Board

- **Tiles:** groups, PINNED, SAVED, a clock, MEMORY and weather on a scrolling grid that fills the page edge to edge. Groups and SAVED have scrolling lists.
- **PINNED:** one icon per cell, in tab order. Hover shows the name, other-window label and ×; the active pin has a neutral bottom dot. A muted top-left dot means the name needs site access; hover or focus the icon for ALLOW. Extra pins scroll with edge fades. Default 6 × 2 cells, minimum 1 × 1.
- **Memory:** the helper measures Firefox's process total and system use, with a five-minute sparkline. Loaded sites are grouped by host; UNLOAD discards inactive tabs. Firefox cannot report per-site memory. Without the helper, the tile shows installation guidance; see Agents to install it.
- **Weather:** your location (rounded to about 1 km) or a city you pick in Settings. The tile shows more as it grows, in one column: temperature, then place, condition and high / low, then the next 24 hours (scroll them with the wheel, the arrow keys or a swipe), then feels like, wind and humidity, then up to 7 days. It refreshes every 15 minutes while a Foxy page is visible; offline it shows the last reading and when it was updated.
- **UNGROUPED TABS rail:** ungrouped tabs stay on the right, running to the board bottom with their own scroll. A round Settings gear sits inside the rail at its bottom right; the tab list ends above it.
- **Move and resize:** drag a tile's header (empty space or the 4 px icon margins for PINNED, even at 1 × 1; the weather tile by its body), or any of its four corners. The tile follows the pointer; an outline and corner dots show the cells it will take, and tiles in the way slide aside. Release to place, Escape to cancel. Drag the rail edge to resize it.
- **Window widths:** each width keeps its own layout (up to 4). A width without one shows the closest: tiles narrow slightly, or columns of tiles pack together in order. Resizing saves nothing. Moving a tile updates the layout shown if the result still fits it; otherwise it saves a new layout for this width.
- **Windows:** this window comes first; others are labelled. Tile places do not change tab order.
- **Open a tab:** click it. A pin from another window moves here unless that setting is off.
- **Move tabs:** drag to a group, UNGROUPED TABS or PINNED. Drop on empty grid space to create and name a group.
- **Groups:** click the name to rename or the dot to recolour, use the arrow to bring a group here, × to close it on this device.
- **Close a tab:** × on its row or pinned icon.
- **Rename a pin:** focus its icon and press F2, or right-click it. Enter or click away saves, Escape cancels, an empty name removes it. Arrow keys move between icons.
- **Page closing:** picking a tab closes Foxy only when it has no history, without a Recently Closed entry.

## Settings

Open the gear inside the rail's bottom right corner. The pane opens at the page's top right, 360 px wide, and ends one gap above the gear so it stays clickable. Changes apply immediately; Escape or the gear closes the pane.
The same settings are in about:addons, Foxy, Options.

After updating, boards saved with M, L or XL cells show smaller tiles; resize them or use Reset layout.

| Setting | Values | Scope |
|---|---|---|
| Cell size | S 48 px (default); Custom 40 to 240 px (cells stretch a little to fill the width) | Per device |
| Ungrouped tabs rail width | 2 cells to half the available width; default 5 | Synced |
| Show clock, pinned, saved, memory, weather | On or off for each | Synced |
| Reset layout | Click twice within 3 seconds; clears saved tile places for every width | Synced |
| Time format | 24-hour or 12-hour | Synced |
| Show date | On or off | Synced |
| Temperature | °C (wind in km/h) or °F (wind in mph) | Synced |
| Location | Current location, or a city found by search (Enter picks the first match); Use my location goes back | Per device |
| Transparency | Low, medium, high | Synced |
| Row density | Normal 32 px, compact 24 px | Per device |
| Other windows | Show or hide their tabs and groups | Synced |
| Move other-window pins here on click | On; off focuses their window instead | Synced |
| Switch to an open tab instead of opening a duplicate | On or off | Synced |

Tile places sync with Firefox Sync's Add-ons enabled. Hidden tiles keep their places in each layout until a reset.

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
| `storage` | Remember mappings and pending changes; tile layout and settings (synced), device settings (local) |
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

- **What:** agents list groups and add URLs through your running Firefox (Foxy 3.2.0 or newer). macOS and Linux; Python 3, no packages. The same helper powers the MEMORY tile in Foxy 3.3.0, using macOS physical footprint (RSS fallback) or Linux PSS (RSS fallback). Windows has no helper memory measurement.
- **Install once** (keep this repo in place):
  - `python3 scripts/install_agent.py` registers the native host;
  - `ln -s "$PWD/skills/foxy-tabs" ~/.agents/skills/foxy-tabs` registers the skill.
- **Use:**

```sh
agent/foxy groups
agent/foxy tabs "To be reviewed"
agent/foxy add "To be reviewed" https://example.com/review
agent/foxy new "Dev server" http://localhost:3000 --color blue
```

- **Behaviour:** tabs open in the background and never take focus; saved closed groups get bookmarks and stay closed; a missing group is refused unless `add --create`.
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
