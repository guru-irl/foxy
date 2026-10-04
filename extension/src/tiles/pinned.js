import { pinOrigin } from '../sync/names.js';
import { normalizePinName } from '../sync/codec.js';
import { openNameEditor } from '../board/edit.js';

const el = (tag, className) => Object.assign(document.createElement(tag), { className });
function button(className, label, text = '') {
  const node = el('button', className);
  node.type = 'button'; node.setAttribute('aria-label', label); node.textContent = text;
  return node;
}
function favicon(url) {
  const fallback = () => el('span', 'icon icon-none');
  if (!url) return fallback();
  const image = el('img', 'icon'); image.alt = ''; image.draggable = false;
  image.addEventListener('error', () => image.replaceWith(fallback()), { once: true });
  image.src = url;
  return image;
}

// Tooltips and editors sit outside masked scroll containers. Their anchors stay
// in the tile, so scrolling pins cannot clip the pill or its permission action.
export function pinnedTile(root, sections, handlers, editors) {
  const tile = el('section', 'column fixed pinned'); tile.dataset.zone = 'pinned';
  tile.setAttribute('aria-label', 'Pinned tabs');
  const list = el('div', 'rows pinned-grid'); list.tabIndex = -1; list.dataset.zone = 'pinned';
  const overlays = el('div', 'pin-overlays');
  function hideAll() { for (const tip of overlays.querySelectorAll('.pin-tooltip')) tip.hidden = true; }
  list.addEventListener('scroll', hideAll, { passive: true });
  tile.addEventListener('pointerdown', event => { if (!event.target.closest('.row-open')) hideAll(); });
  tile.addEventListener('dragstart', hideAll);

  for (const section of sections) for (const tab of section.rows) {
    const row = el('div', 'row pin-icon'); row.tabIndex = -1;
    row.dataset.tabId = String(tab.id); row.dataset.windowId = String(tab.windowId);
    const open = button('row-open', tab.title); open.draggable = true;
    open.append(favicon(tab.icon));
    if (tab.active) {
      const dot = el('span', 'pin-active'); dot.setAttribute('aria-hidden', 'true'); open.append(dot);
      open.setAttribute('aria-current', 'page');
    }
    const close = button('row-close', `Close tab: ${tab.title}`, '×');
    close.addEventListener('click', event => { event.stopPropagation(); handlers.onCloseTab?.(tab.id); });
    open.addEventListener('click', event => {
      if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      handlers.onOpen?.(tab);
    });
    const tip = el('div', 'pin-tooltip'); tip.hidden = true; tip.dataset.pinTooltip = String(tab.id);
    const label = el('span', 'pin-tooltip-name'); label.textContent = tab.title;
    tip.append(label);
    if (!section.current) {
      const remote = el('span', 'pin-tooltip-window'); remote.textContent = `OTHER WINDOW · Window ${tab.windowId}`;
      tip.append(remote);
    }
    if (tab.name && tab.origin && tab.allowed === false) {
      const allow = button('pin-allow', `Allow pin name on this site: ${tab.name}`, 'ALLOW');
      allow.addEventListener('click', event => { event.stopPropagation(); handlers.onAllowPin?.(tab.origin); });
      tip.append(allow);
      function tabTo(event, target) {
        if (event.key !== 'Tab' || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault(); target.focus();
      }
      open.addEventListener('keydown', event => { if (!event.shiftKey) tabTo(event, allow); });
      allow.addEventListener('keydown', event => tabTo(event, event.shiftKey ? open : close));
      close.addEventListener('keydown', event => { if (event.shiftKey) tabTo(event, allow); });
    }
    overlays.append(tip);
    function locate(node) {
      const bounds = open.getBoundingClientRect();
      node.style.left = '0px'; node.style.top = '0px';
      const size = node.getBoundingClientRect();
      node.style.left = `${Math.max(4, Math.min(innerWidth - size.width - 4, bounds.left + (bounds.width - size.width) / 2))}px`;
      const below = bounds.bottom + 6;
      node.style.top = `${Math.max(4, below + size.height <= innerHeight - 4 ? below : bounds.top - size.height - 6)}px`;
    }
    function show() {
      if (root.hasAttribute('data-dragging') || root.hasAttribute('data-grid-dragging') || root.querySelector('.name-editor')) return;
      hideAll(); tip.hidden = false; locate(tip);
    }
    const owns = node => node instanceof Node && (row.contains(node) || tip.contains(node));
    row.addEventListener('mouseenter', show);
    row.addEventListener('focusin', show);
    row.addEventListener('mouseleave', event => { if (!owns(event.relatedTarget)) tip.hidden = true; });
    row.addEventListener('focusout', event => { if (!owns(event.relatedTarget)) tip.hidden = true; });
    tip.addEventListener('mouseleave', event => { if (!owns(event.relatedTarget)) tip.hidden = true; });
    tip.addEventListener('focusout', event => { if (!owns(event.relatedTarget)) tip.hidden = true; });
    function rename() {
      if (root.querySelector('.pin-name-editor')) return;
      editors.get(root)?.finish(); hideAll();
      handlers.onEditState?.(true, null, tab.id);
      const active = { finish: null, cancel: null }; editors.set(root, active);
      open.draggable = false;
      const end = () => {
        open.draggable = true;
        if (editors.get(root) !== active) return;
        editors.delete(root); handlers.onEditEnd?.(null, tab.id);
      };
      const initialName = normalizePinName(tab.name ?? tab.title), initial = initialName.slice(0, 200);
      const editor = openNameEditor(open, {
        initial, className: 'name-editor pin-name-editor', updateLabel: false, maxLength: 200, mount: overlays,
        onSave: name => {
          try {
            if (name === initial.trim()) return;
            name = normalizePinName(name);
            if (name === initialName) return;
            label.textContent = name || tab.title;
            open.setAttribute('aria-label', label.textContent);
            handlers.onRenamePin?.(tab.id, name || null, tab.origin ?? pinOrigin(tab.url));
          } finally { end(); }
        }, onCancel: end,
      });
      locate(overlays.querySelector('.pin-name-editor'));
      active.finish = editor.save; active.cancel = editor.cancel;
    }
    row.addEventListener('contextmenu', event => {
      if (!event.target.closest('.row-open')) return;
      event.preventDefault(); event.stopPropagation(); rename();
    });
    row.addEventListener('keydown', event => {
      if (event.key !== 'F2' || event.isComposing || event.target.matches('input')) return;
      event.preventDefault(); event.stopPropagation(); rename();
    });
    row.append(open, close); list.append(row);
  }
  list.addEventListener('keydown', event => {
    if (!event.target.matches('.row-open') || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const buttons = [...list.querySelectorAll('.row-open')], index = buttons.indexOf(event.target);
    const cols = Number(tile.style.getPropertyValue('--w'));
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[event.key];
    if (offset === undefined) return;
    event.preventDefault(); event.stopPropagation();
    buttons[Math.max(0, Math.min(buttons.length - 1, index + offset))]?.focus();
  });
  tile.append(list);
  return { tile, overlays };
}

// Pin drop slots are row-major, but unlike tab rows their insertion axis is
// horizontal. Scroll offsets and fractional cell pitches stay in CSS pixels.
export function pinnedPlacement(zone, x, y) {
  const items = [...zone.querySelectorAll(':scope > .row')], bounds = zone.getBoundingClientRect();
  const cell = parseFloat(getComputedStyle(zone).getPropertyValue('--cell')), pitch = cell + 16;
  const cols = Number(zone.closest('.tile').style.getPropertyValue('--w'));
  const row = Math.max(0, Math.floor((y - bounds.top + zone.scrollTop) / pitch));
  const localX = Math.max(0, x - bounds.left), col = Math.min(cols - 1, Math.floor(localX / pitch));
  const slot = Math.min(items.length, row * cols + col + (localX - col * pitch >= cell / 2 ? 1 : 0));
  const before = items[slot]?.getBoundingClientRect(), after = items[slot - 1]?.getBoundingClientRect();
  return { slot, offset: (before?.top ?? after?.top ?? bounds.top) - bounds.top + zone.scrollTop,
    left: Math.max(0, Math.min(zone.clientWidth - 2, (before ? before.left - 8 : after ? after.right + 8 : bounds.left) - bounds.left)) };
}
