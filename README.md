# Foxy

A private Firefox add-on and browser theme. The add-on replaces the new tab page and
the home page with a clock, the date, this window's pinned tabs and its tab groups.
All page text uses Google Sans Flex: the clock is heavy and upright, the date upright,
and group titles condensed, heavy and slanted. Clicking a tab switches to it; the page
closes only when it is its own tab's only history entry (`history.length === 1`).

After a click on a page with only one history entry, it switches to the selected tab,
blanks its own tab, flushes the blank entry and closes, so it stays out of Recently
Closed Tabs (as Firefox's own new tab page does). When the page has more than one
history entry (for example, after using the Home button in an existing tab), it
switches without closing. Closing the page with Cmd+W (or any way other than clicking a
tab on it) still adds a "New Tab" entry to Recently Closed Tabs. No `sessions`
permission is needed; the add-on keeps nothing and sends nothing.

Design: `docs/superpowers/specs/2026-09-30-newtab-design.md`.

## Develop

The add-on root is `extension/`: `extension/manifest.json`, `extension/newtab.html`,
`extension/newtab.css`, `extension/background.js`, `extension/src/`,
`extension/icons/` and `extension/fonts/`. Scripts and tests stay at the repo root.
The build packages only the add-on, with `manifest.json` at the root of
`dist/foxy-<version>.zip`.

    npm test                          # node --test and the Python tests; no npm packages
    npm run test:browser               # DOM tests in headless Firefox (throwaway profile)
    python3 scripts/preview.py        # headless screenshots in dist/preview/ (throwaway profile)

Before pushing: the scan reads files from the working tree, so commit (or stash) first, then run `python3 scripts/check_private.py` (patterns stay outside the repo in `~/.config/foxy/scan-patterns.txt`).

## Sign and install

1. Create an API key at https://addons.mozilla.org/developers/addon/api/key/ and save it.
   In zsh (the macOS default shell):

       mkdir -p ~/.config/liquidfox-newtab && chmod 700 ~/.config/liquidfox-newtab
       read -r "ISSUER?JWT issuer: "
       read -rs "SECRET?JWT secret: "; echo
       ( umask 077; printf 'AMO_JWT_ISSUER=%s\nAMO_JWT_SECRET=%s\n' "$ISSUER" "$SECRET" > ~/.config/liquidfox-newtab/amo.env )
       unset ISSUER SECRET

2. Bump `version` in `extension/manifest.json` for every new release, then:

       python3 scripts/build.py && python3 scripts/sign.py

3. In Firefox: about:addons → gear → Install Add-on From File →
   `dist/foxy-<version>-signed.xpi`. Click "Keep changes" when Firefox asks
   about the new tab page and the home page.

The add-on is unlisted: signed by Mozilla, never published.

## Undo

Remove the add-on in about:addons. Firefox's own new tab page and home page come back.
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

Google Sans Flex and Cascadia Mono are under the SIL Open Font License. The fonts
and their licence files are bundled in `extension/fonts/`; see
`GoogleSansFlex-OFL.txt`, `GoogleSansFlex-TRADEMARKS.md` and `CascadiaMono-OFL.txt`
there. Cascadia Mono is declared as `"Foxy Mono"` for later monospace use;
Google Sans Flex is `"Foxy Sans"`. Its roundness axis stays at the default 0.
