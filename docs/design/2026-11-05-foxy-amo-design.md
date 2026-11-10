# Foxy on addons.mozilla.org: design

Date: 2026-11-05. Approved by the user:
- "yep looks good" for the plan: AMO listing, the name "Foxy Board", and moving existing installs to AMO;
- "We should 100% minify it though before shipping and provide a separate source code listing", for minification and source submission.

This spec extends `2026-11-04-foxy-public-design.md` §5. Where the two differ, this one wins.

## 1. Outcome

- Foxy 4.2.0 is the first **listed** AMO version, named **Foxy Board**, with a store page.
- The shipped add-on is **minified**. Mozilla gets the exact source for every version, and every GitHub release carries the same source archive.
- Installs from GitHub (4.1.0) move to AMO updates automatically.
- The theme and the agent helper stay on GitHub. The store page links to them.

## 2. Minified build

- **Tool:** esbuild, a pinned exact version, as the only devDependency.
  - `package-lock.json` is committed.
  - Every `resolved` URL in it must point to `https://registry.npmjs.org/`. This Mac's npm uses an internal feed, so rewrite the URLs, and add a test that fails on any other host.
  - No `.npmrc` is committed.
- **`python3 scripts/build.py`** does the build:
  1. It needs `node_modules`. Without it, it prints "Run `npm ci` first" and exits non-zero.
  2. Bundle and minify three entry points into `build/extension/`:
     - `src/main.js` → `newtab.js`;
     - `src/options.js` → `options.js`;
     - `background.js` → `background.js`.
     - Settings: `format: esm`, `bundle`, `minify`, `target: firefox140`, `charset: utf8`, `legalComments: none`. There is no third-party JS, so there are no notices to keep.
     - No source maps in the package.
  3. Minify `newtab.css` with esbuild into the same name.
  4. Copy the HTML files. Rewrite their `<script type="module" src="src/…">` to point to the bundle. Remove whitespace only between tags, by a simple, tested rule, or leave the HTML as is.
  5. Copy `manifest.json`, `icons/` and `fonts/` (licence files included), unchanged.
  6. Zip `build/extension/` into `dist/foxy-<version>.zip` with the existing fixed timestamps.
- **`build/` is ignored by git.** Tests and browser tests keep importing the unbuilt `extension/src`.
- **Pin rename:** the `executeScript` function in `sync/names.js` must still work after bundling. Add a test that loads the **built** `newtab.js` or `background.js` bundle, takes the serialized title-keeper function and runs it alone. Or add a smoke step that renames a pin using the built add-on. Pick whichever is reliable.
- **Smoke tests:** `scripts/smoke_firefox.py`, `smoke_tab_switch.py` and `smoke_agent.py` install `build/extension/`, not `extension/`, and run `build.py` first if the build is missing or stale. CI runs `npm ci` before `npm test`.
- **Reproducible:**
  - Building twice gives byte-identical zips.
  - A build from the source archive (§3), unpacked anywhere, gives the same zip.
  - A test checks the first; the release workflow checks the second.

## 3. Source code for reviewers

- **`scripts/source_archive.py <tag>`** writes `dist/foxy-<version>-source.zip`, using `git archive` of the tag (tracked files only). It includes `docs/amo/BUILD.md`.
- **`docs/amo/BUILD.md`** (reviewer instructions, at most 20 lines):
  - requirements: Ubuntu 24.04 or macOS, Node 22 LTS or newer with npm, Python 3.10 or newer;
  - steps: `npm ci`, then `python3 scripts/build.py`;
  - the result: `dist/foxy-<version>.zip`, byte-identical to the submitted file. Unpacked, it matches `build/extension/`;
  - the readable source is in `extension/`; the repository URL.
- **AMO:** the source archive is uploaded with each listed version, through the API's `source` field.
- **GitHub:** each release attaches the source archive. README Develop gets one line: "Store builds are minified; every release has a source archive and `docs/amo/BUILD.md` rebuilds it."

## 4. Listed channel and pipeline

- **No `update_url`:** remove it from `extension/manifest.json`. Mozilla's validator rejects it for AMO-hosted add-ons (addons-linter `MANIFEST_UPDATE_URL`).
- **`scripts/sign.py`** takes `--channel listed|unlisted` (default `listed`) and `--source PATH`.
  - For listed versions it uploads, creates the version with the source, then polls until the file is signed and public, or until `--wait` minutes have passed.
  - It writes the signed XPI and a status file (`signed`, `pending` or `rejected`).
  - Secrets are never printed, as today.
- **`scripts/amo_listing.py`** syncs the listing from `docs/amo/listing.json` through the AMO API v5:
  - the name "Foxy Board", summary, description, categories, homepage, support URL and licence (MIT);
  - the screenshots in `docs/images/`.
  - It is idempotent: it changes only fields that differ.
  - Check the AMO API documentation (mozilla.github.io/addons-server, Add-ons and Versions APIs) for the field names. Note any field the API can't set, such as the privacy policy, in `docs/amo/MANUAL.md`, with the exact Developer Hub steps.
- **`.github/workflows/release.yml`**, on a `v*` tag:
  1. Check the version; `npm ci`; `npm test`.
  2. `build.py`; build the source archive; rebuild from the unpacked source archive and compare SHA-256.
  3. Run `amo_listing.py`; run `sign.py --channel listed --source …`.
  4. If signed: write `updates.json` pointing to the **AMO file URL** (the move to AMO), then create the GitHub release with the XPI, the source zip and `updates.json`.
  5. If pending: create a **draft** GitHub release with the source zip, and end successfully with a summary line "Waiting for AMO review".
- **`.github/workflows/publish.yml`:** `workflow_dispatch` with a tag input, plus a daily schedule.
  - For each `v*` tag whose GitHub release is a draft or missing, and whose AMO version is now public, it downloads the signed file, checks the version, writes `updates.json` and publishes the release.
  - Same permissions and pinning rules as `release.yml`.
- **Updates:**
  - GitHub-installed 4.1.0 reads `updates.json` from GitHub, gets the AMO-signed 4.2.0, and from then on updates from AMO.
  - `updates.json` keeps being published, so anyone on an older GitHub build still moves over.
- **Docs:** `docs/releasing.md` is updated, in at most 20 lines.

## 5. Store listing content (`docs/amo/`)

- **`listing.json`:**
  - summary: at most 250 characters, plain, no hype;
  - description: Markdown as AMO renders it, covering what Foxy does, the board, groups and Sync, duplicate tabs, weather privacy, the optional helper and theme with GitHub links, and the permissions with why each is needed;
  - categories: Tabs, plus one more if allowed;
  - tags if the API supports them;
  - links: homepage `https://github.com/guru-irl/foxy`, support `https://github.com/guru-irl/foxy/issues`;
  - licence: MIT.
- **`privacy.md`:**
  - no data is collected;
  - weather requests go to Open-Meteo and BigDataCloud only after "Allow weather", with rounded coordinates;
  - Sync uses Firefox's own bookmarks and storage sync;
  - the native helper is local only.
- **`review-notes.md`** for Mozilla's testers:
  - how to test without the helper;
  - how to see weather, using a searched city to avoid geolocation;
  - what the nativeMessaging permission is for, and that the helper is optional and open source;
  - no account needed.
- **Writing:** apply the unslop and technical-writing skills. No em dashes.
- **Manifest name stays "Foxy".** Only the AMO listing name is "Foxy Board". The README links the store page once it exists.

## 6. Out of scope

- Font subsetting. The fonts are 5.5 MB of the 5.9 MB package; this is a later follow-up.
- Android.
- Translations.
- Submitting the theme to AMO.

## 7. Version

4.2.0, set with `scripts/release.py` at merge. The controller pushes the tag only after review.
