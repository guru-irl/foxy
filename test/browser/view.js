import { buildView } from '../../extension/src/kanban/view.js';
import { validBoard } from '../../extension/src/kanban/store.js';
import { DEFAULT_SETTINGS, DEFAULT_DEVICE } from '../../extension/src/settings/store.js';
import { renderBoard as render } from '../../extension/src/board/render.js';

export function renderBoard(root, data, ui, handlers, options = {}) {
  const synced={...DEFAULT_SETTINGS,showMemory:false,showWeather:false,...options.synced};
  const view=buildView(data,{board:validBoard(options.board),synced,device:{...DEFAULT_DEVICE,...options.device},
    contentWidth:root.getBoundingClientRect().width,folders:options.folders??{}});
  render(root,data,view,ui,handlers,synced);
  // Content adaptation tests can exercise a widget's box independently of bars.
  for(const box of options.boxes??[]){
    const node=[...root.querySelectorAll('.widget')].find(n=>n.dataset.tileId===box.id);
    if(!node)continue;
    node.style.width=`${box.width}px`;node.style.height=`${box.height}px`;
    root.querySelector('.widgets-column')?.style.setProperty('width',`${box.width}px`);
  }
  return view;
}
