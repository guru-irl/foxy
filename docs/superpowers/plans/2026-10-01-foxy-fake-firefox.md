# Fake Firefox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stateful fake of the WebExtension APIs Foxy uses (windows, tabs, tab groups, bookmarks, storage, runtime, events) that follows Firefox 157's rules closely enough to test the board's moves and the bookmark sync.

**Architecture:** One ES module, `test/fakes/firefox.js`, with no Node-only imports, so it runs both under `node --test` and inside a Firefox page (the board's browser tests and previews import it). State lives in plain arrays; API calls mutate state and queue events; `settle()` delivers queued events.

**Tech Stack:** Plain ES modules, node --test.

**Spec:** `docs/superpowers/specs/2026-10-01-foxy-design.md` (§7 cross-window mechanics, §8 bookmarks, §11 testing).

## Global Constraints

- No npm or pip installs, no new dependencies. No Node built-ins imported by `test/fakes/firefox.js` (it must load in a browser page).
- Never write to `/tmp`, `$TMPDIR` or `/var/tmp`; scratch goes under the worktree's `.spider/scratch/`.
- Never read `~/.config/liquidfox-newtab/amo.env`, never run `scripts/sign.py`, never contact addons.mozilla.org, never push or create GitHub resources.
- Never modify anything outside the worktree.
- Fixture titles and URLs are generic (`https://example.com/...`); no company-internal names.
- `npm test` must pass at the end of the task.

## Review Focus

1. Index bookkeeping after cross-window moves: both windows' `index` values must be 0..n-1 with pinned tabs first and each group's tabs contiguous, after every operation.
2. Group membership after `tabs.move`: the moved tab takes the group of the neighbour it is inserted next to (before it when moving backwards, after it when moving forwards), exactly as Firefox 157 does; a grouped tab moved next to an ungrouped tab leaves its group; empty groups disappear with `tabGroups.onRemoved`. Illegal pinned/unpinned positions are ignored without an error.
3. Event ordering and timing: listeners must never run synchronously inside the API call (real Firefox is async), and `settle()` must also deliver events queued by listeners.
4. Returned objects are copies: mutating a returned tab or bookmark must not change fake state.
5. Window-closing semantics: `closeWindow()` reports `isWindowClosing: true` on both `tabs.onRemoved` and `tabGroups.onRemoved`.

---

### Task 1: `createFirefox()` fake with windows, tabs, groups, bookmarks, storage and runtime

**Files:**
- Create: `test/fakes/firefox.js`
- Test: `test/fake-firefox.test.js`

**Interfaces:**
- Produces (later plans rely on these exact names):

```js
export function createFirefox(setup?: {
  windows?: Array<{ id: number, focused?: boolean }>,           // default: [{ id: 1, focused: true }]
  groups?: Array<{ id: number, windowId: number, title?: string, color?: string, collapsed?: boolean }>,
  tabs?: Array<{ id: number, windowId: number, url?: string, title?: string, pinned?: boolean,
                 groupId?: number, active?: boolean, discarded?: boolean, favIconUrl?: string,
                 lastAccessed?: number }>,                       // listed in window order
  currentWindowId?: number,   // window of the calling page (tabs.query currentWindow, windows.getCurrent)
  selfTabId?: number,         // tabs.getCurrent() result
  bookmarks?: Array<Node>,    // children of Other Bookmarks; Node = { title, url } | { title, children: Node[] }
  extensionId?: string,       // default "foxy-test"
}): Firefox

interface Firefox {
  browser: {                  // same shapes as the real `browser` object
    tabs, tabGroups, windows, bookmarks, storage: { local }, runtime
  };
  settle(): Promise<void>;    // deliver every queued event, including ones queued by listeners
  layout(windowId: number): string;   // e.g. "P1 P2 | [101: 3 4] 5 [102: 6]"
  closeWindow(windowId: number): Promise<void>;   // user closes a window
  fire(name: string, ...args): void;  // queue any event, e.g. fire("runtime.onStartup")
  errors: Error[];            // errors thrown by listeners (never swallowed silently)
  calls: Array<{ api: string, args: any[] }>;     // every API call, e.g. { api: "tabs.move", args: [...] }
}
```

Rules the fake implements (Firefox 157 behaviour; each needs a test):

- **Tab objects** returned have `id, windowId, index, pinned, groupId (-1 when none), url, title, favIconUrl, active, discarded, hidden: false, status: "complete", lastAccessed, incognito: false`. Defaults: `url "about:blank"`, `title` = url, `lastAccessed` increasing in setup order, first tab of each window active unless one says `active: true`.
- **Order invariants** per window, after every operation: pinned tabs first; each group's tabs contiguous; `index` = position.
- `tabs.query(q)`: filters `windowId`, `currentWindow: true`, `pinned`, `groupId`, `active`, `windowType: "normal"`; results ordered by window setup order, then index.
- `tabs.get(id)` rejects with `Error("Invalid tab ID: <id>")` for unknown ids. `tabs.getCurrent()` returns the `selfTabId` tab (undefined when not set).
- `tabs.create({ windowId, url, index, pinned, active, discarded, title })`: default window = current window; default index = end (pinned: end of pinned range); `active` defaults to true unless `discarded`; `discarded: true` with `active: true` rejects; `title` only honoured when discarded. URL check shared with `tabs.update`: allowed are `http:`, `https:`, `about:blank`, and `moz-extension:`; anything else (`about:config`, `file:`, `chrome:`, `data:`, `javascript:`) rejects with `Error("Illegal URL: <url>")`. A tab created between two tabs of one group joins it.
- `tabs.update(id, { active, pinned, url, muted })`: `active: true` deactivates the others in that window and bumps `lastAccessed`; `pinned: true` leaves any group and moves to the end of the pinned range; `pinned: false` moves to the first unpinned position; `url` passes the URL check, sets `url`, sets `discarded: false`.
- `tabs.move(ids, { windowId, index })` (ids: number or array; several ids go to consecutive positions): default window = the tab's window; `index: -1` = end; an index above the maximum is lowered to it (maximum = number of tabs in the target window, minus one for a same-window move). This mirrors Firefox 157 (`ext-tabs.js` `move`, `Tabbrowser.moveTabTo`, `tabs.js insertBefore`), including its group behaviour:
  - **Illegal positions are ignored silently**: a pinned tab whose index is above the target window's pinned count, or an unpinned tab whose index is below it, is not moved, with no error (it is left out of the returned list).
  - **Same window**: let `neighbor` = the tab currently at `index`. Moving backwards (index < current index), the tab is inserted *before* `neighbor`; moving forwards, *after* `neighbor`. The tab then takes `neighbor`'s group: it joins that group if `neighbor` is grouped, and is ungrouped if `neighbor` is not. Moving a tab to its own index is a no-op.
  - **Another window** (adoption): the tab is inserted before the target window's tab at `index` and takes that tab's group the same way; at the end (`-1` or the maximum) it is inserted after the last tab, ungrouped. It keeps `pinned`. Emits `tabs.onDetached(id, { oldWindowId, oldPosition })` then `tabs.onAttached(id, { newWindowId, newPosition })`, and closes the source window if it becomes empty (`windows.onRemoved`).
  - Same-window moves emit `tabs.onMoved(id, { windowId, fromIndex, toIndex })`. A group change also emits `tabs.onUpdated(id, { groupId }, tab)`. A group left empty is removed (`tabGroups.onRemoved(group, { isWindowClosing: false })`). Returns the moved tabs.
- `tabs.group({ tabIds, groupId, createProperties: { windowId } })`: with `groupId`, the group may be in any window. Tabs are unpinned if pinned, adopted into the group's window, and appended after the group's last tab, in `tabIds` order. Without `groupId`, a new group is created in `createProperties.windowId` (default: the first tab's window). It takes the next colour from `["blue","purple","cyan","orange","yellow","pink","green","grey","red"]` (cycling) with title `""`. If the first tab is already in that window, the group forms at the first tab's position; otherwise it goes at the end of the window. Emits `tabGroups.onCreated`. Also emits `tabs.onUpdated(id, { groupId }, tab)` per changed tab. Returns the group id.
- `tabs.ungroup(ids)`: each tab leaves its group and is placed right after that group's remaining tabs; emits `tabs.onUpdated(id, { groupId: -1 }, tab)`; empty groups are removed.
- `tabs.remove(ids)`: emits `tabs.onRemoved(id, { windowId, isWindowClosing: false })`; empty groups removed; empty windows closed.
- `tabs.discard(ids)`: sets `discarded: true` (active tabs are not discarded).
- `tabs.onUpdated` fires on url/title/pinned/groupId/discarded changes with a `changeInfo` holding only the changed keys, plus the tab.
- `tabGroups.get(id)`, `tabGroups.query({ windowId })` (groups in tab-strip order), `tabGroups.update(id, { title, color, collapsed })` → `tabGroups.onUpdated(group)`.
- `tabGroups.move(id, { windowId, index })`: moves the whole block so that its first tab ends up at `index` (Firefox 157 `ext-tabGroups.js`: `index: -1` = end, larger indexes are lowered to the end). Within the same window, when moving forwards, Firefox validates against `index + groupSize`. It rejects with `Error("Cannot move the group to an index that is in the middle of pinned tabs.")` if the tab at the validated position is pinned. It rejects with `Error("Cannot move the group to an index that is in the middle of another group.")` if the tabs just before and at the validated position belong to the same other group. Across windows the group keeps its id and title/colour (adoption), and `tabGroups.onMoved(group)` is emitted.
- Group objects: `{ id, windowId, title, color, collapsed }`.
- `windows.getAll({ populate, windowTypes })` → `{ id, focused, type: "normal", incognito: false, tabs? }` in setup order; `windows.getCurrent()`, `windows.getLastFocused()`, `windows.update(id, { focused: true })` (emits `windows.onFocusChanged(id)`). `windows.WINDOW_ID_NONE = -1`.
- `closeWindow(id)`: emits `tabs.onRemoved(id, { windowId, isWindowClosing: true })` for each tab, `tabGroups.onRemoved(group, { isWindowClosing: true })` for each group, then `windows.onRemoved(id)`.
- **Bookmarks**: the tree has root `"root________"` and children `"menu________"`, `"toolbar_____"`, `"unfiled_____"` (Other Bookmarks, where `setup.bookmarks` go) and `"mobile______"`. New ids are 12-character strings. Nodes are `{ id, parentId, index, title, url?, type: "bookmark"|"folder", dateAdded }` with `children` on folders from `getTree`/`getSubTree`. The fake implements `getTree`, `getSubTree(id)`, `getChildren(id)`, `get(idOrIds)`, `search({ title, url })` (exact matches), `create({ parentId, index, title, url })` (default parent `"unfiled_____"`, default index end; `javascript:` and `data:` URLs reject), `update(id, { title, url })`, `move(id, { parentId, index })`, `remove(id)` (rejects on non-empty folders), and `removeTree(id)`. Events: `onCreated(id, node)`, `onRemoved(id, { parentId, index, node })`, `onChanged(id, { title, url })`, `onMoved(id, { parentId, index, oldParentId, oldIndex })`. Built-in roots cannot be removed.
- **storage.local**: `get(keys?)` (string, array, object with defaults, or null/undefined for all), `set(obj)`, `remove(keys)`, `clear()`; values stored as JSON copies; emits `storage.onChanged(changes, "local")`.
- **runtime**: `id`, `getURL(path)` → `"moz-extension://<extensionId>/" + path`, `sendMessage(msg)` resolves with the first listener result that is not undefined (listeners may return promises); `onMessage`, `onStartup`, `onInstalled` events.
- **Events**: every event object has `addListener`, `removeListener`, `hasListener`. Listeners run asynchronously (queued), never inside the API call. `settle()` loops until the queue is empty (guard: throw after 10,000 deliveries to catch loops). A listener that throws is recorded in `errors`; delivery continues.
- `calls` records every `browser.*` call as `{ api: "tabs.move", args }` (args deep-copied).
- `layout(windowId)`: pinned tabs as `P<id>`, then ` | `, then ungrouped tabs as `<id>` and groups as `[<groupId>: <ids…>]`, space-separated; e.g. `"P1 P2 | [101: 3 4] 5"`. With no pinned tabs, the output starts with `| `.

- [ ] **Step 1: Write failing tests** in `test/fake-firefox.test.js`, one `test()` per rule above. The assertions compare `layout()` strings and event logs, e.g.:

```js
const ff = createFirefox({
  groups: [{ id: 101, windowId: 1, title: "Dev", color: "red" }],
  tabs: [
    { id: 1, windowId: 1, pinned: true }, { id: 2, windowId: 1 },
    { id: 3, windowId: 1, groupId: 101 }, { id: 4, windowId: 1, groupId: 101 }, { id: 5, windowId: 1 },
  ],
});
await ff.browser.tabs.move(2, { index: 2 });          // forwards: after tab 3 (index 2), joins 101
assert.equal(ff.layout(1), "P1 | [101: 3 2 4] 5");
await ff.browser.tabs.move(3, { index: -1 });         // forwards to the end: after 5, leaves 101
assert.equal(ff.layout(1), "P1 | [101: 2 4] 5 3");
await ff.browser.tabs.move(3, { index: 1 });          // backwards: before tab 2, joins 101
assert.equal(ff.layout(1), "P1 | [101: 3 2 4] 5");
await ff.browser.tabs.move(1, { index: 3 });          // pinned tab past the pinned range: ignored
assert.equal(ff.layout(1), "P1 | [101: 3 2 4] 5");
```

  The tests must also cover the cross-window rules (`tabs.group` adopting across windows, `tabGroups.move` into another window, an emptied window closing) with `layout()` of both windows. They must cover event order and asynchrony: nothing is delivered before `await ff.settle()`, and events queued by listeners are delivered too. Also cover the bookmark ops and their events, `storage.local` defaults, `runtime.sendMessage`, and the URL checks.

- [ ] **Step 2: Run `node --test test/fake-firefox.test.js`; expect it to fail (the module doesn't exist yet).**

- [ ] **Step 3: Implement `test/fakes/firefox.js`** to the rules above. Keep it one module with small internal helpers (`windowTabs(windowId)`, `reindex(windowId)`, `normalizeMembership(windowId, tabId)`, `queue(eventName, ...args)`).

- [ ] **Step 4: Run `npm test`; expect everything to pass.**

- [ ] **Step 5: Check the module loads in a browser** (no Node imports): `grep -n "from \"node:" test/fakes/firefox.js` must print nothing.

- [ ] **Step 6: Commit** — `git commit -m "test: stateful fake Firefox for tabs, groups, windows, bookmarks and storage"`
