# Foxy goes public: design

Date: 2026-11-04. Status: approved by the controller under the user's "full autonomy" directive. The user asked: "this should be the foxy logo. Let's start work to get this ready to be public. Once it's public we should be able to setup a release pipeline".

Making the repository public, and anything else visible to the public, happens only after the user says go. This work prepares everything up to that point.

## 1. Audit results (2026-11-04)

- **History:** all 275 commits were scanned, and every file version, with the private pattern list in `~/.config/foxy/scan-patterns.txt`. There are no hits.
- **Vendor words:** the only ones are public product names (Teams, Outlook, Azure, Microsoft 365 Copilot), used by the theme's pinned-tab labels, plus the Cascadia Mono OFL copyright line. That is acceptable.
- **Personal data in the history:**
  - an absolute home path in old plans and the skill;
  - the profile folder ID in two plans;
  - the author email, which is the user's chosen public identity.
- **History decision:** keep the history and scrub the tree in new commits. The leftover paths are low risk.
- **Theme origin:** `theme/userChrome.css` derives from [miloszfalinski/liquid-fox](https://github.com/miloszfalinski/liquid-fox), MIT, "Copyright (c) 2025 Milosz". The licence requires keeping that notice.
- **Fonts:** Google Sans Flex, Cascadia Mono and EB Garamond are OFL 1.1. Their licence files are already bundled next to each copy.

## 2. Logo

The logo is a rounded square filled with a diagonal gradient. It comes from the user's screenshot of 2026-11-04, and its colours were sampled from that screenshot.

- **Shape:** a square with corner radius 22 % of its side (a plain `rx`, not a superellipse). There is no inner mark, outline or shadow.
- **Gradient:** runs from the bottom left (0 %) to the top right (100 %):

  | Stop | Colour |
  |---|---|
  | 0 % | `#9043DF` |
  | 25 % | `#C61FA4` |
  | 40 % | `#EB2F76` |
  | 52 % | `#FA385B` |
  | 72 % | `#FF7449` |
  | 100 % | `#FFC243` |

- **Files:**
  - `extension/icons/foxy.svg`, with `viewBox="0 0 64 64"`. The square fills the view box minus 2 units of padding on each side, so it doesn't touch the edge in about:addons.
  - `docs/images/logo.svg`, a copy at the same size, for the README.
- **Manifest:** `"icons": {"48": "icons/foxy.svg", "96": "icons/foxy.svg"}`. Firefox accepts SVG icons.
- **New tab page:** the new tab page gets no favicon. The tab stays neutral, as the user's taste asks.
- **Checks:** a unit test checks the manifest icons, and that the SVG parses and contains exactly these stops. A headless render at 48 px and 96 px is compared by eye against the screenshot.

## 3. Licences and credit

- **Root `LICENSE`:** MIT, "Copyright (c) 2026 Guru". It covers everything not listed below.
- **`theme/LICENSE`:** the upstream Liquid Fox MIT notice, verbatim, plus one line saying our changes are also MIT under the root licence.
- **Fonts:** keep their OFL files. `package.json` gets `"license": "MIT"` and `repository`.
- **README Credits section:**
  - Liquid Fox by Milosz Falinski;
  - Google Sans Flex, Cascadia Mono and EB Garamond under OFL 1.1;
  - weather data from Open-Meteo and BigDataCloud.

## 4. Repository cleanup

- **Design docs:**
  - delete the old plans directory, which holds process logs with absolute paths;
  - move the specifications to `docs/design/`;
  - fix every link to them.
- **Scrubbing:**
  - Replace absolute home paths and profile IDs in tracked files with `~/...` or `<profile>`.
  - Keep `check_private.py`. Document it as an optional local pre-push check that reads a private pattern file, with no patterns in the repo.
- **Fixtures and renders:**
  - Use generic group names: Reading, Work, Travel, Recipes, Research, Side project, Music, Photos.
  - Use a generic weather place: Lisbon.
  - Don't use the user's real group titles or city.
  - Tests may keep internal names only where a test asserts them, and should rename where cheap.
- **Manifest:** the description becomes "A board of your tabs, tab groups and pinned tabs, saved as bookmarks and synced across devices." The old "grid" wording is out of date.
- **README:**
  - Rewrite it for strangers, with short bullets and no "private":
    1. a logo header;
    2. one paragraph on what Foxy is;
    3. two board screenshots, dark and light, made from the fixtures by `scripts/preview_v40.py` and stored in `docs/images/`;
    4. Install, from GitHub Releases;
    5. Board, Settings, Pinned tab names, Duplicate tabs, Saved groups and Sync, Permissions and privacy, Limits, Agents, Theme, Develop;
    6. Credits and Licence.
  - Keep the content of the existing sections, trimmed. Say plainly:
    - the theme is macOS-first;
    - the helper is macOS and Linux only;
    - Foxy collects no data;
    - weather requests happen only after "Allow weather".
- **No mockups or images of the user's real browser.**

## 5. Release pipeline

Distribution is self-hosted: GitHub Releases carry AMO-signed unlisted XPIs, plus an update manifest so installed copies update themselves. An AMO listing is out of scope.

- **Manifest:** `browser_specific_settings.gecko.update_url` is set to `https://github.com/guru-irl/foxy/releases/latest/download/updates.json`.
  - Before relying on it, check Firefox's own update checker in the extracted omni sources, e.g. `AddonUpdateChecker.sys.mjs` (`~/.pi/agent/spider/scratch/liquidfox/omni*`). It must follow HTTPS redirects and must not require a JSON content type.
  - If it doesn't, use `https://raw.githubusercontent.com/guru-irl/foxy/main/updates.json`, committed by the release job.
- **`updates.json`:** `{"addons": {"{4408f971-7930-41ea-9f93-b01231e40861}": {"updates": [{"version", "update_link", "update_hash": "sha256:…"}]}}}`.
  - `update_link` is the release asset URL for that tag.
  - It is generated by `scripts/update_manifest.py`, which has unit tests.
- **`scripts/sign.py`:** reads `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` from the environment first, then falls back to the existing file. It never prints them.
- **`scripts/release.py X.Y.Z`:**
  - sets the version in the manifest, `package.json`, `test/manifest.test.js` and the README version line;
  - runs `npm test`;
  - commits "Release X.Y.Z" and creates the annotated tag `vX.Y.Z`.
  - It does not push. The user or controller pushes the tag.
  - It refuses a dirty tree, a version that isn't higher, or an existing tag.
- **`.github/workflows/release.yml`**, triggered by a `v*` tag push:
  1. Check that the tag equals the manifest version.
  2. Run `npm test`.
  3. Run `python3 scripts/build.py`.
  4. Sign, using `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` from a `release` environment.
  5. Compute SHA-256.
  6. Run `update_manifest.py`.
  7. Run `gh release create vX.Y.Z` with `foxy-X.Y.Z.xpi`, `updates.json`, and notes from the tag annotation or the commit log since the last tag.
  - Permissions: `contents: write` only. Third-party actions are pinned by full SHA. There's no `pull_request_target`.
  - Browser tests are not needed in CI; they stay local gates, as today.
- **Inert until set up:** without the secrets, the sign step fails with a clear message and nothing is published.
- **User actions after the repo is public:**
  - create the `release` environment and add the two secrets. The controller may run `gh secret set` from `amo.env` without printing the values, but only once the user says go.
- **Installed copies:**
  - 4.0.0 has no `update_url`, so the user installs the first pipeline release (4.1.0) by hand once;
  - later releases update automatically.
- **`docs/releasing.md`:** the steps above in at most 15 lines.

## 6. Out of scope

- An AMO listing.
- Translations.
- Windows helper memory.
- A GitHub social preview image (the user can upload `docs/images/logo.svg` rendered to PNG).
- Issue templates.

## 7. Version

4.1.0. The controller sets it when merging both parts, using `scripts/release.py` once it exists.
