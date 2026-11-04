import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFirefox } from './fakes/firefox.js';
const store = await import('../extension/src/kanban/store.js').catch(() => ({}));
const kinds = ['clock','pinned','weather','memory','saved'];
const defaults = {order:[],heights:{},widgets:kinds.map(kind=>({kind,h:null})),t:0};

test('board validates the storage boundary and excludes local-only identities', () => {
  assert.deepEqual(store.validBoard?.({ order:['group:a','local:9','bad','group:a','group:b'],
    heights:{'group:a':4,'group:b':41,'group:c':1,'group:d':2,'local:9':5}, widgets:[{kind:'saved',h:200},{kind:'saved',h:300},{kind:'bad',h:4}], t:12 }),
  {order:['group:a','group:b'],heights:{'group:a':4,'group:d':2},widgets:[{kind:'saved',h:200},...kinds.slice(0,4).map(kind=>({kind,h:null}))],t:12});
  assert.deepEqual(store.validBoard?.(null),defaults);
});
test('renders track absence but never write; a gesture prunes only after a full missing cycle', async () => {
  assert.equal(typeof store.createBoardStore,'function');
  const ff=createFirefox(); await ff.browser.storage.sync.set({board:{...defaults,order:['group:a','group:b']}});
  const state=store.createBoardStore(ff.browser); await state.load(); ff.calls.length=0;
  state.observe(new Set(['group:a']));
  assert.equal(ff.calls.some(c=>c.api.endsWith('.set')||c.api.endsWith('.remove')),false);
  await state.gesture(b=>b, new Set(['group:a']), 20);
  assert.deepEqual((await ff.browser.storage.sync.get('board')).board.order,['group:a','group:b']);
  state.observe(new Set(['group:a']));
  await state.gesture(b=>({...b,order:['group:a','group:c',...b.order]}),new Set(['group:a','group:c']),21);
  assert.deepEqual((await ff.browser.storage.sync.get('board')).board.order,['group:a','group:c']);
});
test('gesture caps ids and evicts unknowns before live groups; one sync set', async () => {
  assert.equal(typeof store.createBoardStore,'function');
  const ff=createFirefox(); await ff.browser.storage.sync.set({board:defaults});
  const state=store.createBoardStore(ff.browser); await state.load(); ff.calls.length=0;
  const order=Array.from({length:405},(_,i)=>`group:${i}`);
  await state.gesture(b=>({...b,order}),new Set(['group:0','group:404']),30);
  const written=(await ff.browser.storage.sync.get('board')).board;
  assert.equal(written.order.length,400); assert.ok(written.order.includes('group:0'));
  assert.ok(written.order.includes('group:404')); assert.equal(written.order.includes('group:1'),false);
  assert.equal(ff.calls.filter(c=>c.api==='storage.sync.set').length,1);
});
test('3.x upgrade uses last shown layout, sorts y then x, converts rail and removes old keys in one batch', async () => {
  assert.equal(typeof store.createBoardStore,'function');
  const ff=createFirefox();
  await ff.browser.storage.local.set({layoutsShown:{12:100,18:50}});
  await ff.browser.storage.sync.set({settings:{railCells:5,showClock:false},'layout:12':{t:1},'layout:18':{t:200},
    'tile:12:group:b':{x:2,y:0,w:4,h:3},'tile:12:group:a':{x:0,y:0,w:4,h:3},
    'tile:12:group:c':{x:0,y:3,w:4,h:3},
    'tile:18:group:wrong':{x:0,y:0,w:4,h:3},'tile:clock':{x:0,y:1,w:4,h:3},railCells:7,keep:1});
  ff.calls.length=0; const state=store.createBoardStore(ff.browser); await state.load();
  const data=await ff.browser.storage.sync.get(null);
  assert.deepEqual(data.board.order,['group:a','group:b','group:c']);
  assert.deepEqual(data.settings,{showClock:false,railWidth:304});
  assert.equal(data.keep,1); assert.equal(Object.keys(data).some(k=>k.startsWith('tile:')||k.startsWith('layout:')||k==='railCells'),false);
  assert.equal(ff.calls.filter(c=>c.api==='storage.sync.remove').length,1);
  ff.calls.length=0; await state.load(); assert.equal(ff.calls.some(c=>c.api.endsWith('.set')||c.api.endsWith('.remove')),false);
});
test('reset clears the board and both widths but retains other settings', async () => {
  assert.equal(typeof store.resetBoard,'function');
  const ff=createFirefox(); await ff.browser.storage.sync.set({board:defaults,settings:{widgetsWidth:400,railWidth:300,showClock:false}});
  await store.resetBoard(ff.browser);
  assert.deepEqual(await ff.browser.storage.sync.get(null),{settings:{showClock:false}});
});
test('reset removes board and all legacy keys in the same batch, without touching unrelated data', async () => {
  const ff = createFirefox();
  await ff.browser.storage.sync.set({board: defaults, settings: {railWidth: 400, railCells: 2, showClock: false},
    'tile:12:group:a': {}, 'tile:clock': {}, 'layout:12': {}, layouts: {}, railCells: 2, keep: 7});
  ff.calls.length = 0;
  await store.resetBoard(ff.browser);
  assert.deepEqual(await ff.browser.storage.sync.get(null), {settings: {showClock: false}, keep: 7});
  const removes = ff.calls.filter(c => c.api === 'storage.sync.remove');
  assert.equal(removes.length, 1);
  assert.deepEqual([...removes[0].args[0]].sort(), ['board', 'layout:12', 'layouts', 'railCells', 'tile:12:group:a', 'tile:clock']);
});
test('reset writes default widths before removing board, in exactly two write calls', async () => {
  const ff = createFirefox();
  await ff.browser.storage.sync.set({board: defaults, settings: {widgetsWidth: 400, railWidth: 400, showClock: false}});
  ff.calls.length = 0;
  await store.resetBoard(ff.browser);
  assert.deepEqual(ff.calls.filter(c => /storage\.sync\.(set|remove)$/.test(c.api)).map(c => [c.api, c.args[0]]), [
    ['storage.sync.set', {settings: {showClock: false}}], ['storage.sync.remove', ['board']],
  ]);
});
for (const [railCells, railWidth] of [[2, 240], [3, 240], [16, 960]]) {
  test(`upgrade clamps ${railCells} rail cells to ${railWidth}px`, async () => {
    const ff = createFirefox();
    await ff.browser.storage.sync.set({settings: {railCells}});
    await store.createBoardStore(ff.browser).load();
    assert.deepEqual((await ff.browser.storage.sync.get('settings')).settings, {railWidth});
  });
}
test('failed load rejects so a default cannot overwrite unread data',async t=>{
  assert.equal(typeof store.createBoardStore,'function');
  const ff=createFirefox(); t.mock.method(ff.browser.storage.sync,'get',async()=>{throw Error('offline');});
  const state=store.createBoardStore(ff.browser);
  await assert.rejects(state.load(),/offline/);
  await assert.rejects(state.gesture(b=>b,new Set()),/load/i);
});

test('the board fits the actual per-item byte quota even with long live GUIDs and explicit heights',async()=>{
  const ff=createFirefox();await ff.browser.storage.sync.set({board:defaults});const state=store.createBoardStore(ff.browser);await state.load();
  const order=Array.from({length:400},(_,i)=>`group:${String(i).padStart(12,'0')}`);
  await state.gesture(b=>({...b,order,heights:Object.fromEntries(order.map(id=>[id,40]))}),new Set(order),999);
  const value=(await ff.browser.storage.sync.get('board')).board;
  assert.ok(Buffer.byteLength(JSON.stringify({board:value}),'utf8')<=7600);
  assert.equal(Object.keys(value.heights).length,0,'known heights go before known ids');
  assert.equal(value.order[0],order[0]);assert.equal(value.order.includes(order.at(-1)),false);
  assert.ok(value.order.length>0);assert.ok(value.order.length<=400);
});

test('the exact 7600-byte boundary survives, but one more byte drops the final known id',async()=>{
 const raw={...defaults,order:['group:'],t:10};
 const fill=7600-Buffer.byteLength(JSON.stringify({board:raw}),'utf8');
 const id='group:'+ 'x'.repeat(fill);
 for(const extra of ['', 'x']){
  const ff=createFirefox();await ff.browser.storage.sync.set({board:defaults});const state=store.createBoardStore(ff.browser);await state.load();
  await state.gesture(b=>({...b,order:[id+extra]}),new Set([id+extra]),10);
  const written=(await ff.browser.storage.sync.get('board')).board;
  assert.equal(written.order.length,extra?0:1);
  assert.ok(Buffer.byteLength(JSON.stringify({board:written}),'utf8')<=7600);
 }
});
test('oversize unknowns lose their heights before a known group loses its height',async()=>{
 const ff=createFirefox();await ff.browser.storage.sync.set({board:defaults});const state=store.createBoardStore(ff.browser);await state.load();
 const order=['group:unknown'+ 'x'.repeat(7500),'group:live'];
 await state.gesture(b=>({...b,order,heights:{[order[0]]:4,'group:live':20}}),new Set(['group:live']),99);
 const written=(await ff.browser.storage.sync.get('board')).board;
 assert.deepEqual(written.order,['group:live']);assert.deepEqual(written.heights,{'group:live':20});
});
