# Foxy

A private Firefox add-on and browser theme. The add-on replaces the new tab page and
the home page with a clock, the date and a kanban board of tabs and tab groups from
every normal, non-private window (Foxy 2.1.2). Groups and pins are saved in
bookmarks, with Firefox Sync carrying them to your other devices.
The clock uses EB Garamond SemiBold with upright lining tabular digits and an
ink-centred colon. Its size is calibrated to the previous Google Sans Flex clock.
The date stays upright, slightly compressed Google Sans Flex. Both start at the
PINNED title's ink rather than the card edge. Other page text uses Google Sans Flex;
group titles are condensed, bold and slanted. Clicking a tab switches to it; the page
closes only when it is its own tab's only history entry (`history.length === 1`).

After a click on a page with only one history entry, it switches to the selected tab,
blanks its own tab, flushes the blank entry and closes, so it stays out of Recently
Closed Tabs (as Firefox's own new tab page does). When the page has more than one
history entry (for example, after using the Home button in an existing tab), it
switches without closing. Closing the page with Cmd+W (or any way other than clicking a
tab on it) still adds a "New Tab" entry to Recently Closed Tabs. No `sessions`
permission is needed. Grouped and pinned tabs are kept as bookmarks; Foxy makes no
network requests itself. Firefox Sync shares those bookmarks when enabled.

Design: `docs/superpowers/specs/2026-10-01-foxy-design.md`.

## Board

PINNED stays on the left and TABS on the right. SAVED (when it has entries), group
columns and `+ NEW GROUP` scroll sideways between them; each column scrolls
vertically. A 24px content fade appears only at edges with more content offscreen,
horizontally in the strip and vertically in each row list. Neutral glass card fills
use alpha 0.6 in dark mode and 0.7 in light mode. This window's tabs and groups come
first, with other windows labelled below the headers or in separate sections. Empty group names show a faint `UNNAMED`;
long names are cut with an ellipsis.

- Drag a tab to a group, TABS or PINNED at the insertion line. PINNED brings the tab
  into this window and pins it. Dropping on `+ NEW GROUP` creates a local group and
  opens its name editor.
- Click a group title to rename it. Enter or clicking elsewhere saves the trimmed
  name, including an empty name; Escape cancels. A new group stays unnamed on cancel.
- Click a group dot for the nine Firefox colours. Pick a dot to apply it; Escape or
  clicking elsewhere dismisses the picker.
- Click the arrow in an `OTHER WINDOW` header to bring its group here, after this
  window's last tab. Drag a group header to reorder it or move it between windows.
- Click × on a row to close only that tab, or × on a header to close the group's
  tabs on this device. These controls never close the Foxy page. Open and close tab
  actions are separate keyboard-reachable buttons.
- Click a tab to switch to it. Pins from another window follow you here; other tabs
  focus their original window. Only tab activation can trigger the page-close rule
  described above. Editing and dragging defer live board updates until they end.

## Saved groups and Sync

SAVED lists groups that are not open on this device, with a colour dot and bookmark
count. Click one to open it here with unloaded tabs. An `N CAN'T REOPEN` label counts
URLs Firefox does not let an add-on reopen, such as `about:` or `file:` pages;
its tooltip lists those URLs. They stay bookmarked but are skipped when opening
the group. An empty group name appears as `UNNAMED`.

Closing a whole group or its window keeps it saved. Closing an individual tab
removes its bookmark after a short delay. To delete a saved group everywhere,
click its ×, then deliberately click `DELETE?` after at least 400ms. Double-clicks
never confirm deletion; moving away cancels the confirmation.

If groups previously open here are missing after a restart, the board shows
`N GROUPS DIDN'T COME BACK` with `RESTORE ALL` and `DISMISS`. They also appear
individually in SAVED. Restore opens them here; Dismiss only clears the banner.
Groups whose window you closed on purpose can also appear in this banner.

Under `Other Bookmarks/Foxy`, `📌 Pinned` holds pins and each group has its own
folder named with a colour emoji and the group name (for example, `🔵 Reading`).
Each tab is a bookmark in tab order. Enable bookmark sync in Firefox Sync on each
device to share them; without Sync they still survive locally. Shared pins reopen
on each device. New group folders appear in SAVED rather than opening automatically.
You can also rename folders and edit bookmarks there to change groups and tabs.

First-run merges move duplicates and emptied extra folders into
`Other Bookmarks/Foxy merge leftovers` rather than deleting them. Foxy does not
manage or reopen that folder; it is safe to delete by hand after checking its contents.
Firefox Sync can also silently change bookmark IDs when it dedupes new local items.
Foxy rebinds those identities without closing or replacing their existing tabs;
a missing ID alone is not treated as a deletion.

Sync never closes, moves or navigates the tab you are looking at in the focused
window. Such changes wait until you switch away and are applied only if still valid.
Private windows never sync and are not shown on the board.

### Permissions

Updating to this release asks once for the new bookmarks permission. Foxy uses:

- `tabs`: read tab titles and URLs, activate, move, pin, open and close tabs.
- `tabGroups`: read, create, move, rename and recolour groups.
- `bookmarks`: save groups and pins in Foxy's folder and apply bookmark changes.
- `storage`: remember bookmark mappings, which groups are open here, and deferred
  sync changes across restarts.

### Known limitations

- Firefox Sync delivers bookmark changes on its own schedule, from seconds to minutes.
- Only URLs and titles are saved, not back/forward history. Restored tabs start
  fresh; logins survive through cookies.
- Ungrouped, unpinned tabs are not saved. Private windows and keyboard tab moving
  are not supported. Firefox's own saved-groups feature is separate and unaffected.
- A local navigation held for safe syncing is lost across a restart, when the
  session mappings and last-synced history are rebuilt. Held group ordering waits
  for a safe activation to retry.
- The theme does not change web pages' or `about:` pages' fonts.

## Checking it in Firefox

Use normal windows, with bookmark sync enabled for the cross-device check:

1. Drag a tab between groups in two windows and check its exact insertion position.
2. Click a pin from the other window and check that it moves here, still pinned.
3. Drag a group header to reorder it, then move its column into the other window.
4. Create or rename a group and check its colour-emoji folder and tab bookmarks under
   `Other Bookmarks/Foxy`; pins should appear under `📌 Pinned`.
5. On a second device with Foxy and Firefox Sync, check shared pins and SAVED groups,
   open a saved group, then edit a bookmark and check the change on the first device.
6. Restart with session restore off while groups are open. Check the missing-groups
   banner, `RESTORE ALL`, and `DISMISS`. Pins should reopen too.
7. Close a whole group so it appears in SAVED, then use × and `DELETE?`. Check that
   its folder is gone and Sync removes it on the second device.

## Develop

The add-on root is `extension/`: `extension/manifest.json`, `extension/newtab.html`,
`extension/newtab.css`, `extension/background.js`, `extension/src/`,
`extension/icons/` and `extension/fonts/`. Scripts and tests stay at the repo root.
The build packages only the add-on, with `manifest.json` at the root of
`dist/foxy-<version>.zip`.

    npm test                          # node --test and the Python tests; no npm packages
    npm run test:browser               # DOM tests in headless Firefox (throwaway profile)
    python3 scripts/preview.py         # headless screenshots in dist/preview/ (throwaway profile)
    python3 scripts/smoke_firefox.py    # real extension checks in a throwaway headless profile

Runner failure-fixture checks are opt-in: `python3 test/browser/check_runner.py`.
They launch throwaway Firefox instances; `npm test` never launches Firefox.

Before pushing: the scan reads files from the working tree, so commit (or stash) first, then run `python3 scripts/check_private.py` (patterns stay outside the repo in `~/.config/foxy/scan-patterns.txt`).

## Smoke check in real Firefox

Run `python3 scripts/smoke_firefox.py` (or `npm run test:smoke`) to temporarily
install the unpacked add-on in headless Firefox. Add `--keep-going` to report all
checks rather than stopping at the first failure. Use `--firefox PATH` to select
another Firefox executable. Any failure exits 1. This is separate from `npm test`.

The check covers the real newtab override, board and clock, bundled fonts,
bookmark-backed sync startup and a grouped-tab round-trip. It prints extension
console errors and warnings, and saves a board screenshot, console JSON and
Firefox log under `.spider/scratch/smoke-<timestamp>/`. Its throwaway profile and
artifacts are kept there. It never uses your real Firefox profile, signs the
add-on or contacts AMO; external page loads are blocked and are not needed for sync.

## Sign and install

1. Create an API key at https://addons.mozilla.org/developers/addon/api/key/ and save it.
   In zsh (the macOS default shell):

       mkdir -p ~/.config/liquidfox-newtab && chmod 700 ~/.config/liquidfox-newtab
       read -r "ISSUER?JWT issuer: "
       read -rs "SECRET?JWT secret: "; echo
       ( umask 077; printf 'AMO_JWT_ISSUER=%s\nAMO_JWT_SECRET=%s\n' "$ISSUER" "$SECRET" > ~/.config/liquidfox-newtab/amo.env )
       unset ISSUER SECRET

2. Bump `version` in `extension/manifest.json` and `package.json` for every new release, then:

       python3 scripts/build.py && python3 scripts/sign.py

3. In Firefox: about:addons → gear → Install Add-on From File →
   `dist/foxy-<version>-signed.xpi`. Click "Keep changes" when Firefox asks
   about the new tab page and the home page.

The add-on is unlisted: signed by Mozilla, never published.

## Undo

Remove the add-on in about:addons. Firefox's own new tab page and home page come back.
`Other Bookmarks/Foxy` and `Other Bookmarks/Foxy merge leftovers` stay after removal;
delete them by hand if you no longer want the saved bookmarks.
If you removed the address-bar rule after installing, restore it in your Firefox
profile's `chrome/userChrome.css` (section 5) from
`chrome/userChrome.css.bak-before-newtab` (made right before the rule is removed).

## Theme

`theme/` holds the browser theme: `userChrome.css` styles Firefox's interface,
`userContent.css` provides content-page styling, and `user.js` sets the theme's
Firefox preferences. These files are separate from the add-on and are not in its
package. Fonts are shared from `extension/fonts/`; `theme/fonts` links there too,
so relative font URLs work from either location.

Quit Firefox with Cmd+Q, then run from the repo:

    python3 scripts/install_theme.py

The script finds the default profile through `profiles.ini` in
`~/Library/Application Support/Firefox`. To choose a profile or a different
Firefox directory:

    python3 scripts/install_theme.py --profile "/path/to/profile"
    python3 scripts/install_theme.py --firefox-dir "/path/to/Firefox"

Existing `chrome/userChrome.css`, `chrome/userContent.css`, `chrome/fonts`
(including a real font directory or an old symlink), and `user.js` are moved to
`<profile>/chrome/backup-YYYYMMDD-HHMMSS/`. If that backup name already exists, a
numeric suffix keeps it separate. Only replaced entries are backed up; an empty
profile needs no backup. The originals are replaced by absolute symlinks to the
repo's theme files and `extension/fonts/`. Running it again with the correct
links in place changes nothing. Keep the repo at that location while using the
theme. Reopen Firefox to load it; CSS changes also need a full restart.

To undo, quit Firefox, delete only the four installed symlinks above, and move
`userChrome.css`, `userContent.css` and `fonts` from your backup back into
`<profile>/chrome/`. Move the backed-up `user.js` to `<profile>/user.js`, not into
`chrome/`. Restore only entries present in the backup; if there was no original,
leave that link removed. Then reopen Firefox.

## Licences

Google Sans Flex, EB Garamond and Cascadia Mono are under the SIL Open Font License.
The fonts and their licence files are bundled in `extension/fonts/`; see
`GoogleSansFlex-OFL.txt`, `GoogleSansFlex-TRADEMARKS.md`, `EBGaramond-OFL.txt` and
`CascadiaMono-OFL.txt` there. EB Garamond is `"Foxy Serif"` (variable weight 400 to
800), used at 600 for the clock with lining and tabular figures. Cascadia Mono is
`"Foxy Mono"` for URLs and code-like text. Google Sans Flex is `"Foxy Sans"`, used
for the date and other text. Its roundness axis stays at the default 0.
