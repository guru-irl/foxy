import { test, assert, fixture, nextFrame, dispatchDrag, withPseudoState } from './harness.js';
import { buildBoard } from '../../extension/src/board/model.js';
import { renderBoard } from './view.js';

let css;
async function draw({ width = 1280, height = 600, target = 48, count = 9, w = 3, h = 2, x = 1, y = 1, scheme = 'dark', names } = {}, handlers = {}) {
  css ??= new Promise(resolve => {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/extension/newtab.css';
    link.onload = resolve; document.head.append(link);
  });
  await css;
  const root = document.createElement('div'); root.className = 'board';
  root.style.cssText = `width:${width}px;height:${height}px;color-scheme:${scheme}`; fixture().append(root);
  const board = buildBoard({ windows: [{ id: 1, type: 'normal' }, { id: 2, type: 'normal' }],
    tabs: Array.from({ length: count }, (_, i) => ({ id: i + 1, index: i, windowId: i < count - 1 ? 1 : 2,
      title: `Page ${i + 1}`, url: `https://example.invalid/${i}`, pinned: true, active: i === 0 })),
    groups: [], currentWindowId: 1, pins: names ?? { [count]: { name: 'Named pin', origin: null, allowed: false } } });
  const view = renderBoard(root, board, {}, handlers, { boxes: [{ id: 'pinned', width: w * 64, height: 32 + h * 64 }],
    synced: { showClock: false, showPinned: true, showSaved: false, railCells: 3 },
    device: { cellSize: target === 48 ? 'S' : 'custom', customCell: target, density: 'normal' } });
  await nextFrame();
  return { root, view, board, options: { boxes: [{ id: 'pinned', width: w * 64, height: 32 + h * 64 }],
    synced: { showClock: false, showPinned: true, showSaved: false, railCells: 3 },
    device: { cellSize: target === 48 ? 'S' : 'custom', customCell: target, density: 'normal' } }, tile: root.querySelector('[data-kind="pinned"]'), list: root.querySelector('.rows[data-zone="pinned"]') };
}
function near(got, want, label) { assert.ok(Math.abs(got - want) < 0.03, `${label}: ${got} != ${want}`); }
function key(node, value) { node.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })); }
function pointer(target, type, x, y) {
  target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 501, isPrimary: true,
    pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
}

for (const scheme of ['dark','light']) test(`${scheme} pinned icons flow with 48px boxes and 16px gaps`, async()=>{
  const {tile,list}=await draw({scheme});const pins=[...list.querySelectorAll('.row')],bounds=list.getBoundingClientRect();
  assert.equal(tile.querySelector('.column-title').textContent,'PINNED');
  for(let i=0;i<pins.length;i++){
    const r=pins[i].getBoundingClientRect();near(r.left,bounds.left+i%3*64,'left');near(r.top,bounds.top+Math.floor(i/3)*64,'top');
    near(r.width,48,'width');near(r.height,48,'height');assert.equal(pins[i].querySelector('.row-open').draggable,true);
  }
  assert.ok(list.scrollHeight>list.clientHeight);list.scrollTop=list.scrollHeight;await nextFrame();await nextFrame();
  assert.ok(list.hasAttribute('data-scroll-start'));assert.equal(list.hasAttribute('data-scroll-end'),false);
});

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
  pin.dispatchEvent(new MouseEvent('mouseleave'));
  assert.equal(tooltip.hidden, false, 'leaving starts the hover grace');
  await new Promise(resolve => setTimeout(resolve, 180)); assert.ok(tooltip.hidden);
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

test('pin tooltip overlays do not add a flex gap or widen the board', async () => {
  const { root } = await draw();
  const rail = root.querySelector('.rail').getBoundingClientRect(), bounds = root.getBoundingClientRect();
  near(rail.right, bounds.right, 'rail ends at the board edge');
  assert.equal(root.scrollWidth, root.clientWidth, 'tooltips do not change the board scroll extent');
});

for (const backwards of [false, true]) test(`Tab ${backwards ? 'backwards from close' : 'from open'} reveals a hidden ALLOW tooltip and moves focus`, async () => {
  const { root, list } = await draw({ count: 3, names: { 3: { name: 'Named', origin: 'https://example.invalid/*', allowed: false } } });
  const pin = list.lastElementChild, open = pin.querySelector('.row-open'), close = pin.querySelector('.row-close');
  const start = backwards ? close : open; start.focus();
  start.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  const tip = root.querySelector('[data-pin-tooltip="3"]'), allow = tip.querySelector('.pin-allow');
  assert.equal(tip.hidden, false);
  list.firstElementChild.dispatchEvent(new MouseEvent('mouseenter'));
  assert.equal(tip.hidden, true, 'the pointer can hide a still-focused pin tooltip');
  const tab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: backwards, bubbles: true, cancelable: true });
  start.dispatchEvent(tab);
  assert.equal(tip.hidden, false, 'show the tooltip before moving focus');
  assert.equal(document.activeElement, allow);
  assert.ok(tab.defaultPrevented, 'successful focus movement replaces native Tab');
});

test('Tab leaves native navigation alone if the ALLOW action cannot receive focus', async () => {
  const { root, list } = await draw({ count: 3, names: { 3: { name: 'Named', origin: 'https://example.invalid/*', allowed: false } } });
  const open = list.lastElementChild.querySelector('.row-open'); open.focus();
  root.querySelector('[data-pin-tooltip="3"] .pin-allow').disabled = true;
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }); open.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, false, 'never swallow Tab when focus did not move');
});

for (const scheme of ['dark', 'light']) test(`${scheme} pending pin access has a muted top-left cue separate from the active dot`, async () => {
  const names = {
    1: { name: 'Pending', origin: 'https://example.invalid/*', allowed: false },
    2: { name: 'Allowed', origin: 'https://example.invalid/*', allowed: true },
    3: { name: 'No origin', origin: null, allowed: false },
  };
  const { list } = await draw({ count: 4, scheme, names });
  const pin = list.firstElementChild, open = pin.querySelector('.row-open'), dot = open.querySelector('.pin-needs-access');
  assert.ok(dot, 'a named pin without site access must advertise ALLOW without hovering');
  assert.equal(open.getAttribute('aria-label'), 'Pending, needs site access');
  assert.equal(dot.getAttribute('aria-hidden'), 'true');
  const square = open.getBoundingClientRect(), r = dot.getBoundingClientRect(), style = getComputedStyle(dot);
  near(r.width, 4, 'access cue width'); near(r.height, 4, 'access cue height');
  assert.ok(r.left >= square.left && r.right < square.left + square.width / 2);
  assert.ok(r.top >= square.top && r.bottom < square.top + square.height / 2);
  assert.equal(style.borderTopWidth, '0px'); assert.equal(style.boxShadow, 'none');
  assert.equal(style.backgroundColor, getComputedStyle(open).color, 'cue uses text colour');
  assert.ok(Number(style.opacity) > 0 && Number(style.opacity) <= 0.4, 'muted low-alpha cue');
  const active = open.querySelector('.pin-active').getBoundingClientRect();
  near(active.left + active.width / 2, square.left + square.width / 2, 'active dot stays centred');
  assert.ok(active.top > square.top + square.height / 2, 'active dot stays at the bottom');
  for (const other of [...list.children].slice(1)) assert.equal(other.querySelector('.pin-needs-access'), null);
});

for (const above of [false, true]) test(`pin tooltip ${above ? 'above' : 'below'} stays reachable across the mouse gap and cancels its 150ms hide`, async () => {
  const allowed = [], { root, list, view } = await draw({ count: 1, w: 1, h: 1, x: 1, y: 0,
    names: { 1: { name: 'Named', origin: 'https://example.invalid/*', allowed: false } } }, { onAllowPin: origin => allowed.push(origin) });
  root.style.position = 'fixed'; root.style.left = '0'; root.style.top = above ? `${innerHeight - 100}px` : '0';
  await nextFrame();
  const pin = list.firstElementChild, open = pin.querySelector('.row-open'); pin.dispatchEvent(new MouseEvent('mouseenter'));
  const tip = root.querySelector('[data-pin-tooltip="1"]'), allow = tip.querySelector('.pin-allow');
  const a = open.getBoundingClientRect(), b = allow.getBoundingClientRect(), t = tip.getBoundingClientRect();
  assert.ok(above ? t.bottom < a.top : t.top > a.bottom, 'exercise the tooltip on the requested side');
  const start = { x: a.left + a.width / 2, y: a.top + a.height / 2 }, end = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  const steps = Math.ceil(Math.hypot(end.x - start.x, end.y - start.y));
  let left = false, entered = false;
  for (let i = 1; i <= steps; i++) {
    const hit = document.elementFromPoint(start.x + (end.x - start.x) * i / steps, start.y + (end.y - start.y) * i / steps);
    if (!left && !pin.contains(hit)) {
      left = true; pin.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: hit }));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(tip.hidden, false, 'tooltip must survive crossing the dead gap');
    if (!entered && tip.contains(hit)) {
      entered = true; tip.dispatchEvent(new MouseEvent('mouseenter', { relatedTarget: pin }));
    }
  }
  assert.ok(left && entered, 'the mouse path must cross from the icon into the tooltip');
  await new Promise(resolve => setTimeout(resolve, 180)); assert.equal(tip.hidden, false, 'tooltip entry cancels the pending hide');
  const hit = document.elementFromPoint(end.x, end.y); assert.ok(allow.contains(hit)); hit.click();
  assert.deepEqual(allowed, ['https://example.invalid/*']);
  tip.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: document.body }));
  assert.equal(tip.hidden, false); await new Promise(resolve => setTimeout(resolve, 180)); assert.equal(tip.hidden, true);
});

test('vertical arrows do nothing at the first and last grid rows, but land in a partial last row', async () => {
  const { list } = await draw({ count: 9, w: 6 }); const buttons = [...list.querySelectorAll('.row-open')];
  buttons[3].focus(); key(buttons[3], 'ArrowUp'); assert.equal(document.activeElement, buttons[3], 'top-row Up is a no-op');
  buttons[7].focus(); key(buttons[7], 'ArrowDown'); assert.equal(document.activeElement, buttons[7], 'last-row Down is a no-op');
  buttons[4].focus(); key(buttons[4], 'ArrowDown'); assert.equal(document.activeElement, buttons[8], 'a short destination row lands on its last pin');
});

for (const stillOver of [true, false]) test(`pin tooltip rerender ${stillOver ? 'retains hover at the stationary pointer' : 'does not retain hover after the pointer leaves'}`, async () => {
  const { root, list, board, options } = await draw({ count: 3 });
  const pin = list.lastElementChild, r = pin.querySelector('.row-open').getBoundingClientRect();
  const point = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  pin.dispatchEvent(new MouseEvent('mouseenter', point)); assert.equal(root.querySelector('[data-pin-tooltip="3"]').hidden, false);
  if (!stillOver) pin.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: document.body, clientX: 900, clientY: 500 }));
  const changed = { ...board, pinned: board.pinned.map(section => ({ ...section, rows: section.rows.map(tab => ({ ...tab, title: tab.id === 3 ? 'Updated title' : tab.title })) })) };
  renderBoard(root, changed, {}, {}, options); await nextFrame(); await nextFrame();
  assert.equal(root.querySelector('[data-pin-tooltip="3"]').hidden, !stillOver, 'restore only the tooltip still under the pointer');
  assert.equal(root.querySelector('[data-pin-tooltip="3"] .pin-tooltip-name').textContent, 'Updated title');
});

for (const scheme of ['dark', 'light']) for (const state of ['hover', 'active', 'focus-visible']) {
  test(`${scheme} pin ${state} paints only the square, not its cell`, async () => {
    const { list } = await draw({ count: 1, scheme }), cell = list.firstElementChild, open = cell.querySelector('.row-open');
    const before = getComputedStyle(open).backgroundColor;
    withPseudoState(state === 'hover' ? [cell, open] : [open], state, () => {
      assert.equal(getComputedStyle(cell).backgroundColor, 'rgba(0, 0, 0, 0)', 'the move margin stays transparent');
      assert.ok(getComputedStyle(open).backgroundColor !== before, 'interaction changes the square fill');
      assert.equal(getComputedStyle(open).borderRadius, '8px');
      assert.equal(getComputedStyle(open).boxShadow, 'none'); assert.equal(getComputedStyle(open).outlineStyle, 'none');
    });
  });
}
