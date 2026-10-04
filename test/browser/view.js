import { buildView } from "../../extension/src/grid/view.js";
import { fitCell, railLimits } from "../../extension/src/grid/layout.js";
import { cellPx } from "../../extension/src/settings/store.js";
import { DEFAULT_SETTINGS as ALL_SETTINGS, DEFAULT_DEVICE } from "../../extension/src/settings/store.js";
import { renderBoard as render } from "../../extension/src/board/render.js";

const DEFAULT_SETTINGS = { ...ALL_SETTINGS, showMemory: false };

export function renderBoard(root, board, ui, handlers, options = {}) {
  const { layout = [], ...rest } = options;
  const { total } = fitCell(root.getBoundingClientRect().width, cellPx(options.device ?? DEFAULT_DEVICE));
  const rail = Math.max(2, Math.min(railLimits(total).max, (options.synced ?? DEFAULT_SETTINGS).railCells));
  const k = Math.max(1, total - rail, ...layout.map(t => t.x + t.w));
  const view = buildView(board, { layouts: layout.length ? { [k]: { lastWriteMs: 0, tiles: layout } } : {}, synced: DEFAULT_SETTINGS, device: DEFAULT_DEVICE,
    contentWidth: root.getBoundingClientRect().width, folders: {}, ...rest, synced: { showMemory: false, ...(rest.synced ?? DEFAULT_SETTINGS) } });
  render(root, board, view, ui, handlers, options.synced ?? DEFAULT_SETTINGS);
  return view;
}
