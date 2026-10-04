import { buildView } from "../../extension/src/grid/view.js";
import { fitCell, railLimits } from "../../extension/src/grid/layout.js";
import { cellPx } from "../../extension/src/settings/store.js";
import { DEFAULT_SETTINGS, DEFAULT_DEVICE } from "../../extension/src/settings/store.js";
import { renderBoard as render } from "../../extension/src/board/render.js";

// Fixed-pixel DOM fixtures use Custom 80 and a three-cell rail.
// Tests of product defaults pass device and synced settings explicitly.
const fixtureSettings = { ...DEFAULT_SETTINGS, railCells: 3 };
const fixtureDevice = { ...DEFAULT_DEVICE, cellSize: "custom", customCell: 80 };

export function renderBoard(root, board, ui, handlers, options = {}) {
  const { layout = [], ...rest } = options;
  const { total } = fitCell(root.getBoundingClientRect().width, cellPx(options.device ?? fixtureDevice));
  const rail = Math.max(2, Math.min(railLimits(total).max, (options.synced ?? fixtureSettings).railCells));
  const k = Math.max(1, total - rail, ...layout.map(t => t.x + t.w));
  const view = buildView(board, { layouts: layout.length ? { [k]: { lastWriteMs: 0, tiles: layout } } : {}, synced: fixtureSettings, device: fixtureDevice,
    contentWidth: root.getBoundingClientRect().width, folders: {}, ...rest });
  render(root, board, view, ui, handlers, options.synced ?? fixtureSettings);
  return view;
}
