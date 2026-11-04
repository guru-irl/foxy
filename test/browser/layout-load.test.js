import { test, assert, nextFrame } from './harness.js';
import { createBoardFirefox } from './controller.js';
import { createController } from '../../extension/src/main.js';
import { makeRoot } from './kanban.test.js';

const folders = {1: 'a', 2: 'b', 3: 'c'};
const setup = {windows: [{id: 1}], selfTabId: 99,
  groups: [1, 2, 3].map(id => ({id, windowId: 1, title: `G${id}`})),
  tabs: [{id: 99, windowId: 1}, ...[1, 2, 3].map(id => ({id: 10 + id, windowId: 1, groupId: id, title: 'Tab'}))]};
const writes = ff => ff.calls.filter(c => /storage\.(sync|local)\.(set|remove)$/.test(c.api));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function flush(ff) { for (let i = 0; i < 5; i++) { await ff.settle(); await nextFrame(); } }
function pointer(node, type, x, y) {
  node.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true, isPrimary: true,
    pointerType: 'mouse', pointerId: 17, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y}));
}
async function resize(root, selector, dx = 0, dy = 0) {
  const r = root.querySelector(selector).getBoundingClientRect(), x = Math.floor(r.left + r.width / 2), y = Math.floor(r.top + r.height / 2);
  pointer(root.querySelector(selector), 'pointerdown', x, y);
  pointer(document, 'pointermove', x + dx, y + dy);
  pointer(document, 'pointerup', x + dx, y + dy);
  await nextFrame();
}

for (const failure of ['sync read', 'local read', 'device settings read', 'upgrade write']) {
  test(`${failure} renders default tabs, rail and Settings read-only, then recovers on the 2s retry`, async () => {
    const ff = createBoardFirefox(setup, m => m.type === 'foxy:saved' ? {saved: [], missing: [], folders}
      : m.type === 'foxy:reconcile' ? {ok: true} : undefined);
    // Same failure injections as reviewer probes A and F, plus local storage.
    await ff.browser.storage.sync.set({'layout:20': {t: 1}, 'tile:20:group:a': {x: 0, y: 0, w: 4, h: 3},
      settings: {showClock: false, widgetsWidth: 400}});
    if (failure === 'device settings read') await ff.browser.storage.sync.set({board: {order: ['group:c', 'group:b', 'group:a'], heights: {}, widgets: [], t: 1}});
    const area = failure === 'local read' || failure === 'device settings read' ? 'local' : 'sync', method = failure === 'upgrade write' ? 'set' : 'get';
    const original = ff.browser.storage[area][method];
    ff.browser.storage[area][method] = async () => { throw new Error(failure === 'upgrade write' ? 'QuotaExceeded' : 'storage disabled'); };
    const warn = console.warn; console.warn = () => {};
    const root = await makeRoot(1600);
    const page = document.createElement('div'), pane = document.createElement('aside');
    pane.className = 'settings-pane'; pane.hidden = true;
    root.replaceWith(page); page.append(root, pane);
    try {
      const control = createController(root, ff.browser);
      await control.refresh(); await flush(ff);
      assert.equal(root.querySelectorAll('.kanban-tile').length, 3, 'all tabs render despite failed layout load');
      assert.ok(root.querySelector('.rail'));
      assert.ok(root.querySelector('.clock'), 'failed loads use default settings, not partial settings');
      assert.equal(root.querySelector('.widgets-column').getBoundingClientRect().width, 304);
      root.querySelector('.settings-gear').click();
      assert.equal(pane.hidden, false, 'Settings remains reachable');
      assert.ok(pane.querySelector('.settings-reset'));
      ff.calls.length = 0;
      await resize(root, '.clock .tile-resize', 0, 64);
      await resize(root, '[data-bar="widgetsWidth"]', 64);
      await flush(ff);
      pane.querySelector('[data-key="showClock"]').click();
      const reset = pane.querySelector('.settings-reset'); reset.click();
      await wait(450); reset.click(); await flush(ff);
      assert.equal(writes(ff).length, 0, 'layout, bar and Settings gestures cannot write unread defaults');
      assert.equal(pane.querySelector('[data-key="showClock"]').getAttribute('aria-checked'), 'true', 'a blocked setting rolls back');
      ff.browser.storage[area][method] = original;
      await wait(2200); await flush(ff);
      assert.equal(root.querySelector('.clock'), null, 'the retry re-renders loaded settings');
      assert.equal(root.querySelector('.widgets-column').getBoundingClientRect().width, 400);
      ff.calls.length = 0;
      await resize(root, '.pinned .tile-resize', 0, 64);
      await flush(ff);
      assert.equal(writes(ff).length, 1, 'a successful load enables writes');
    } finally { console.warn = warn; ff.browser.storage[area][method] = original; root.remove(); }
  }, {timeout: 10000});
}

test('a persistent layout failure gets only one automatic retry', async () => {
  const ff = createBoardFirefox(setup);
  let reads = 0;
  ff.browser.storage.sync.get = async () => { reads++; throw new Error('offline'); };
  const warn = console.warn; console.warn = () => {};
  const root = await makeRoot(1600);
  try {
    const control = createController(root, ff.browser);
    await control.refresh(); await flush(ff);
    const initial = reads;
    await wait(2200); await flush(ff);
    assert.ok(reads > initial, 'the load is retried after 2 seconds');
    const retried = reads;
    await wait(2200); await flush(ff);
    assert.equal(reads, retried, 'a persistent failure cannot create a retry loop');
    assert.equal(root.querySelectorAll('.kanban-tile').length, 3);
  } finally { console.warn = warn; root.remove(); }
}, {timeout: 10000});

test('a later read failure keeps the last loaded layout read-only instead of defaults', async () => {
  const ff = createBoardFirefox(setup, m => m.type === 'foxy:saved' ? {saved: [], missing: [], folders}
    : m.type === 'foxy:reconcile' ? {ok: true} : undefined);
  await ff.browser.storage.sync.set({settings: {showClock: false, widgetsWidth: 400},
    board: {order: ['group:c', 'group:b', 'group:a'], heights: {}, widgets: [], t: 1}});
  const warn = console.warn; console.warn = () => {};
  const root = await makeRoot(1600);
  const original = ff.browser.storage.sync.get;
  try {
    const control = createController(root, ff.browser);
    await control.refresh(); await flush(ff);
    assert.equal(root.querySelector('.clock'), null);
    ff.browser.storage.sync.get = async () => { throw new Error('storage disabled'); };
    // Another page's write arrives; reloading it fails.
    await ff.browser.storage.sync.set({board: {order: ['group:c', 'group:b', 'group:a'], heights: {}, widgets: [], t: 2}}); await flush(ff);
    assert.equal(root.querySelector('.clock'), null, 'loaded settings stay; defaults would show the clock');
    assert.equal(root.querySelector('.widgets-column').getBoundingClientRect().width, 400);
    assert.deepEqual([...root.querySelectorAll('.kanban-tile .group-name')].map(n => n.textContent), ['G3', 'G2', 'G1']);
    ff.calls.length = 0;
    await resize(root, '.pinned .tile-resize', 0, 64); await flush(ff);
    assert.equal(writes(ff).length, 0, 'still read-only until a load succeeds');
  } finally { console.warn = warn; ff.browser.storage.sync.get = original; root.remove(); }
}, {timeout: 10000});
