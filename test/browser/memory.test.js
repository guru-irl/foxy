import { test, assert, fixture, nextFrame, withPseudoState } from './harness.js';
import { createController } from '../../extension/src/main.js';
import { createBoardFirefox } from './controller.js';
import { renderBoard } from '../../extension/src/board/render.js';
import { renderSettings } from '../../extension/src/settings/pane.js';
import { DEFAULT_SETTINGS, DEFAULT_DEVICE } from '../../extension/src/settings/store.js';
const memory = await import('../../extension/src/tiles/memory.js').catch(() => ({}));

let css;
async function styles() {
  css ??= new Promise(resolve=>{const link=document.createElement('link');link.rel='stylesheet';link.href='/extension/newtab.css';link.onload=resolve;document.head.append(link);});
  await css; await document.fonts.ready;
}
function setup() {
  assert.equal(typeof memory.createMemoryController,'function','memory controller exists');
  const root=document.createElement('div'); fixture().append(root);
  let hidden=false, time=0, timerId=0, reads=0;
  const timers=new Map(), discarded=[];
  const doc=new EventTarget(); Object.defineProperty(doc,'hidden',{get:()=>hidden});
  const tabs=[{id:1,windowId:1,url:'https://www.example.test/a'}, {id:2,windowId:1,url:'https://example.test/b'}, {id:3,windowId:2,url:'https://example.test/active',active:true}];
  const api={runtime:{sendMessage:async message=>{assert.equal(message.type,'foxy:memory');reads++;return {firefox:3400000000,system:{total:36000000000,used:25560000000}};}},
    windows:{getAll:async()=>[{id:1,type:'normal'},{id:2,type:'normal'}]},
    tabs:{query:async()=>tabs,get:async id=>tabs.find(t=>t.id===id),discard:async id=>{discarded.push(id);tabs.find(t=>t.id===id).discarded=true;}}};
  const controller=memory.createMemoryController(root,api,{document:doc,now:()=>time,schedule:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},cancel:id=>timers.delete(id)});
  const board={columns:[],saved:[],pinned:[],tabs:[],missing:[]};
  const view={cell:48,targetCell:48,total:16,cols:13,railCells:3,tiles:[{id:'memory',kind:'memory',x:0,y:0,w:5,h:6}]};
  const render=()=>{renderBoard(root,board,view,{},{});controller.update();};
  const settle=async()=>{for(let i=0;i<8;i++) await Promise.resolve();await nextFrame();};
  return {root,controller,api,view,tabs,timers,discarded,render,settle,get reads(){return reads;},
    hide(value){hidden=value;doc.dispatchEvent(new Event('visibilitychange'));},
    async tick(){const [id,timer]=[...timers][0];timers.delete(id);time+=timer.ms;timer.fn();await settle();}};
}

test('memory header renders measured bytes, system use, neutral sparkline and sites; hover unload is safe', async () => {
  await styles();const f=setup();
  try {
    f.render();await f.settle();
    assert.equal(f.root.querySelector('.memory-total').textContent,'3.4 GB');
    assert.equal(f.root.querySelector('.memory-system').textContent,'of 36 GB · system 71 % used');
    assert.equal(f.root.querySelector('.memory-host').textContent,'example.test');
    assert.equal(f.root.querySelector('.memory-count').textContent,'3 tabs');
    assert.ok(f.root.querySelector('svg polyline').getAttribute('points'));
    const tile=f.root.querySelector('[data-kind="memory"]');
    const computed=getComputedStyle(tile);assert.equal(computed.borderTopWidth,'0px');assert.equal(computed.boxShadow,'none');
    const row=tile.querySelector('.memory-row'), unload=row.querySelector('button');
    assert.equal(unload.textContent,'UNLOAD');assert.equal(getComputedStyle(unload).opacity,'0');
    withPseudoState([row],'hover',()=>assert.equal(getComputedStyle(unload).opacity,'1'));
    unload.click();await f.settle();assert.deepEqual(f.discarded,[1,2]);
    assert.equal(f.root.querySelector('.memory-count').textContent,'1 tab');
  } finally {f.controller.stop();f.root.remove();}
});

test('memory polls every 5 s only while visible and shown; board rerenders retain history', async () => {
  const f=setup();
  try {
    f.render();await f.settle();assert.equal(f.reads,1);
    assert.equal([...f.timers.values()][0].ms,5000);
    await f.tick();assert.equal(f.reads,2);
    const points=f.root.querySelector('polyline').getAttribute('points');
    f.render();await f.settle();assert.equal(f.reads,2);assert.equal(f.root.querySelector('polyline').getAttribute('points'),points);
    f.hide(true);assert.equal(f.timers.size,0);f.controller.update();await f.settle();assert.equal(f.reads,2);
    f.hide(false);await f.settle();assert.equal(f.reads,3);
    f.view.tiles=[];f.render();await f.settle();assert.equal(f.timers.size,0);assert.equal(f.reads,3);
    f.view.tiles=[{id:'memory',kind:'memory',x:0,y:0,w:5,h:6}];f.render();await f.settle();assert.equal(f.reads,4);
  } finally {f.controller.stop();f.root.remove();}
});

test('missing helper and errors show installation guidance; empty loaded sites explain the measurement limit', async () => {
  const f=setup();
  try {
    f.api.runtime.sendMessage=async()=>({unavailable:true});f.tabs.length=0;
    f.render();await f.settle();assert.ok(f.root.textContent.includes('Install the Foxy helper to see memory'));
    assert.ok(f.root.textContent.includes('Firefox cannot report per-site memory'));
    assert.equal(f.root.querySelector('.memory-total').textContent,'');
    f.api.runtime.sendMessage=async()=>({error:'denied'});await f.tick();
    assert.ok(f.root.textContent.includes('Install the Foxy helper to see memory'));
    f.api.runtime.sendMessage=async()=>{throw Error('pipe closed');};await f.tick();
    assert.ok(f.root.textContent.includes('Install the Foxy helper to see memory'));
  } finally {f.controller.stop();f.root.remove();}
});

test('helper loss hides the old sparkline instead of showing stale memory', async () => {
  const f=setup();
  try {
    f.render();await f.settle();assert.ok(getComputedStyle(f.root.querySelector('svg.memory-sparkline')).display !== 'none');
    f.api.runtime.sendMessage=async()=>({unavailable:true});await f.tick();
    assert.equal(getComputedStyle(f.root.querySelector('svg.memory-sparkline')).display,'none');
  } finally {f.controller.stop();f.root.remove();}
});

test('a reply arriving while hidden adds no sample or timer and visibility resumes polling', async () => {
  const f=setup();let resolve;
  try {
    f.api.runtime.sendMessage=()=>new Promise(done=>resolve=done);
    f.render();await Promise.resolve();f.hide(true);
    resolve({firefox:3400000000,system:{total:36000000000,used:1}});await f.settle();
    assert.equal(f.timers.size,0);assert.equal(f.root.querySelector('polyline').getAttribute('points'),'');
    f.api.runtime.sendMessage=async()=>({firefox:1000000000,system:{total:36000000000,used:1}});
    f.hide(false);await f.settle();assert.equal(f.root.querySelector('.memory-total').textContent,'1.0 GB');
    assert.equal(f.timers.size,1);
  } finally {f.controller.stop();f.root.remove();}
});

test('site-list edge fades reflect new sample content without a board rerender', async () => {
  await styles();const f=setup();
  try {
    f.render();await f.settle();const list=f.root.querySelector('.memory-sites');
    assert.equal(list.hasAttribute('data-scroll-end'),false);
    for(let i=10;i<40;i++) f.tabs.push({id:i,windowId:1,url:`https://host${i}.test/`});
    await f.tick();assert.equal(list.hasAttribute('data-scroll-end'),true);
    f.tabs.length=0;await f.tick();assert.equal(list.hasAttribute('data-scroll-end'),false);
  } finally {f.controller.stop();f.root.remove();}
});

test('live board toggles memory through storage and restores its saved placement without repeated writes', async () => {
  await styles();let requests=0;
  const ff=createBoardFirefox({selfTabId:99,tabs:[{id:99,windowId:1,url:'about:blank'}]},message=>{
    if(message.type==='foxy:memory'){requests++;return {firefox:1000000000,system:{total:36000000000,used:1}};}
    if(message.type==='foxy:saved')return {saved:[],missing:[],folders:{}};
    if(message.type==='foxy:reconcile')return {ok:true};
  });
  await ff.browser.storage.sync.set({settings:{showMemory:true,showClock:false,showPinned:false}});await ff.settle();
  const host=document.createElement('div');host.className='page';host.style.width='1600px';
  const root=document.createElement('div');root.className='board';host.append(root);fixture().append(host);
  const flush=async()=>{for(let i=0;i<8;i++){await ff.settle();await nextFrame();}};
  try {
    const control=createController(root,ff.browser);await control.refresh();await flush();
    assert.equal(root.querySelector('.memory-total').textContent,'1.0 GB');
    const before=await ff.browser.storage.sync.get(null);
    const key=Object.keys(before).find(key=>key.endsWith(':memory'));assert.ok(key);
    ff.calls.length=0;control.schedule();await flush();
    assert.equal(ff.calls.filter(call=>call.api==='storage.sync.set').length,0,'placement is not recreated');
    const shownRequests=requests;
    await ff.browser.storage.sync.set({settings:{showMemory:false,showClock:false,showPinned:false}});await flush();
    assert.equal(root.querySelector('[data-kind="memory"]'),null);assert.equal(requests,shownRequests);
    assert.deepEqual((await ff.browser.storage.sync.get(key))[key],before[key]);
    await ff.browser.storage.sync.set({settings:{showMemory:true,showClock:false,showPinned:false}});await flush();
    assert.equal(root.querySelector('.memory-total').textContent,'1.0 GB');assert.equal(requests,shownRequests+1);
    assert.deepEqual((await ff.browser.storage.sync.get(key))[key],before[key]);
  } finally {host.remove();}
});

test('memory toggle in Tiles changes the synced setting', async () => {
  const pane=document.createElement('aside');fixture().append(pane);const changes=[];
  try {
    renderSettings(pane,{synced:DEFAULT_SETTINGS,device:DEFAULT_DEVICE,railMax:8},{onChange:(...args)=>changes.push(args)});
    const toggle=pane.querySelector('[data-key="showMemory"]');assert.ok(toggle);
    assert.equal(toggle.getAttribute('aria-checked'),'true');toggle.click();await Promise.resolve();
    assert.deepEqual(changes,[['synced','showMemory',false]]);
  } finally {pane.remove();}
});
