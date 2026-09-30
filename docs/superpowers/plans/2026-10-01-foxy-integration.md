# Foxy integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Join the board (Plan B) and bookmark sync (Plan C) into Foxy 2.1.0: a SAVED column for groups that aren't open on this device, a banner for groups that didn't come back after a restart, and the page asking the background to reconcile when it opens.

**Architecture:** The background owns the bookmark state and answers the `foxy:*` messages from Plan C Task 5. The page only asks: `refresh()` sends `foxy:saved` next to its tab reads, `buildBoard` gets the answer, `renderBoard` draws the SAVED column and the banner, and the handlers send `foxy:open-saved`, `foxy:delete-saved`, `foxy:restore-all` and `foxy:dismiss-missing`. The page never touches bookmarks itself; it only listens to bookmark events to know when to refresh.

**Tech Stack:** Plain ES modules, no build step; node --test; `npm run test:browser` (headless Firefox 157 harness from Plan B Task 1); Python 3 standard library.

**Spec:** `docs/superpowers/specs/2026-10-01-foxy-design.md` §5 (SAVED in the strip), §6 (SAVED rows), §8.4 ("can't reopen"), §8.6 (banner), §10 (errors), §12 step 3.

**Starting point:** `main` after `foxy/board` and `foxy/sync` are merged. Read `extension/src/board/model.js`, `extension/src/board/render.js`, `extension/src/main.js`, `extension/src/sync/sync.js` and the message table in `docs/superpowers/plans/2026-10-01-foxy-sync.md` Task 5 before starting; the names below are those plans' interfaces. If the merged code differs from them, follow the code and say so in the report.

## Global Constraints

- No npm or pip installs, no new dependencies.
- Never write to `/tmp`, `$TMPDIR` or `/var/tmp`; scratch, test profiles and temp dirs go under the worktree's `.spider/scratch/`.
- Never read `~/.config/liquidfox-newtab/amo.env`, never run `scripts/sign.py`, never contact addons.mozilla.org, never push or create GitHub resources, never touch the real Firefox profile.
- The page never calls `browser.bookmarks` write methods; everything that changes bookmarks goes through a `foxy:*` message to the background.
- Console messages start with `Foxy:`. Every API or message failure is caught, logged with `console.warn`, and followed by a re-read (spec §10). A background that doesn't answer (rejection or `undefined`) means "no saved groups, no banner"; the board still works.
- Visual rules (spec §5): no borders, outlines or drop shadows; neutral greys; colour only in the group dots, the drop line and the "DELETE?" confirm. SAVED header: the column-title role (as PINNED and TABS, upright). Banner text: the subheading role; its buttons: the actions role (spec §4).
- The page never closes itself from SAVED or the banner (only a tab click can close it).
- `npm test` and `npm run test:browser` pass at the end of every task.

## Review Focus

1. **Double submits.** Clicking a SAVED entry twice quickly, or RESTORE ALL twice, must open the group once. Expected: the entry or banner is disabled while its message is in flight.
2. **The confirm state across re-renders.** A live refresh while "DELETE?" is showing must keep it showing for that folder (it's UI state keyed by `folderId`, not DOM state), and moving away cancels it.
3. **Stale folders.** A SAVED entry deleted or opened on another device between render and click: the background answers `{ ok: false }`; the page logs a `Foxy:` warning and refreshes, nothing thrown.
4. **Background not ready.** `foxy:saved` rejecting (no listener yet) must not break the board or leave a stuck spinner.

---

### Task 1: SAVED column and banner (model and render)

**Files:**
- Modify: `extension/src/board/model.js`, `extension/src/board/render.js`, `extension/newtab.css`, `test/board-model.test.js` (or the Plan B model test file), `test/browser/render.test.js`
- Create: `test/browser/saved.test.js`

**Interfaces:**
- Consumes: the `foxy:saved` response shape `{ saved: [{ folderId, title, color, count, cantReopen: string[] }], missing: [{ folderId, title, color }] }` (Plan C Task 5).
- Produces:
  - `buildBoard({ ..., saved = [], missing = [] })` adds `board.saved` (same order, `title` as given, `color` an API colour) and `board.missing` to its result; everything else unchanged.
  - `renderBoard(root, board, ui, handlers)` with `ui.confirmFolderId: string|null` and `ui.busy: Set<string>` (folder ids, plus `"banner"`), and new handlers `onOpenSaved(folderId)`, `onDeleteSaved(folderId)`, `onConfirmDelete(folderId|null)`, `onRestoreAll()`, `onDismissMissing()`.
  - DOM contract (additions to Plan B's):

```html
<div class="banner" role="status">                                   (only when board.missing.length)
  <span class="banner-text">2 GROUPS DIDN'T COME BACK</span>
  <button class="banner-restore">RESTORE ALL</button>
  <button class="banner-dismiss">DISMISS</button></div>
<div id="board" class="board"> …PINNED…
  <div class="strip">
    <section class="column saved" data-zone="saved"><h2 class="column-title">SAVED</h2>   (only when board.saved.length)
      <div class="rows" data-zone="saved">
        <div class="row saved-row" role="button" tabindex="0" data-folder-id="f1" data-color="red">
          <span class="dot"></span><span class="row-label">Dev server</span>
          <span class="saved-count">4</span>
          <span class="cant-reopen" title="about:config&#10;file:///x">1 CAN'T REOPEN</span>   (only when cantReopen.length)
          <button class="saved-delete" aria-label="Delete saved group" tabindex="-1">×</button></div>
      </div></section>
    …group columns… + NEW GROUP
  </div> …TABS…
</div>
```

Behaviour and look:
- The banner sits between the date and the board, centred, as a glass pill (the card glass at the near-opaque level used where text sits), 8px 16px padding, a `·` separator (faint) between the text and each button. The text says `1 GROUP DIDN'T COME BACK` or `N GROUPS DIDN'T COME BACK`.
- The SAVED column is the first column of `.strip`, before the group columns, 264px like the others. It is not draggable and is not a drop target for tabs or columns (Plan B's `attachDnd` must ignore `data-zone="saved"`: no indicator, `dropEffect = "none"`).
- A SAVED row is 32px: the 12px dot in the group colour (glow as the header dots), the name in the default font (an empty title shows "UNNAMED" at `--text-muted`), the bookmark count faint and tabular on the right, and the × on hover or focus.
- `.cant-reopen` is faint, actions role, after the count; its `title` lists the URLs one per line.
- With `ui.confirmFolderId === folderId` the × is replaced by a `DELETE?` pill: actions role, text in the red palette colour (`--g2` of `data-color="red"`) on a faint fill. The row also gets `.confirming`.
- Rows and the banner whose id is in `ui.busy` get `.busy` (opacity 0.5, `pointer-events: none`).
- Keyboard: Enter or Space on a SAVED row opens it; Delete or Backspace on a focused row asks for confirmation (`onConfirmDelete(folderId)`), and Enter on the `DELETE?` pill confirms.

- [ ] **Step 1: Failing tests.**
  - Node (`buildBoard`): `saved` and `missing` pass through in order; defaults are empty arrays; the rest of the board is unchanged for the same inputs (deep-equal against a call without them).
  - Browser (`test/browser/saved.test.js`, `render.test.js`):
    - no SAVED column and no banner when both lists are empty;
    - SAVED is the first column in `.strip` and PINNED/TABS stay in place;
    - row data attributes, count, "UNNAMED", the `cant-reopen` text and title;
    - the banner text for 1 and 3 missing groups;
    - `confirmFolderId` shows `DELETE?` only on that row;
    - `busy` disables the row and the banner;
    - no border, outline or box-shadow on the banner, the SAVED column and its rows (`getComputedStyle`), and the SAVED header is upright while group titles stay oblique.
- [ ] **Step 2: Run `npm test` and `npm run test:browser`; expect the new tests to fail.**
- [ ] **Step 3: Implement** the model fields, the render code and the CSS.
- [ ] **Step 4: Run both commands; expect a pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat: SAVED column and missing-groups banner on the board"`

### Task 2: Controller wiring, messages and reconcile on open

**Files:**
- Modify: `extension/src/main.js`, `extension/src/board/dnd.js` (ignore the saved zone), `test/browser/dnd.test.js`
- Create: `test/browser/integration.test.js`

**Interfaces:**
- Consumes: Task 1; the controller from Plan B (`refresh()`, the generation counter, deferral during drags and edits); `createSync` from Plan C (tests only).
- Produces: the controller behaviour below.

Behaviour:
- **On page load**, once: send `{ type: "foxy:reconcile" }` without awaiting it before the first render, then `refresh()`. When it resolves, `refresh()` again.
- **`refresh()`** also sends `{ type: "foxy:saved" }` in parallel with its tab reads and passes `saved` and `missing` to `buildBoard`. A rejection or an answer without arrays counts as empty lists and logs one `Foxy:` warning per page load, not per refresh.
- **Events:** besides Plan B's tab, group and window events, listen to `bookmarks.onCreated`, `onChanged`, `onMoved` and `onRemoved` and schedule a refresh (the same one-per-frame scheduler, the same deferral during drags and edits).
- **Handlers:**
  - `onOpenSaved(folderId)`: add `folderId` to `ui.busy`, send `{ type: "foxy:open-saved", folderId, windowId: currentWindowId }`, then remove it from `busy` and `refresh()`. A second call while busy is ignored.
  - `onConfirmDelete(folderId|null)`: set `ui.confirmFolderId` and re-render (no API call). The row's `mouseleave`, its `blur` (focus leaving the row and its pill) and Escape call `onConfirmDelete(null)`.
  - `onDeleteSaved(folderId)`: only when `ui.confirmFolderId === folderId`; busy as above; send `{ type: "foxy:delete-saved", folderId }`; clear the confirm; `refresh()`.
  - `onRestoreAll()`: busy `"banner"`; send `{ type: "foxy:restore-all", windowId: currentWindowId }`; `refresh()`.
  - `onDismissMissing()`: busy `"banner"`; send `{ type: "foxy:dismiss-missing" }`; `refresh()`.
  - `{ ok: false }` or a rejection: `console.warn("Foxy: …")`, clear busy, `refresh()`.
- The group header × (`onCloseGroup`) is unchanged; the background keeps the folder, so the group shows up in SAVED on the next refresh.

- [ ] **Step 1: Failing browser tests** (`test/browser/integration.test.js`). Each test builds `createFirefox()` with bookmarks, starts `createSync({ api: ff.browser, settleMs: 0, maxWaitMs: 0, removeDelayMs: 0, quietMs: 0 })` in the page as the "background" (register `sync.onMessage` as the `runtime.onMessage` listener and its event handlers as in `background.js`), then starts the controller on the same fake:
  - a folder not open here shows in SAVED; clicking it opens the group in the current window (fake layout) and the entry disappears;
  - two quick clicks open it once;
  - × then `DELETE?` removes the folder (the fake's bookmark tree) and the entry; `mouseleave` between the two clicks cancels (no removal);
  - closing a group with the header × keeps its folder and shows it in SAVED;
  - after `ff.restart({ restore: false })` and a new controller, the banner shows the right count; RESTORE ALL reopens every group and hides the banner; DISMISS hides it and keeps the SAVED entries;
  - a bookmark change (`applyRemoteBookmarks` renaming a saved folder) refreshes the entry's name;
  - `foxy:saved` rejecting (no background registered): the board renders, no SAVED column, one `Foxy:` warning;
  - `foxy:reconcile` is sent once on load (the fake's `calls`).
  - `dnd.test.js`: a tab or column drag over the SAVED column shows no indicator and its drop calls nothing.
- [ ] **Step 2: Run `npm run test:browser`; expect failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test` and `npm run test:browser`; expect a pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat: the board asks the background for saved groups and restores missing ones"`

### Task 3: Previews, README and version 2.1.0

**Files:**
- Modify: `preview/fixtures.js`, `preview/fake-browser.js`, `scripts/preview.py`, `extension/manifest.json`, `test/manifest.test.js`, `README.md`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: preview scenarios `saved` (`one-window` plus 3 saved folders, one with a `cantReopen` URL, one unnamed) and `banner` (`saved` plus 2 missing groups); version 2.1.0.

Details:
- `preview/fake-browser.js` answers `foxy:saved` for the scenario from fixture data (no `createSync` in previews).
- `scripts/preview.py` adds `saved` and `banner` at 1600×1000.
- Manifest: version `2.1.0`; description `"A kanban board of your tabs and tab groups, shared across devices through bookmarks."`
- README:
  - what Foxy does (board, SAVED, the `Other Bookmarks/Foxy` folder and Sync);
  - the one-time bookmarks permission prompt on update;
  - "Checking it in Firefox": drag between windows, a pin moving here, column drag, bookmarks appearing under `Other Bookmarks/Foxy`, a second device via Sync, a restart with session restore off (the banner), and deleting a saved group.

- [ ] **Step 1: Failing tests:** the manifest test expects `2.1.0` and the new description; `scripts/test_preview.py` (or the existing preview test) expects the two new scenario names.
- [ ] **Step 2: Run `npm test`; expect failure.**
- [ ] **Step 3: Implement.** Run `python3 scripts/preview.py saved banner` and pixel-check: the SAVED header's capitals and a saved row's dot are vertically centred on the row, and the banner's text baseline is centred in the pill (±0.5px at 1x). Record the rows.
- [ ] **Step 4: Run `npm test`, `npm run test:browser` and `python3 scripts/check_private.py`; expect a pass and `clean`.**
- [ ] **Step 5: Commit** — `git commit -m "feat: Foxy 2.1.0 previews and README"`
