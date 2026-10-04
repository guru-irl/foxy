import { pinOrigin } from '../sync/names.js';
import { normalizePinName } from '../sync/codec.js';
import { openNameEditor } from '../board/edit.js';

const hoveredPins = new WeakMap();
const tooltipShows = new WeakMap();

export function showPinnedTooltip(tip) { tooltipShows.get(tip)?.(); }

// Runs after the controller has restored scroll offsets. A replacement icon
// must still own the pointer position and the same tab identity.
export function restorePinnedHover(root) {
  const pointer = hoveredPins.get(root);
  if (!pointer || !root.isConnected) return;
  const row = document.elementFromPoint(pointer.x, pointer.y)?.closest('.pin-icon');
  if (row && root.contains(row) && row.dataset.tabId === pointer.id) {
    showPinnedTooltip(root.querySelector(`[data-pin-tooltip="${pointer.id}"]`));
  }
}

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
  const hideTimers = new Map();
  function cancelHide(tip) { clearTimeout(hideTimers.get(tip)); hideTimers.delete(tip); }
  function hide(tip) { cancelHide(tip); tip.hidden = true; }
  function hideAll() { for (const tip of overlays.querySelectorAll('.pin-tooltip')) hide(tip); }
  function hideLater(tip) {
    cancelHide(tip);
    hideTimers.set(tip, setTimeout(() => hide(tip), 150));
  }
  function onScroll() {
    const focused = document.activeElement.closest?.('.pin-tooltip');
    if (focused && overlays.contains(focused)) showPinnedTooltip(focused);
    else hideAll();
  }
  list.addEventListener('scroll', onScroll, { passive: true });
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
      const remote = el('span', 'pin-tooltip-window'); remote.textContent = 'OTHER WINDOW';
      tip.append(remote);
    }
    const needsAccess = tab.name && tab.origin && tab.allowed === false;
    if (needsAccess) {
      const cue = el('span', 'pin-needs-access'); cue.setAttribute('aria-hidden', 'true'); open.append(cue);
      open.setAttribute('aria-label', `${tab.title}, needs site access`);
      const allow = button('pin-allow', `Allow pin name on this site: ${tab.name}`, 'ALLOW');
      allow.addEventListener('click', event => { event.stopPropagation(); handlers.onAllowPin?.(tab.origin); });
      tip.append(allow);
      function tabTo(event, target) {
        if (event.key !== 'Tab' || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
        if (tip.hidden) show();
        target.focus();
        if (document.activeElement === target) event.preventDefault();
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
      for (const other of overlays.querySelectorAll('.pin-tooltip')) if (other !== tip) hide(other);
      cancelHide(tip); tip.hidden = false; locate(tip);
    }
    const owns = node => node instanceof Node && (row.contains(node) || tip.contains(node));
    const rememberPointer = event => hoveredPins.set(root, { id: String(tab.id), x: event.clientX, y: event.clientY });
    tooltipShows.set(tip, show);
    row.addEventListener('mouseenter', event => { rememberPointer(event); show(); });
    row.addEventListener('mousemove', rememberPointer);
    row.addEventListener('focusin', show);
    row.addEventListener('mouseleave', event => {
      if (hoveredPins.get(root)?.id === String(tab.id)) hoveredPins.delete(root);
      if (!owns(event.relatedTarget)) hideLater(tip);
    });
    row.addEventListener('focusout', event => { if (!owns(event.relatedTarget)) hide(tip); });
    tip.addEventListener('mouseenter', () => cancelHide(tip));
    tip.addEventListener('mouseleave', event => { if (!owns(event.relatedTarget)) hideLater(tip); });
    tip.addEventListener('focusout', event => { if (!owns(event.relatedTarget)) hide(tip); });
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
            open.setAttribute('aria-label', label.textContent + (needsAccess ? ', needs site access' : ''));
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
    if (event.key === 'ArrowUp' && index < cols) return;
    if (event.key === 'ArrowDown' && Math.floor(index / cols) === Math.floor((buttons.length - 1) / cols)) return;
    buttons[Math.max(0, Math.min(buttons.length - 1, index + offset))]?.focus();
  });
  tile.append(list);
  return { tile, overlays, onScroll };
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
