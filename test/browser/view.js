import { buildView } from "../../extension/src/grid/view.js";
import { DEFAULT_SETTINGS, DEFAULT_DEVICE } from "../../extension/src/settings/store.js";
import { renderBoard as render } from "../../extension/src/board/render.js";

export function renderBoard(root, board, ui, handlers, options = {}) {
  const view = buildView(board, { layout: [], synced: DEFAULT_SETTINGS, device: DEFAULT_DEVICE,
    contentWidth: root.getBoundingClientRect().width, folders: {}, ...options });
  render(root, board, view, ui, handlers, options.synced ?? DEFAULT_SETTINGS);
  return view;
}
