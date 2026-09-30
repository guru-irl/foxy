# Foxy theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the browser theme (userChrome.css, userContent.css, user.js) in the repo with an install script that symlinks it into the Firefox profile, switch the theme to Google Sans Flex (monospace for code-like text), and add the private-name check and CI.

**Architecture:** `theme/` holds the three files; `theme/fonts` is a relative symlink to `../extension/fonts` (the fonts arrive there from the base plan). `scripts/install_theme.py` replaces the profile's files with symlinks after backing them up. CSS is edited only in the "LOCAL OVERRIDES" section of `userChrome.css` and in `userContent.css`.

**Tech Stack:** CSS for Firefox 157 chrome, Python 3 standard library, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-01-foxy-design.md` (§3 Repository, §4 Typography).

## Global Constraints

- No npm or pip installs, no new dependencies.
- Never write to `/tmp`, `$TMPDIR` or `/var/tmp`. Scratch and test temp dirs go under the worktree's `.spider/scratch/` (tests create them there with `tempfile.TemporaryDirectory(dir=...)`).
- The real Firefox profile `/Users/guru/Library/Application Support/Firefox/Profiles/uc83r8ou.default-release` may be **read** (Task 1 copies files from it) but never written; `install_theme.py` is never run against it.
- Never read `~/.config/liquidfox-newtab/amo.env`, never run `scripts/sign.py`, never contact addons.mozilla.org, never push or create GitHub resources.
- Visual rules: no borders, outlines or drop shadows; neutral greys; font roundness (ROND) stays 0; only group titles are slanted.
- Firefox reads userChrome.css only at startup; nobody can check the theme in real Firefox during this plan, so correctness rests on tests, the balance check and headless replicas.
- After every CSS edit, run the balance check: with comments stripped, braces balance and never go negative, parentheses balance, double quotes are even, and no stray `/*` or `*/` is left.
- No company-internal names in any file.
- `npm test` must pass at the end of every task.

## Review Focus

1. The default-font rule leaking into places that must stay monospace: address-bar URLs, dropdown URLs, the link status line. Also DevTools, which is why the default rule is limited to `browser.xhtml`.
2. The install script with an existing symlink, a missing `chrome/` directory, `chrome/fonts` as a real directory, or run twice: nothing is lost, and a second run changes nothing.
3. `profiles.ini` variants: the `[Install…]` `Default=` entry, a `[Profile…]` with `Default=1`, relative and absolute paths.
4. Relative `url("fonts/…")` in the theme: it must work whether Firefox resolves it against the profile's `chrome/` or against the symlink's target `theme/`. That's why `theme/fonts` exists.
5. The group-label dot and the capitals drifting apart after the font change (pixel rows must match in the replica).

---

### Task 1: Theme files in the repo and `install_theme.py`

**Files:**
- Create: `theme/userChrome.css`, `theme/userContent.css`, `theme/user.js`. Copy them byte-for-byte from the profile's `chrome/userChrome.css`, `chrome/userContent.css` and `user.js`.
- Create: `theme/fonts`, a relative symlink `../extension/fonts` (it dangles until the base plan's fonts are merged, and that's expected).
- Create: `scripts/install_theme.py`, `scripts/test_install_theme.py`
- Modify: `README.md` (a "Theme" section)

**Interfaces:**
- Produces:
  - `find_profile(firefox_dir: Path) -> Path`
  - `install(repo: Path, profile: Path, now: datetime) -> list[str]`, which returns one human-readable line per action.
  - CLI `python3 scripts/install_theme.py [--profile PATH] [--firefox-dir PATH]`. The default Firefox dir is `~/Library/Application Support/Firefox`.

Links made by `install` (the targets are absolute paths into the repo):

| In the profile | Points to |
|---|---|
| `chrome/userChrome.css` | `<repo>/theme/userChrome.css` |
| `chrome/userContent.css` | `<repo>/theme/userContent.css` |
| `chrome/fonts` | `<repo>/extension/fonts` |
| `user.js` | `<repo>/theme/user.js` |

- [ ] **Step 1: Failing tests** in `scripts/test_install_theme.py`. Each builds a fake Firefox dir under `.spider/scratch/`.
  - `find_profile` prefers the `[Install…]` section's `Default=Profiles/abc.default-release`, relative to the Firefox dir.
  - With no Install section it uses the `[Profile…]` with `Default=1`, honouring `IsRelative=0` absolute paths.
  - Without a `profiles.ini` it raises `SystemExit` with a message naming the file.
  - `install` on a profile that has real `userChrome.css`, `userContent.css`, `fonts/` and `user.js`:
    - Moves each into `chrome/backup-20261001-020304/`, for `now = datetime(2026, 10, 1, 2, 3, 4)`. `user.js` is backed up as `chrome/backup-…/user.js`.
    - Creates the four links, checked with `os.readlink` equal to the absolute targets.
    - Returns one line per moved file and per link.
  - A second `install` returns `[]`, creates no new backup dir and leaves the links unchanged.
  - A profile with no `chrome/` gets one created. Links are made and no backup dir is created.
  - An existing symlink pointing somewhere else is moved into the backup (as a symlink) and replaced.
- [ ] **Step 2: Run `python3 -m unittest scripts/test_install_theme.py`; expect it to fail.**
- [ ] **Step 3: Implement** `scripts/install_theme.py` (standard library only: `configparser`, `pathlib`, `os`, `shutil`, `argparse`). The CLI prints the returned lines, then `Restart Firefox (quit with Cmd+Q and reopen) to load the theme.`. Copy the three theme files and create the `theme/fonts` symlink with `ln -s ../extension/fonts theme/fonts`.
- [ ] **Step 4: Run `npm test`; expect everything to pass.**
- [ ] **Step 5: Add the README "Theme" section.** It covers what the theme is, running the script, where the backups go, and undoing it by deleting the links and moving the backup files back. Then commit: `git commit -m "feat: theme files in the repo and an install script that links them into the profile"`

### Task 2: Google Sans Flex in the theme

**Files:**
- Modify: `theme/userChrome.css` (LOCAL OVERRIDES section only), `theme/userContent.css`
- Create: `scripts/test_theme.py`

**Interfaces:**
- Consumes: the font files `extension/fonts/GoogleSansFlex.ttf` and `extension/fonts/CascadiaMono.ttf` (names fixed by the base plan). They're reached through `chrome/fonts/…`.
- Produces: font families `"Foxy Sans"` and `"Foxy Mono"` in the theme (the same names the page uses).

Settings (spec §4):

| Where | Settings |
|---|---|
| Every element of the main browser window | `font-family: "Foxy Sans", system-ui, sans-serif !important`, via `:where(*)` (zero specificity) inside `@-moz-document url("chrome://browser/content/browser.xhtml") { … }`. Other chrome documents (DevTools) are untouched. |
| Sidebar group names (`.tab-group-label`) | `"Foxy Sans"`, weight 800, `font-stretch: 50%`, `font-style: oblique 10deg`, `letter-spacing: 0` (replaces Bebas Neue) |
| Sidebar pinned names (`#pinned-tabs-container … .tab-label`, including the YOUTUBE/GMAIL `::before`) and the "SEARCH" placeholder (in both files) | Same, but upright |
| Monospace: address-bar URL (existing rule), `.urlbarView-url`, `.urlbarView-title[is-url]`, and `#statuspanel-label` (new) | `"Foxy Mono", "Cascadia Mono", ui-monospace, monospace !important`, ligatures off (keep the existing `font-variant-ligatures`/`font-feature-settings`) |

- `@font-face` in both files: `"Foxy Sans"` with `src: url("fonts/GoogleSansFlex.ttf") format("truetype")`, `font-weight: 1 1000`, `font-stretch: 25% 151%`, `font-style: oblique 0deg 10deg`; `"Foxy Mono"` with `url("fonts/CascadiaMono.ttf")`, `font-weight: 200 700`. Remove the "LiquidFox Bebas" `@font-face` blocks and every Bebas reference, including comments. Rewrite comments that explain Bebas metrics so they explain Google Sans Flex's.
- Label size and centring: `--lf-label-size` makes the capitals exactly 12px, the dot's size. Google Sans Flex's cap height is 0.716em at the default optical size, but measure it at the label's weight, width and slant. The dot keeps hanging off the baseline (`vertical-align: calc(<cap/2 in em> - var(--lf-group-dot) / 2)`), and the label's 1px `top` nudge is recomputed for the new ascent and descent (Google Sans Flex: upm 2000, ascent 1932, descent 572, line gap 0). Settle both with a headless replica: an HTML page in `.spider/scratch/` that copies the label's box (32px `line-height`/`min-height`, the same padding, dot and font rules). Screenshot it with `firefox --headless --no-remote -profile <scratch profile> --screenshot`, then measure pixel rows (`sips -s format bmp` plus Python). The dot's first and last rows must equal the capitals' first and last rows, and both must be centred in the 32px row within 0.5px. Record the numbers in the report.

- [ ] **Step 1: Failing tests** in `scripts/test_theme.py`:
  - Neither theme file contains `Bebas` (case-insensitive).
  - Both contain the two `@font-face` blocks, with the exact `url()`s and ranges above.
  - `userChrome.css` passes the balance check.
  - The `:where(*)` default-font rule sits inside `@-moz-document url("chrome://browser/content/browser.xhtml")`.
  - The monospace rule's selector list includes `#statuspanel-label`, `.urlbarView-url` and `.urlbarView-title[is-url]`.
  - The group-label rule has `oblique 10deg`, and the pinned-name rule has no `oblique`.
  - No `font-variation-settings` in either file sets `"ROND"` above 0.
- [ ] **Step 2: Run `python3 -m unittest scripts/test_theme.py`; expect it to fail.**
- [ ] **Step 3: Implement** the CSS changes, then run the replica measurement and set the final `--lf-label-size`, dot `vertical-align` and `top` values.
- [ ] **Step 4: Run `npm test`; expect everything to pass.** Run the balance check and record its output.
- [ ] **Step 5: Commit** — `git commit -m "feat: Google Sans Flex across the browser UI, monospace for URLs"`

### Task 3: `check_private.py` and CI

**Files:**
- Create: `scripts/check_private.py`, `scripts/test_check_private.py`, `.github/workflows/test.yml`
- Modify: `README.md` (one "Before pushing" line)

**Interfaces:**
- Produces: `scan(repo: Path, patterns: list[re.Pattern]) -> list[str]`, returning hits formatted as `"<path>:<line>: <pattern>"` and `"commit <short-sha>: <pattern>"`. CLI: `python3 scripts/check_private.py [--patterns PATH]`, with default `~/.config/foxy/scan-patterns.txt`. Exit 0 when clean, 1 on hits (each printed), 2 when the patterns file is missing.

- Patterns file format: one Python regex per line; blank lines and lines starting with `#` are ignored. The patterns never go into the repo, the tests or the logs. Tests use their own made-up patterns such as `(?i)secretcorp`.
- Scanned: every file from `git ls-files` (binary files are skipped: a NUL byte in the first 8000 bytes), every commit message on all branches (`git log --all --format=%h%x00%B%x00`), and branch names.
- CI: `on: [push, pull_request]`, `ubuntu-latest`, `actions/checkout@v4`, `actions/setup-node@v4` with `node-version: 24`, `actions/setup-python@v5` with `python-version: "3.12"`, then `npm test`. Tests that make git repos set `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL` in their subprocess environment.

- [ ] **Step 1: Failing tests** (temp git repos under `.spider/scratch/`):
  - A tracked file line matching the pattern is reported with its path and line number.
  - Untracked files are ignored.
  - A binary file containing the word is skipped.
  - A commit message match is reported as `commit <sha>`.
  - A missing patterns file makes the CLI exit 2.
  - A clean repo exits 0 and prints `clean`.
- [ ] **Step 2: Run them; expect them to fail.**
- [ ] **Step 3: Implement** `check_private.py` and the workflow file.
- [ ] **Step 4: Run `npm test`; expect everything to pass.** Also run `python3 scripts/check_private.py` in the worktree (the real patterns file exists on this machine); expect `clean`. Don't print the patterns.
- [ ] **Step 5: Commit** — `git commit -m "chore: private-name check before pushing, CI runs the tests"`
