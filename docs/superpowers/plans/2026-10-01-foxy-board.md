# Foxy board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the new tab page's pinned strip and group cards with the kanban board of spec §5–§7: PINNED, group columns from every window, "+ NEW GROUP" and TABS. It gets drag and drop, cross-window moves, pins that follow you, new groups, rename, colour, close, and column drag.

**Architecture:** Pure modules decide (`board/model.js` builds the board, `board/targets.js` turns a drop slot into a target). `board/moves.js` executes targets against the WebExtension API with fresh reads and a membership correction step. `board/render.js` draws the DOM, `board/dnd.js` wires drag events, and `board/edit.js` handles inline editors. `main.js` is the controller: it reads state, renders, re-renders on events (deferred while dragging or editing) and routes UI handlers to `moves.js`. Everything takes an injected `api` (the `browser` object), so Node tests use `createFirefox()` from `test/fakes/firefox.js`. DOM tests run in real headless Firefox through a small harness.

**Tech Stack:** Plain ES modules, no build step; node --test; Python 3 standard library; headless Firefox 157.

**Spec:** `docs/superpowers/specs/2026-10-01-foxy-design.md` (§4 Typography, §5 Board layout, §6 Board interactions, §7 Cross-window mechanics, §10 Errors, §11 Testing).

## Global Constraints

- No npm or pip installs, no new dependencies.
- Never write to `/tmp`, `$TMPDIR` or `/var/tmp`; scratch, test profiles and temp dirs go under the worktree's `.spider/scratch/`.
- Never read `~/.config/liquidfox-newtab/amo.env`, never run `scripts/sign.py`, never contact addons.mozilla.org, never push or create GitHub resources, never touch the real Firefox profile.
- Every module in `extension/src/` takes the WebExtension API as a parameter (`api`) or reads `globalThis.browser` only in `main.js`.
- Console messages start with `Foxy:`. Every API failure is caught, logged with `console.warn` or `console.error`, and followed by a re-read (spec §10).
- Visual rules (spec §5): no borders, outlines or drop shadows; neutral greys; colour only in the group dots and the drop line. Fonts: `"Foxy Sans"`/`"Foxy Mono"` roles from spec §4. Group titles are wght 800, `font-stretch: 50%`, `font-style: oblique 10deg`, capitals, `letter-spacing: 0`. The other column titles (PINNED, TABS) are the same but upright. The clock and date are upright. Roundness stays 0.
- Colour names in the API are `blue cyan grey green orange pink purple red yellow`. `colorKey()` in `extension/src/model.js` maps them to the CSS palette keys (grey → gray).
- The page never closes itself except through a tab click (spec §6); dragging and editing never close it.
- Private windows are not shown (spec §7).
- `npm test` passes at the end of every task; from Task 1 on, `npm run test:browser` passes too.

## Review Focus

1. **A re-render in the middle of an interaction.** Tab events arrive while a drag or an inline editor is in progress. Re-rendering then would destroy the dragged element or the input. Expected: updates are deferred until the drag or edit ends, then applied once.
2. **Drops that change nothing.** A tab dropped on its own slot, or a group column dropped next to itself, must not call the API.
3. **Drops across a window boundary** in PINNED and TABS: a slot between the last row of one window's section and the first row of the next, the top of the column, and an empty column.
4. **Unnamed groups and long names.** An empty title shows "UNNAMED" faintly in the header. Long names are cut with an ellipsis and never wrap or widen the column.
5. **Stale state.** A tab closes between render and click or drop, so the API call rejects. Expected: nothing thrown to the console as uncaught, a `Foxy:` warning, and a re-read.

---

### Task 1: Headless Firefox test harness

**Files:**
- Create: `scripts/browser_test.py`, `scripts/test_browser_test.py`, `test/browser/harness.js`, `test/browser/run.html`, `test/browser/smoke.test.js`
- Modify: `package.json` (add `"test:browser": "python3 scripts/browser_test.py"`), `README.md` (one line under testing)

**Interfaces:**
- Produces:
  - `test/browser/harness.js` exports `test(name, fn)`, `assert` (`ok`, `equal`, `deepEqual`, `rejects`), `fixture()`, `dispatchDrag(type, target, { clientX, clientY, dataTransfer })`, and `nextFrame()`.
    - `fixture()` returns an empty `<div id="fixture">` that is replaced between tests.
    - `dispatchDrag` creates a real `DragEvent` with `bubbles: true, cancelable: true` and returns it.
    - `nextFrame()` resolves after one `requestAnimationFrame`.
  - Browser test files are ES modules under `test/browser/*.test.js` that import the harness and register tests at import time.
  - `python3 scripts/browser_test.py [file ...]`:
    1. Serves the worktree root on `http://127.0.0.1:<free port>/`.
    2. Launches `/Applications/Firefox.app/Contents/MacOS/firefox --headless --no-remote -profile <worktree>/.spider/scratch/browser-test-profile http://127.0.0.1:<port>/test/browser/run.html?files=<comma list>`. The default is every `test/browser/*.test.js`.
    3. Waits (up to 120 s) for the page to `POST /results` with `{ results: [{ name, ok, error }] }`.
    4. Terminates Firefox and prints `✓ name` / `✗ name: error` lines plus `N passed, M failed`.
    5. Exits 0 when everything passes, 1 on any failure, and 2 on a timeout or launch error.
  - The profile's `user.js` turns off first-run pages, the default-browser check, telemetry upload, and session restore prompts.

- [ ] **Step 1: Failing Python test** (`scripts/test_browser_test.py`):
  - `parse_results(b'{"results":[{"name":"a","ok":true},{"name":"b","ok":false,"error":"x"}]}')` returns `(1, 1, ["✓ a", "✗ b: x"])`.
  - `exit_code(passed=3, failed=0, timed_out=False) == 0`, `exit_code(3, 1, False) == 1`, `exit_code(0, 0, True) == 2`.
  - `test_files(root)` lists `test/browser/*.test.js` sorted, as URL paths.
- [ ] **Step 2: Run `python3 -m unittest scripts/test_browser_test.py`; expect failure.**
- [ ] **Step 3: Implement** the script with `http.server.ThreadingHTTPServer` and `subprocess.Popen`. Firefox is always terminated in a `finally` block. `run.html` loads the harness, imports each listed file, runs the tests in order, and posts the results. An import error counts as a failed test named after the file.
- [ ] **Step 4: `test/browser/smoke.test.js`**: one test proves `createFirefox()` from `../fakes/firefox.js` works in the page (a tab moves). Another dispatches a `dragstart` with a `DataTransfer` on an element and reads the data back in a listener. Run `npm run test:browser`; expect `2 passed, 0 failed`. Run `npm test`; expect a pass.
- [ ] **Step 5: Commit** — `git commit -m "test: headless Firefox harness for DOM tests"`

### Task 2: Board model and drop targets (pure)

**Files:**
- Create: `extension/src/board/model.js`, `extension/src/board/targets.js`, `test/board-model.test.js`, `test/board-targets.test.js`
- Modify: `extension/src/model.js` (remove `buildModel`, keep `colorKey`, `formatTime`, `formatDate`, `msUntilNextMinute`), `test/model.test.js` (drop the `buildModel` tests)

**Interfaces:**
- Produces:

```js
// board/model.js
export function buildBoard({ windows, tabs, groups, currentWindowId, selfTabId }): Board
// Board = { windowOrder: number[], pinned: Section[], columns: Column[], tabs: Section[] }
// Section = { windowId, current: boolean, rows: Row[] }            (sections with no rows are left out)
// Column  = { id, windowId, current: boolean, title: string, color: string /* colorKey */, apiColor: string, collapsed: boolean, rows: Row[] }
// Row     = { id, windowId, index, title, url, icon: string|null, pinned: boolean, groupId: number, active: boolean }

// board/targets.js
export function resolveTabTarget(board, drop, currentWindowId): TabTarget | null
// drop = { zone: "group", groupId, slot } | { zone: "pinned" | "tabs", slot } | { zone: "new-group" }
// slot = insertion position among the zone's rows in board order (0..rows.length)
// TabTarget = { kind: "group", groupId, windowId, beforeTabId: number|null }
//           | { kind: "tabs" | "pinned", windowId, beforeTabId: number|null }
//           | { kind: "new-group", windowId }
export function resolveGroupTarget(board, groupId, slot, currentWindowId): GroupTarget | null
// slot = insertion position among board.columns (0..columns.length); GroupTarget = { windowId, beforeGroupId: number|null }
export function slotFromPointer(midpoints: number[], y: number): number   // count of midpoints above y
```

Rules:
- `windows`: only `type: "normal"` and not `incognito`.
- `windowOrder`: the current window first, then the others by the highest `lastAccessed` of their tabs, most recent first (ties: lower id first).
- Rows exclude `selfTabId` and hidden tabs. Row `title` = `tab.title || tab.url || ""`.
- Columns: for each window in `windowOrder`, its groups ordered by their first tab's index; groups with no shown tabs are left out.
- PINNED and TABS: one section per window in `windowOrder`. TABS holds tabs that are neither pinned nor grouped.
- `resolveTabTarget`:
  - For `group`: `beforeTabId = rows[slot]?.id ?? null`.
  - For `pinned`/`tabs`, flatten the zone's sections into one row list:
    - A slot whose rows above and below belong to the same window, or which is at the top with rows below: that window, with `beforeTabId` = the row below.
    - A slot at a window boundary or at the very end: the window of the row above, with `beforeTabId: null`.
    - An empty zone: the current window, with `null`.
  - For `pinned`, a resolved window other than the current one becomes `{ kind: "pinned", windowId: currentWindowId, beforeTabId: null }`.
  - `new-group` resolves to the current window.
  - It returns `null` when the drop can't change anything. That means the dragged tab is already at that slot: `beforeTabId` is the tab itself, or the tab is the row just above the slot in the same zone and window. The dragged tab id is `drop.tabId`.
- `resolveGroupTarget`, with `before = columns[slot]` and `after = columns[slot - 1]`:
  - If `before` exists and (`after` is missing or is in the same window as `before`): `{ windowId: before.windowId, beforeGroupId: before.id }`.
  - Otherwise, if `after` exists: `{ windowId: after.windowId, beforeGroupId: null }`.
  - Otherwise: the current window with `null`.
  - It returns `null` if `before?.id === groupId` or `after?.id === groupId`.

- [ ] **Step 1: Failing tests.** Build fixtures with `createFirefox()` and pass `await browser.tabs.query({})`, `await browser.tabGroups.query({})` and `await browser.windows.getAll()`. Cover:
  - window ordering by recency;
  - the self tab and hidden tabs excluded;
  - group order by first tab;
  - pinned/tabs sections per window;
  - every `resolveTabTarget` rule above, including the three Review Focus 3 cases and both no-op cases;
  - every `resolveGroupTarget` rule;
  - `slotFromPointer([10, 30, 50], 31) === 2`.
- [ ] **Step 2: Run `node --test test/board-model.test.js test/board-targets.test.js`; expect failure.**
- [ ] **Step 3: Implement both modules.** Pure functions only, no API calls.
- [ ] **Step 4: Run `npm test`; expect a pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat: board model and drop targets"`

### Task 3: Move executors

**Files:**
- Create: `extension/src/board/moves.js`, `test/board-moves.test.js`
- Modify: `extension/src/actions.js` only if `openTab` needs a shared helper (keep `activateTab`'s behaviour and tests)

**Interfaces:**
- Consumes: `TabTarget`, `GroupTarget`, `Row` (Task 2); `activateTab(api, targetTabId, selfTabId, { close })` (existing, `extension/src/actions.js`).
- Produces (each returns a Promise and never rejects; failures are logged with `Foxy:` and resolve to `false`/`null`):

```js
export async function dropTab(api, tabId, target): Promise<{ ok: boolean, groupId?: number }>
export async function dropGroup(api, groupId, target): Promise<boolean>
export async function bringGroupHere(api, groupId, windowId): Promise<boolean>
export async function openTab(api, row, self /* {id, windowId} */, { close }): Promise<boolean>
export async function closeTabs(api, tabIds): Promise<boolean>
export async function closeGroup(api, groupId): Promise<boolean>
export async function renameGroup(api, groupId, title): Promise<boolean>
export async function recolorGroup(api, groupId, apiColor): Promise<boolean>
```

Algorithms (Firefox 157 facts: `tabs.move` inserts the tab next to the tab currently at `index` and takes that tab's group; illegal pinned or unpinned positions are ignored silently; `tabs.ungroup` puts a group's first tab before the group and any other tab after it; `tabs.group` into an existing group leaves members in place, moves same-window tabs that sit before the group to its front, and appends everything else (including tabs adopted from other windows) at its end; `tabGroups.move` puts the group's first tab at `index`):

- `indexBefore(tab, before)`: `before.index - 1` when the tab is in the same window and before it, otherwise `before.index`.
- **`dropTab`, kind `group`:**
  1. Unpin if pinned.
  2. `tabs.group({ tabIds: [tabId], groupId })` if not already a member.
  3. With a `beforeTabId` that is not the tab itself, re-read both tabs. If `before` is still in the group, `tabs.move(tabId, { index: indexBefore(tab, before) })`. The tab is already a member, so the neighbour it lands next to is a member too and it stays in the group.
  4. With `beforeTabId: null` and the tab not the group's last member, move it to the index of the group's last tab.
  5. Correct: re-read; if `groupId` differs, `tabs.group` again.
- **`dropTab`, kind `tabs`:**
  1. Unpin if pinned; `tabs.ungroup` if grouped.
  2. With `before`: `tabs.move(tabId, { windowId: before.windowId, index: same window ? indexBefore(tab, before) : before.index })`.
  3. With `null`: move to just after the target window's last loose (ungrouped, unpinned) tab, at index `last.index` when moving forwards in the same window, else `last.index + 1`. If the window has no loose tab, use `index: -1`.
  4. Correct: re-read; if the tab is grouped, `tabs.ungroup`.
- **`dropTab`, kind `pinned`, window W:**
  1. If the tab is pinned in another window: `tabs.move(tabId, { windowId: W, index: pinnedCount(W) })`.
  2. If it's unpinned in another window: `tabs.move(tabId, { windowId: W, index: -1 })`, then pin it.
  3. If it's unpinned in W: pin it.
  4. With `before`: re-read both, then `tabs.move(tabId, { index: indexBefore(tab, before) })`.
  5. Correct: re-read; if it's not pinned, or not in W, log a warning.
- **`dropTab`, kind `new-group`:** unpin if pinned, then `groupId = await tabs.group({ tabIds: [tabId], createProperties: { windowId } })`. Return `{ ok: true, groupId }`.
- **`dropGroup`:**
  - With `beforeGroupId`: `first` = the before group's first tab. In the same window, moving forwards: `index = first.index - groupSize`; otherwise `index = first.index`. Then `tabGroups.move(groupId, { windowId, index })`.
  - With `null`: `tabGroups.move(groupId, { windowId, index: -1 })`.
- **`bringGroupHere`:** `tabGroups.move(groupId, { windowId, index: -1 })`.
- **`openTab`:**
  - A pinned row from another window: `tabs.move(row.id, { windowId: self.windowId, index: pinnedCount(self.windowId) })` first.
  - Any other row from another window: `windows.update(row.windowId, { focused: true })` after activating.
  - Then `activateTab(api, row.id, self.id, { close })`.
- **`closeGroup`:** `tabs.remove` with all of the group's tab ids.

- [ ] **Step 1: Failing tests** with `createFirefox()`. Each test asserts `ff.layout()` of every window involved after `await ff.settle()`. Cover:
  - every kind of `dropTab` within one window and across windows, including pinned tabs and grouped tabs;
  - before a group's first tab, and at its end;
  - into an empty TABS section;
  - onto `new-group` (a new group with that tab, in the current window);
  - `dropGroup` forwards, backwards and into another window;
  - `bringGroupHere`;
  - `openTab` for a tab here, a tab in another window (focus changes), and a pinned tab in another window (it moves here and stays pinned);
  - rejection paths: a closed tab id gives `ok: false`, a `Foxy:` warning, and no throw.
- [ ] **Step 2: Run `node --test test/board-moves.test.js`; expect failure.**
- [ ] **Step 3: Implement `moves.js`.**
- [ ] **Step 4: Run `npm test`; expect a pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat: board move executors"`

### Task 4: Board rendering, layout and live updates

**Files:**
- Create: `extension/src/board/render.js`, `test/browser/render.test.js`
- Modify: `extension/src/main.js` (controller), `extension/newtab.html`, `extension/newtab.css`, `preview/fake-browser.js`, `preview/fixtures.js`, `scripts/preview.py` (scenario list)
- Delete: `extension/src/render.js` (old strip and cards) and anything left unused

**Interfaces:**
- Consumes: `buildBoard` (Task 2), the `moves.js` functions (Task 3), `colorKey` and the clock helpers (`extension/src/model.js`).
- Produces:
  - `renderBoard(root, board, ui, handlers)` in `board/render.js`, with `ui = { editGroupId: number|null }`.
  - `handlers = { onOpen(row), onCloseTab(tabId), onCloseGroup(groupId), onBringHere(groupId), onRename(groupId, title), onRecolor(groupId, apiColor), onTabDrop(tabId, drop), onGroupDrop(groupId, slot), onEditEnd() }`.
  - The DOM contract used by Tasks 5–6 and the tests:

```html
<div id="board" class="board">
  <section class="column fixed" data-zone="pinned"><h2 class="column-title">PINNED</h2>
    <div class="rows" data-zone="pinned">
      <div class="row" role="button" tabindex="0" draggable="true" data-tab-id="11" data-window-id="1">
        <img class="icon" alt=""><span class="row-label">Title</span>
        <button class="row-close" aria-label="Close tab" tabindex="-1">×</button></div>
      <h3 class="subheading">OTHER WINDOWS</h3> … rows of other windows (a .window-gap between windows) …
    </div></section>
  <div class="strip">
    <section class="column group" data-group-id="101" data-window-id="1" data-color="red">
      <header class="column-header" draggable="true">
        <button class="dot" aria-label="Group colour"></button>
        <span class="group-name">DEV SERVER</span>
        <button class="bring-here" aria-label="Bring here">…</button>   (other windows only)
        <button class="column-close" aria-label="Close group">×</button></header>
      <div class="other-window">OTHER WINDOW</div>                     (other windows only)
      <div class="rows" data-zone="group" data-group-id="101">…</div></section>
    <section class="column new-group" data-zone="new-group"><span class="action">+ NEW GROUP</span></section>
  </div>
  <section class="column fixed" data-zone="tabs"><h2 class="column-title">TABS</h2><div class="rows" data-zone="tabs">…</div></section>
</div>
```

Layout values (spec §5):
- The page is a full-height flex column: the clock and date on top, then the board filling the remaining height.
- The board has 24px side margins. PINNED sits left and TABS right; both are fixed. `.strip` (`overflow-x: auto`) takes the middle.
- Columns are 264px wide with a 12px gap. Each column's `.rows` scrolls vertically with a hard cut: no fade and no mask.
- Glass card backgrounds reuse the current `--card` variables.
- Rows are 32px tall: a 16px favicon (the globe icon when missing or broken), then the title with an ellipsis. The × appears on row hover or focus.
- `.new-group` is a faint glass card with the action label centred.
- Headers show a dot plus the group title (§4 role) at the size where the capitals are exactly 12px, the dot's height. Keep the existing dot `vertical-align` technique.
- An unnamed group shows "UNNAMED" at `--text-muted`.
- The thin neutral scrollbar and focus-visible styles stay as they are today.

Controller (`main.js`):
- The clock is unchanged.
- `refresh()` reads `windows.getAll({ windowTypes: ["normal"] })`, `tabs.query({})`, `tabGroups.query({})` and `tabs.getCurrent()`, builds the board and renders it. It keeps `.strip`'s `scrollLeft` and each `.rows`' `scrollTop` (keyed by zone and group id) and the focused element (by `data-tab-id` or `data-group-id`), and uses a generation counter against out-of-order reads.
- It listens for tab, tabGroups and window events, plus `tabs.onActivated`, across all windows, and schedules one refresh per animation frame.
- While `ui.dragging` or `ui.editing` is set, refreshes are held back and one runs when the interaction ends (Review Focus 1).
- Handlers call `moves.js`, then `refresh()`. `onOpen` passes `{ close: history.length === 1 }`.

Preview:
- `preview/fake-browser.js` builds `globalThis.browser` from `createFirefox()` with `preview/fixtures.js` scenarios:
  - `empty`: no groups or pins;
  - `one-window`: 6 pins, 3 groups, a long name and an unnamed group, and 3 loose tabs;
  - `two-windows`: the current window plus one other window with 2 groups, 2 pins and 2 loose tabs;
  - `many-groups`: 8 groups, some with 20 tabs;
  - `light`: `one-window` in the light scheme.
- `scripts/preview.py` shoots them at 1600×1000, plus `narrow` (`one-window` at 900×900).

- [ ] **Step 1: Failing browser tests** (`test/browser/render.test.js`). Render boards built from `createFirefox()` fixtures and assert:
  - column order: PINNED, the groups in board order, `+ NEW GROUP`, TABS;
  - the `OTHER WINDOWS` subheading position and the `OTHER WINDOW` line and bring-here button only on other windows' columns;
  - row data attributes;
  - "UNNAMED" for an empty title;
  - a long name that doesn't widen the column (`offsetWidth === 264`);
  - no border, outline or box-shadow on columns and rows (`getComputedStyle`).
- [ ] **Step 2: Run `npm run test:browser`; expect the new tests to fail.**
- [ ] **Step 3: Implement** `render.js`, the CSS, the HTML, the controller and the preview.
- [ ] **Step 4: Run `npm test` and `npm run test:browser`; expect a pass.** Run `python3 scripts/preview.py` and look at every PNG. Pixel-check one group header: the dot and the capitals share their first and last pixel rows. Record the rows.
- [ ] **Step 5: Commit** — `git commit -m "feat: kanban board layout with live updates"`

### Task 5: Drag and drop

**Files:**
- Create: `extension/src/board/dnd.js`, `test/browser/dnd.test.js`
- Modify: `extension/src/board/render.js` (call `attachDnd` once per root), `extension/newtab.css` (drag styles), `extension/src/main.js` (drag state and handlers)

**Interfaces:**
- Consumes: the DOM contract (Task 4), `slotFromPointer` (Task 2), and the handlers `onTabDrop(tabId, drop)` and `onGroupDrop(groupId, slot)`.
- Produces: `attachDnd(root, { onTabDrop, onGroupDrop, onDragState(dragging: boolean) })`, using event delegation, attached once.
- The `DataTransfer` types are `application/x-foxy-tab` (the tab id) and `application/x-foxy-group` (the group id). Firefox only exposes type names during `dragover`, so the dragged kind is decided from `dataTransfer.types`.

Behaviour (spec §5–§6):
- `dragstart` on a `.row` or `.column-header` adds `.dragging` to the source (opacity 0.4) and calls `onDragState(true)`. `dragend` removes all drag classes and indicators and calls `onDragState(false)`.
- Tab drags:
  - Over a `.rows` zone, show a single 2px `.drop-line`, a bright neutral-white bar, at the slot from `slotFromPointer` (row vertical midpoints). The zone's column gets `.drop-target` (lighter fill). Over `.new-group`, only `.drop-target`.
  - `drop` calls `onTabDrop(tabId, { zone, groupId?, slot, tabId })`.
- Group drags:
  - Over `.strip`, show a vertical 2px `.drop-line` between columns at the slot from the column horizontal midpoints (`slotFromPointer` on x).
  - `drop` calls `onGroupDrop(groupId, slot)`.
  - PINNED, TABS and `.new-group` are not column targets: no indicator, `dropEffect = "none"`.
- `preventDefault()` in `dragover` happens only for valid targets.
- Clicking a row after a drag does not open it.

- [ ] **Step 1: Failing browser tests** (`test/browser/dnd.test.js`). Use real `DragEvent`s through `dispatchDrag` on a rendered board with spy handlers:
  - a slot is computed from `clientY` between rows;
  - the line sits between the right rows;
  - drop payloads for a group zone, PINNED, TABS and `+ NEW GROUP`;
  - a column drag gives the right slot;
  - no indicator over PINNED or TABS for column drags;
  - `onDragState` is true and then false;
  - `dragend` clears the classes;
  - a render during a drag is deferred: after `dragend`, the controller re-renders once. Test this through `main.js`'s exported `createController` if you extract one; otherwise through a spy on `renderBoard`.
- [ ] **Step 2: Run `npm run test:browser`; expect failure.**
- [ ] **Step 3: Implement `dnd.js`** and the styles.
- [ ] **Step 4: Run `npm test` and `npm run test:browser`; expect a pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat: drag tabs and group columns on the board"`

### Task 6: Editing, closing and bring-here; version 2.0.0

**Files:**
- Create: `extension/src/board/edit.js`, `test/browser/edit.test.js`
- Modify: `extension/src/board/render.js`, `extension/src/main.js`, `extension/newtab.css`, `extension/manifest.json`, `test/manifest.test.js`, `README.md`

**Interfaces:**
- Consumes: the `onRename`, `onRecolor`, `onCloseTab`, `onCloseGroup`, `onBringHere` and `onEditEnd` handlers (Task 4); `ui.editGroupId`.
- Produces:
  - `openNameEditor(nameEl, { initial, onSave(title), onCancel() })`
  - `openColorPicker(dotEl, { current, onPick(apiColor), onClose() })`

Behaviour (spec §6):
- **Name editor.** A click on `.group-name`, or `ui.editGroupId` matching the column (after a drop on `+ NEW GROUP`), replaces the name with an `<input>` in the same font:
  - focused and all selected;
  - Enter or blur saves (`onRename` with the trimmed value; an empty value keeps the group unnamed);
  - Escape cancels (a new group stays unnamed);
  - either way it ends with `onEditEnd()`.
- **Colour picker.** A click on `.dot` opens a row of 9 dots under the header, in the order `blue cyan green grey orange pink purple red yellow`, each styled like the dots. Clicking one calls `onRecolor`. Escape or clicking elsewhere closes it.
- **Close buttons.** `.row-close` calls `onCloseTab` and `.column-close` calls `onCloseGroup`. The click must not also open the row.
- **Bring here.** `.bring-here` calls `onBringHere`.
- **Manifest.** Version `2.0.0`; description `"A kanban board of your tabs and tab groups on the new tab page."`

- [ ] **Step 1: Failing browser tests** (`test/browser/edit.test.js`):
  - Enter saves and Escape cancels, with `onEditEnd` called once;
  - blur saves;
  - after a drop on `+ NEW GROUP` the new column's editor is open and focused (through the controller with `createFirefox()`);
  - the picker lists 9 colours, and picking calls `onRecolor("green")`;
  - × on a row closes only that tab (the fake's layout) and doesn't activate it;
  - × on a header closes the group's tabs;
  - bring-here moves the group into the current window (fake layout).
  Also update the manifest test for version `2.0.0` and the description.
- [ ] **Step 2: Run both test commands; expect failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test` and `npm run test:browser`; expect a pass.** Run `python3 scripts/preview.py` and look at the PNGs.
- [ ] **Step 5: Commit** — `git commit -m "feat: rename, recolour, close and bring groups here; Foxy 2.0.0"`
