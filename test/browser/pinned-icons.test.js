import { test, assert, fixture, nextFrame, dispatchDrag, withPseudoState } from './harness.js';
import { buildBoard } from '../../extension/src/board/model.js';
import { renderBoard } from './view.js';
import { attachGridDrag } from '../../extension/src/grid/drag.js';

let css;
async function draw({ width = 1280, target = 48, count = 9, w = 3, h = 2, scheme = 'dark' } = {}, handlers = {}) {
  css ??= new Promise(resolve => {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/extension/newtab.css';
    link.onload = resolve; document.head.append(link);
  });
  await css;
  const root = document.createElement('div'); root.className = 'board';
  root.style.cssText = `width:${width}px;height:600px;color-scheme:${scheme}`; fixture().append(root);
  const board = buildBoard({ windows: [{ id: 1, type: 'normal' }, { id: 2, type: 'normal' }],
    tabs: Array.from({ length: count }, (_, i) => ({ id: i + 1, index: i, windowId: i < count - 1 ? 1 : 2,
      title: `Page ${i + 1}`, url: `https://example.invalid/${i}`, pinned: true, active: i === 0 })),
    groups: [], currentWindowId: 1, pins: { [count]: { name: 'Named pin', origin: null, allowed: false } } });
  const view = renderBoard(root, board, {}, handlers, { layout: [{ id: 'pinned', x: 1, y: 1, w, h }],
    synced: { showClock: false, showPinned: true, showSaved: false, railCells: 3 },
    device: { cellSize: target === 48 ? 'S' : 'custom', customCell: target, density: 'normal' } });
  await nextFrame();
  return { root, view, tile: root.querySelector('[data-kind="pinned"]'), list: root.querySelector('.rows[data-zone="pinned"]') };
}
function near(got, want, label) { assert.ok(Math.abs(got - want) < 0.03, `${label}: ${got} != ${want}`); }
function key(node, value) { node.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })); }
function pointer(target, type, x, y) {
  target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 501, isPrimary: true,
    pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
}

for (const [target, width] of [[48, 1280], [73, 1297]]) for (const scheme of ['dark', 'light']) {
  test(`${scheme} pinned icons align with cells at ${target} target and ${width}px width`, async () => {
    const { tile, list, view } = await draw({ target, width, scheme });
    const bounds = tile.getBoundingClientRect(), pins = [...list.querySelectorAll('.row')], pitch = view.cell + 16;
    assert.equal(tile.querySelector('.column-title, .column-header, .subheading, .window-gap'), null);
    assert.equal(pins.length, 9);
    for (let i = 0; i < pins.length; i++) {
      const box = pins[i].getBoundingClientRect(), button = pins[i].querySelector('.row-open'), icon = button.querySelector('.icon');
      near(box.left, bounds.left + (i % 3) * pitch, `pin ${i} left`);
      near(box.top, bounds.top + Math.floor(i / 3) * pitch, `pin ${i} top`);
      near(box.width, view.cell, 'cell width'); near(box.height, view.cell, 'cell height');
      const inset = button.getBoundingClientRect(), favicon = icon.getBoundingClientRect();
      near(inset.left - box.left, 8, 'left inset'); near(inset.top - box.top, 8, 'top inset');
      near(inset.width, view.cell - 16, 'square width'); near(inset.height, view.cell - 16, 'square height');
      near(favicon.left + favicon.width / 2, inset.left + inset.width / 2, 'favicon horizontal centre');
      near(favicon.top + favicon.height / 2, inset.top + inset.height / 2, 'favicon vertical centre');
      assert.equal(button.tabIndex, 0); assert.equal(button.draggable, true);
      const style = getComputedStyle(button);
      assert.equal(style.boxShadow, 'none'); assert.equal(style.borderTopWidth, '0px'); assert.equal(style.outlineStyle, 'none');
    }
    assert.ok(pins[0].querySelector('.pin-active')); assert.equal(pins[1].querySelector('.pin-active'), null);
    assert.ok(list.scrollHeight > list.clientHeight); assert.ok(list.hasAttribute('data-scroll-end'));
    list.scrollTop = list.scrollHeight; await nextFrame(); await nextFrame();
    assert.ok(list.hasAttribute('data-scroll-start')); assert.equal(list.hasAttribute('data-scroll-end'), false);
    assert.ok(getComputedStyle(list).maskImage.includes('linear-gradient'));
  });
}

for (const scheme of ['dark', 'light']) test(`${scheme} pin hover exposes renamed tooltip and remote label, with close only on hover or focus`, async () => {
  const opened = [], closed = [], { root, list } = await draw({ scheme, count: 3 }, {
    onOpen: pin => opened.push(pin.id), onCloseTab: id => closed.push(id) });
  const pin = list.lastElementChild, open = pin.querySelector('.row-open'), close = pin.querySelector('.row-close');
  assert.equal(open.getAttribute('aria-label'), 'Named pin');
  assert.equal(getComputedStyle(close).opacity, '0');
  pin.dispatchEvent(new MouseEvent('mouseenter'));
  const tooltip = root.querySelector('[data-pin-tooltip="3"]'); assert.ok(tooltip && !tooltip.hidden);
  assert.equal(tooltip.querySelector('.pin-tooltip-name').textContent, 'Named pin');
  assert.ok(tooltip.querySelector('.pin-tooltip-window').textContent.includes('OTHER WINDOW'));
  const style = getComputedStyle(tooltip);
  assert.equal(style.boxShadow, 'none'); assert.equal(style.borderTopWidth, '0px'); assert.equal(style.outlineStyle, 'none');
  assert.ok(parseFloat(style.borderRadius) >= 100);
  withPseudoState([pin], 'hover', () => assert.equal(getComputedStyle(close).opacity, '1'));
  close.click(); assert.deepEqual(closed, [3]); assert.deepEqual(opened, []);
  open.click(); assert.deepEqual(opened, [3]);
  pin.dispatchEvent(new MouseEvent('mouseleave')); assert.ok(tooltip.hidden);
});

test('pin arrows move through the row-major grid and context rename cancels with focus restored', async () => {
  const { root, list } = await draw(); const buttons = [...list.querySelectorAll('.row-open')];
  buttons[0].focus(); key(buttons[0], 'ArrowRight'); assert.equal(document.activeElement, buttons[1]);
  key(buttons[1], 'ArrowDown'); assert.equal(document.activeElement, buttons[4]);
  key(buttons[4], 'ArrowLeft'); assert.equal(document.activeElement, buttons[3]);
  key(buttons[3], 'ArrowUp'); assert.equal(document.activeElement, buttons[0]);
  key(buttons[0], 'ArrowLeft'); assert.equal(document.activeElement, buttons[0]);
  buttons[8].focus(); key(buttons[8], 'ArrowDown'); assert.equal(document.activeElement, buttons[8]);
  buttons[8].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const input = root.querySelector('.name-editor'); assert.ok(input); assert.equal(input.value, 'Named pin');
  assert.ok(buttons[8].isConnected, 'renaming keeps the favicon visible in its cell');
  assert.equal(buttons[8].draggable, false, 'renaming disables the tab drag source');
  const editingDrag = dispatchDrag('dragstart', buttons[8]);
  assert.equal(root.hasAttribute('data-dragging'), false, 'a portalled editor still blocks tab drags');
  dispatchDrag('dragend', buttons[8], { dataTransfer: editingDrag.dataTransfer });
  key(input, 'Escape'); assert.equal(document.activeElement, buttons[8]);
  assert.equal(root.querySelector('.name-editor'), null);
  assert.equal(buttons[8].draggable, true);
});

for (const w of [1, 3]) test(`the last pin close centre is clickable beside the resize corner at width ${w}`, async () => {
  const { tile, list } = await draw({ count: w, w, h: 1 });
  const close = list.lastElementChild.querySelector('.row-close'), r = close.getBoundingClientRect();
  assert.equal(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2), close,
    'the close centre must not be covered by the corner handle');
  const corner = tile.getBoundingClientRect();
  assert.equal(document.elementFromPoint(corner.right - 2, corner.top + 2).dataset.corner, 'ne', 'corners still win');
});

test('pin tooltip overlays do not add a flex gap or widen the board', async () => {
  const { root } = await draw();
  const rail = root.querySelector('.rail').getBoundingClientRect(), bounds = root.getBoundingClientRect();
  near(rail.right, bounds.right, 'rail ends at the board edge');
  assert.equal(root.scrollWidth, root.clientWidth, 'tooltips do not change the board scroll extent');
});

test('pinned empty space moves the tile, icons remain tab drags, and all corners resize to one cell', async () => {
  const { root, tile, list, view } = await draw({ count: 1 }); const commits = [], states = [];
  let settled;
  async function cancelGesture() {
    const done = new Promise(resolve => { settled = resolve; });
    key(document, 'Escape'); await done;
  }
  const detach = attachGridDrag(root, { view: () => view, canCommit: () => true, onPreview() {},
    onCommit: value => commits.push(value), onCancel() {}, onRail() {}, onState: value => { states.push(value); if (!value) settled?.(); } });
  try {
    const bounds = tile.getBoundingClientRect(), pitch = view.cell + 16;
    pointer(list, 'pointerdown', bounds.left + pitch + 24, bounds.top + 24);
    pointer(document, 'pointermove', bounds.left + 2 * pitch + 24, bounds.top + 24);
    assert.ok(tile.classList.contains('dragging')); await cancelGesture();
    const open = list.querySelector('.row-open');
    pointer(open, 'pointerdown', bounds.left + 24, bounds.top + 24);
    pointer(document, 'pointermove', bounds.left + pitch + 24, bounds.top + 24);
    assert.equal(tile.classList.contains('dragging'), false);
    dispatchDrag('dragstart', open); assert.ok(root.hasAttribute('data-dragging')); dispatchDrag('dragend', open);
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      const handle = tile.querySelector(`[data-corner="${corner}"]`), r = handle.getBoundingClientRect();
      pointer(handle, 'pointerdown', r.left + 8, r.top + 8);
      const west = corner.endsWith('w'), north = corner.startsWith('n');
      pointer(document, 'pointermove', west ? bounds.right + 100 : bounds.left - 100, north ? bounds.bottom + 100 : bounds.top - 100);
      const outline = root.querySelector('.drop-outline'); assert.ok(outline);
      assert.equal(outline.style.getPropertyValue('--w'), '1'); assert.equal(outline.style.getPropertyValue('--h'), '1');
      near(tile.getBoundingClientRect().width, view.cell, 'free width minimum');
      near(tile.getBoundingClientRect().height, view.cell, 'free height minimum');
      await cancelGesture();
    }
    assert.deepEqual(commits, []); assert.ok(states.includes(true));
  } finally { detach(); }
});
