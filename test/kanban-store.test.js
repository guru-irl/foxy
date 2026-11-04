import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFirefox } from './fakes/firefox.js';
const store = await import('../extension/src/kanban/store.js').catch(() => ({}));
const kinds = ['clock','pinned','weather','memory','saved'];
const defaults = {order:[],heights:{},widgets:kinds.map(kind=>({kind,h:null})),t:0};

test('board validates the storage boundary and excludes local-only identities', () => {
  assert.deepEqual(store.validBoard?.({ order:['group:a','local:9','bad','group:a','group:b'],
    heights:{'group:a':4,'group:b':41,'local:9':5}, widgets:[{kind:'saved',h:200},{kind:'saved',h:300},{kind:'bad',h:4}], t:12 }),
  {order:['group:a','group:b'],heights:{'group:a':4},widgets:[{kind:'saved',h:200},...kinds.slice(0,4).map(kind=>({kind,h:null}))],t:12});
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
    'tile:18:group:wrong':{x:0,y:0,w:4,h:3},'tile:clock':{x:0,y:1,w:4,h:3},railCells:7,keep:1});
  ff.calls.length=0; const state=store.createBoardStore(ff.browser); await state.load();
  const data=await ff.browser.storage.sync.get(null);
  assert.deepEqual(data.board.order,['group:a','group:b']);
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
test('failed load rejects so a default cannot overwrite unread data',async t=>{
  assert.equal(typeof store.createBoardStore,'function');
  const ff=createFirefox(); t.mock.method(ff.browser.storage.sync,'get',async()=>{throw Error('offline');});
  const state=store.createBoardStore(ff.browser);
  await assert.rejects(state.load(),/offline/);
  await assert.rejects(state.gesture(b=>b,new Set()),/load/i);
});
