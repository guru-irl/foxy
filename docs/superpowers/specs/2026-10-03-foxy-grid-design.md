# Foxy grid board: design

Date: 2026-10-03. Status: approved in conversation; the user gave full autonomy for the rest.
Replaces the board layout and interactions in `2026-10-01-foxy-design.md` §5 and §6.
Sync (§7, §8), pin names (§14) and the page-closing rule stay as they are.

## 1. Goal

Use the whole page. The board becomes a grid of square cells. Every group and
every board widget is a tile you can move and resize. Open ungrouped tabs keep
a fixed rail on the right. A settings pane makes the board configurable.

## 2. Decisions

| Topic | Decision |
|---|---|
| Tiles | Cards only. Tabs stay as rows inside tiles. |
| Tile kinds | `group` (one per open group, every window), `pinned`, `saved`, `clock`. |
| TABS | Not a tile. A fixed rail on the right, full height, its own scroll. |
| Cells | Square, fixed size in CSS px, gap 16 px. Column count follows the width. |
| Cell sizes | S 48, M 80 (default), L 112, XL 144, custom 40 to 240 px. |
| Scrolling | The grid area scrolls vertically; rows are unbounded. |
| Collisions | Push down, gaps allowed, live preview. No upward packing. |
| Layout scope | Synced across devices (`storage.sync`), one key per tile. |
| Narrow screens | Tiles that do not fit are shown at the first free spot below. Saved positions do not change unless you move that tile. |
| Settings | Gear button in the TABS rail header opens a pane. The same pane is the add-on's options page. |
| Version | Foxy 3.0.0. |

CSS px already follow the display's scaling (2 device px per CSS px on Retina)
and Firefox zoom, so a cell is about the same physical size on every screen.
With the 16 px gap, cell + gap is a whole number of 32 px tab rows for every
preset: S 2, M 3, L 4, XL 5.

## 3. Layout model

- A tile is `{ id, x, y, w, h }` in cells, origin top left.
- Tile ids: `group:<folderId>` (the group's bookmark folder GUID), `pinned`,
  `saved`, `clock`.
- Columns: `total = max(1, floor((contentWidth + 16) / (cell + 16)))`, where
  `contentWidth` is the page width minus the page margins. The rail takes
  `railCells` of those columns and the grid the rest:
  `gridCols = max(1, total - railCells)`. Leftover width (less than one
  cell) is split evenly as side margins.
- Minimum sizes: `clock` 3 × 2, every other kind 2 × 2. Width is capped at
  the column count.
- Default sizes come from a target size in px, converted with
  `round((px + 16) / (cell + 16))` and clamped to the minimum: group, pinned
  and saved 288 × 384 px; clock 480 × 208 px. At M that is 3 × 4 and 5 × 2.
- **Move or resize** (`place`): the tile takes its new rectangle; any tile it
  overlaps moves down to just below it, and that repeats for tiles those
  overlap. Nothing moves up.
- **Display fit** (`fit`): first, in reading order (row, column, then id), a
  tile stays at its saved place if it is inside the columns and clear of the
  tiles kept before it. Then every other tile, in reading order, is shown at
  the first free spot at or below its own row, with width capped at the
  column count. Saved layouts can overlap (two devices editing at once, a
  reopened group whose place was taken); this keeps them apart on screen
  without writing anything.
- **Only visible tiles count.** Closed groups and hidden tiles keep their
  saved place but do not reserve space for placement or fit.
- **New tiles** (a group seen for the first time, or any tile with no saved
  place): first free spot in reading order that fits the default size.
- **Reset layout**: after a second click within 3 s confirms, read
  `storage.sync.get(null)` and remove every `tile:` key in one
  `storage.sync.remove` call. Leave settings and all other keys alone, and
  clear this page's pending tile placements. This is the same action in the
  board pane and the options page. Open Foxy boards then place their visible
  tiles as new through the normal storage-change path and existing write
  rules: clock, then pinned, then groups in tab-strip order (this window
  first), then saved, each at the first free spot. Hidden and closed tiles
  no longer have a saved position after a reset.

## 4. Board

- Page: the grid area on the left, the TABS rail on the right. The clock is
  only a tile now; the old clock header is gone.
- **Group tile:** header with dot (recolour), name (rename), bring here (other
  windows), × (close on this device); `OTHER WINDOW` label as today; tab rows
  scroll inside with the existing edge fades.
- **Pinned tile:** today's PINNED column content, including other windows'
  sections and pin rename.
- **Saved tile:** today's SAVED list. Shown when it has entries and is enabled.
- **Clock tile:** time and date scale to the tile: time font size is the
  largest that fits the tile's width and 70% of its height; the date sits
  below when it fits and is enabled.
- **TABS rail:** today's TABS column. Width is a whole number of cells, 3 by
  default, 2 minimum, at most `floor(total / 2)` (but never below 2). Its
  header holds the gear.
- The missing-groups banner stays above the grid.
- Removed: the horizontal strip, `+ NEW GROUP`, column drag (group reordering
  and moving groups between windows by drag). Tile position does not change
  Firefox's tab order. "Bring here" still moves a group to this window.

## 5. Interactions

- **Move a tile:** press on its header and drag past 4 px. A preview shows the
  snapped rectangle and the pushed tiles. Release commits; Escape cancels.
  A click without dragging keeps today's header actions (rename, recolour).
- **Resize a tile:** drag the corner handle (bottom right, shown on hover and
  focus). Snaps to cells, respects minimum and column count, pushes down.
- **Resize the rail:** drag its left edge; snaps to whole cells.
- **Move tabs:** unchanged drag and drop: onto a group tile's rows, the pinned
  tile or the rail, at the insertion line.
- **New group:** drop a tab on empty grid cells. The group is created with
  the tab, its tile is placed at that cell (default size, pushed tiles move
  down), and its name editor opens.
- Pointer events with pointer capture for tiles and the rail edge; HTML5
  drag and drop stays for tab rows.
- Live board updates are held while a tile drag or resize is in progress,
  as they are for tab drags and editors today.

## 6. Storage and sync

- `storage.sync` (synced by Firefox Sync with Add-ons on, which is the
  default):
  - `tile:<id>` → `{ x, y, w, h }`, one key per tile.
  - `settings` → the synced settings object (§7).
- `storage.local`: `deviceSettings` → the device settings object (§7).
- A commit writes only tiles whose rectangle changed (the moved tile and any
  pushed tiles). Edits to different tiles on two devices both survive; the
  same tile is last writer wins.
- `storage.onChanged` (area `sync`) re-renders the board; held during drags.
- Group tiles need the group's folder GUID. The `foxy:saved` reply gains
  `folders: { [groupId]: folderId }` for open groups that are mapped. An
  unmapped group is placed for display only until its folder exists.
- A new group created by a drop on empty cells: the page remembers the target
  rectangle for that group id and writes `tile:group:<folderId>` when the
  mapping arrives (within the page's lifetime).
- Pruning: tile layouts and bookmark folders sync separately and in any
  order, so a tile key can arrive before its folder. Keys are therefore not
  pruned just because their folder is unknown. A tile key is removed when
  its saved group is deleted from the board (with the folder). On load,
  only when there are more than 400 `tile:` keys, keys `tile:group:<id>`
  whose folder is neither open (in `folders`) nor saved (in `saved` or
  `missing`) are removed. A closed group keeps its tile key, so reopening
  returns it to its place.
- First paint: the grid waits for the first `foxy:saved` reply (up to
  500 ms) so groups appear at their saved places. New tiles are written
  only after a valid `foxy:saved` reply with the `folders` map has arrived
  (a failed or malformed reply does not count). A tile placed
  automatically is saved at its full default size, even when the window is
  too narrow to show it; the display caps it. A tile created by dropping a
  tab on empty cells is saved where and at the size it was shown.
- Invalid stored values (wrong types, negative or non-integer cells) are
  ignored and the tile is placed as new.

## 7. Settings

| Section | Setting | Values | Default | Scope |
|---|---|---|---|---|
| Grid | Cell size | S, M, L, XL, custom (40 to 240 px) | M | Device |
| Grid | TABS rail width | 2 to half the columns, in cells | 3 | Synced |
| Tiles | Show clock / pinned / saved | on, off each | on | Synced |
| Tiles | Reset layout | button | | Synced |
| Clock | Time format | 24-hour, 12-hour | 24-hour | Synced |
| Clock | Show date | on, off | on | Synced |
| Cards | Transparency | low, medium, high | medium | Synced |
| Cards | Row density | normal (32 px), compact (24 px) | normal | Device |
| Windows | Show tabs and groups from other windows | on, off | on | Synced |
| Pins | Clicking a pin from another window moves it here | on, off | on | Synced |

- Card transparency sets the card alpha: low 0.75 dark / 0.85 light,
  medium 0.6 / 0.7, high 0.45 / 0.55.
- With other windows off, the board shows only this window's pins, groups
  and tabs.
- With pins moving off, clicking another window's pin focuses that window.
- The pane is a glass panel over the rail, 360 px wide, sections as above,
  plain labels, changes apply immediately. Its fill alpha is
  `min(0.92, card alpha + 0.2)` in each scheme, with blur. While it is open,
  the rail heading and rows are hidden but keep their space and scroll
  position; the gear stays visible and focusable. Escape or the gear closes
  it.
- `options_ui` points at `options.html`, which renders the same pane.
- Hidden tiles keep their saved position unless Reset layout removes it.

## 8. Errors

- Storage failures are logged with the `Foxy:` prefix; the board keeps the
  layout it is showing and retries nothing in a loop.
- Unknown keys in `settings` or `deviceSettings` are ignored; invalid values
  fall back to defaults.

## 9. Testing

- Pure layout tests: columns from width, `place` push chains, `fit` for
  narrow widths, first free spot, defaults per cell size, reset order,
  minimum sizes, column caps.
- Store tests with a fake `storage.sync` (and `onChanged`): only changed
  tiles written, invalid values ignored, pruning rules, settings defaults and
  validation, two-device last-writer-wins per tile.
- Browser tests (headless Firefox, real pointer and drag events): tile move
  and resize with preview and Escape, rail resize, tab drop on rows, rail and
  pinned tile, new group from empty cells, clock tile scaling, settings pane
  controls and live apply, narrow-width display fit.
- Smoke: the grid renders tiles and the rail, the settings pane opens.
- Previews for pixel checks (internal): M and XL cells, narrow window,
  settings pane open.

## 10. Not included

Keyboard moving and resizing of tiles; tiles for single tabs; per-window
layouts; theme settings (the theme is read by Firefox at startup and an
add-on cannot change it).

## 11. Foxy 3.1.0: edge to edge, Android-style drag, gear cell

User feedback on 3.0.0 (2026-10-03). These rules replace the matching parts
of §2 to §5 and §7 where they differ.

### 11.1 Edge to edge

- The board fills the page like a normal web page: no outer margins on any
  side. The theme draws the page as a card with 12 px corners; tiles also
  have 12 px corners, so corner tiles fit it exactly.
- Cells stretch so whole columns fill the width exactly:
  `total = totalColumns(pageWidth, preset)`,
  `cell = (pageWidth + 16) / total - 16` (fractional px allowed). Cells stay
  square (row pitch equals column pitch). The cell size setting is the
  target size; the real cell is at least that and less than one pitch more.
- Gaps between tiles stay 16 px. The grid scrolls vertically from the very
  top to the very bottom of the page.

### 11.2 Gear cell

- The gear is no longer in the TABS header. It sits in its own 1 × 1 card in
  the bottom right cell of the page.
- The TABS rail keeps its width and runs from the top of the page down to
  one gap above the gear cell. The space left of the gear cell is empty.
- The settings pane runs from the top of the page to one gap above the gear
  cell, at the right edge, 360 px wide, 12 px corners. The gear stays
  visible and toggles the pane.

### 11.3 Moving and resizing tiles

- **During a move** the tile follows the pointer freely (no snapping), above
  the other tiles.
- **Target:** the snapped rectangle under the tile (the §5 snapping and
  `clampRect` rules), shown as an outline: a 2 px neutral line with a faint
  fill and 12 px corners. The user asked for this outline; it is the only
  outline on the board.
- **Corner dots:** while a move or resize is in progress, a small neutral dot
  marks every cell corner of the grid. They fade in when the gesture starts
  and out when it ends.
- **Other tiles** slide (about 200 ms) to the layout the board would show if
  the tile were released at the current target: tiles in the way move aside,
  and move back when the target changes. This layout is recomputed only when
  the target changes.
- **Release:** the tile slides from where it is into the outline, then the
  layout is saved as before (only moved and pushed tiles are written).
  **Cancel** (Escape and the other cancel paths): the tile slides back to its
  start and the other tiles slide back.
- **Resize:** the tile's size follows the pointer freely (not below its
  minimum size), with the same outline, dots, sliding and release rules.
- The TABS rail edge keeps snapping in whole cells.
- With reduced motion, nothing slides; positions change at once.

Version: Foxy 3.1.0.
