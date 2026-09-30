# Liquid Fox New Tab

A private Firefox add-on for the Liquid Fox theme. It replaces the new tab page and
the home page with a clock (Danfo), the date (Bebas Neue), this window's pinned tabs
and its tab groups. Clicking a tab switches to it; a fresh new tab page with no Back
history also closes.

After a click on a page with no Back history, the page switches to the tab, blanks its
own tab and closes it, so it stays out of Recently Closed Tabs (as Firefox's own new
tab page does). Closing the page with Cmd+W still adds a "New Tab" entry. When the page
has Back history (for example, after using the Home button in an existing tab), it
switches without closing. No `sessions` permission is needed; the add-on keeps nothing
and sends nothing.

Design: `docs/superpowers/specs/2026-09-30-newtab-design.md`.

## Develop

    npm test                          # node --test and the Python tests; no npm packages
    python3 scripts/preview.py        # headless screenshots in dist/preview/ (throwaway profile)

## Sign and install

1. Create an API key at https://addons.mozilla.org/developers/addon/api/key/ and save it.
   In zsh (the macOS default shell):

       mkdir -p ~/.config/liquidfox-newtab && chmod 700 ~/.config/liquidfox-newtab
       read -r "ISSUER?JWT issuer: "
       read -rs "SECRET?JWT secret: "; echo
       ( umask 077; printf 'AMO_JWT_ISSUER=%s\nAMO_JWT_SECRET=%s\n' "$ISSUER" "$SECRET" > ~/.config/liquidfox-newtab/amo.env )
       unset ISSUER SECRET

2. Bump `version` in `manifest.json` for every new release, then:

       python3 scripts/build.py && python3 scripts/sign.py

3. In Firefox: about:addons → gear → Install Add-on From File →
   `dist/liquidfox-newtab-<version>-signed.xpi`. Click "Keep changes" when Firefox asks
   about the new tab page and the home page.

The add-on is unlisted: signed by Mozilla, never published.

## Undo

Remove the add-on in about:addons. Firefox's own new tab page and home page come back.
If you removed the address-bar rule after installing, restore it in your Firefox
profile's `chrome/userChrome.css` (section 5) from
`chrome/userChrome.css.bak-before-newtab` (made right before the rule is removed).

## Licences

Danfo and Bebas Neue are under the SIL Open Font License; see `fonts/*-OFL.txt`.
