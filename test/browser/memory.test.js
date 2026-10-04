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
  const api={runtime:{sendMessage:async message=>{assert.equal(message.type,'foxy:memory');reads++;return {firefox:3650722202,system:{total:51539607552,used:36593121362}};}},
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

test('before the first reply the tile shows no status text, then the measured header', async () => {
  await styles();const f=setup();
  try {
    let answer;f.api.runtime.sendMessage=()=>new Promise(resolve=>{answer=resolve;});
    f.render();await f.settle();
    const status=f.root.querySelector('.memory-unavailable');
    assert.equal(status.hidden,true,'no unavailable flash while the first reply is pending');
    assert.equal(f.root.querySelector('.memory-total').textContent,'');
    answer({firefox:3650722202,system:{total:51539607552,used:36593121362}});await f.settle();
    assert.equal(status.hidden,true);
    assert.equal(f.root.querySelector('.memory-total').textContent,'3.4 GB');
  } finally {f.controller.stop();f.root.remove();}
});

test('memory header renders measured bytes, system use, neutral sparkline and sites; hover unload is safe', async () => {
  await styles();const f=setup();
  try {
    f.render();await f.settle();
    assert.equal(f.root.querySelector('.memory-total').textContent,'3.4 GB');
    assert.equal(f.root.querySelector('.memory-system').textContent,'of 48 GB · system 71 % used');
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

test('memory formats whole MB below 1 GB and GB to one decimal, in binary units', async () => {
  const f=setup();
  try {
    f.api.runtime.sendMessage=async()=>({firefox:536870912+400000,system:{total:38654705664,used:19327352832}});
    f.render();await f.settle();
    assert.equal(f.root.querySelector('.memory-total').textContent,'512 MB');
    assert.equal(f.root.querySelector('.memory-system').textContent,'of 36 GB · system 50 % used');
    f.api.runtime.sendMessage=async()=>({firefox:1073741824,system:{total:38654705664,used:19327352832}});
    await f.tick();assert.equal(f.root.querySelector('.memory-total').textContent,'1.0 GB');
    f.api.runtime.sendMessage=async()=>({firefox:1073741824-100000,system:{total:38654705664,used:19327352832}});
    await f.tick();assert.equal(f.root.querySelector('.memory-total').textContent,'1.0 GB','never 1024 MB');
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

test('missing helper has install guidance but helper errors and message failures show unavailable', async () => {
  const f=setup();
  try {
    f.api.runtime.sendMessage=async()=>({unavailable:true});f.tabs.length=0;
    f.render();await f.settle();assert.ok(f.root.textContent.includes('Install the Foxy helper to see memory'));
    assert.ok(f.root.textContent.includes('Firefox cannot report per-site memory'));
    assert.equal(f.root.querySelector('.memory-total').textContent,'');
    f.api.runtime.sendMessage=async()=>({error:'denied'});await f.tick();
    assert.equal(f.root.querySelector('.memory-unavailable').textContent,'Memory unavailable');
    f.api.runtime.sendMessage=async()=>{throw Error('pipe closed');};await f.tick();
    assert.equal(f.root.querySelector('.memory-unavailable').textContent,'Memory unavailable');
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
    f.api.runtime.sendMessage=async()=>({firefox:1073741824,system:{total:36000000000,used:1}});
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
    if(message.type==='foxy:memory'){requests++;return {firefox:1073741824,system:{total:36000000000,used:1}};}
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

async function liveMemoryFixture() {
  const ff=createBoardFirefox({selfTabId:99,tabs:[
    {id:99,windowId:1,url:'about:blank',active:true},
    {id:5,windowId:1,url:'https://alpha.test/a',lastAccessed:20},
    {id:6,windowId:1,url:'https://beta.test/b',lastAccessed:10},
  ]}, message=>{
    if(message.type==='foxy:memory')return {firefox:1073741824,system:{total:51539607552,used:1}};
    if(message.type==='foxy:saved')return {saved:[],missing:[],folders:{}};
    if(message.type==='foxy:reconcile')return {ok:true};
  });
  await ff.browser.storage.sync.set({settings:{showMemory:true,showClock:false,showPinned:false}});await ff.settle();
  const host=document.createElement('div');host.className='page';host.style.width='1600px';
  const root=document.createElement('div');root.className='board';host.append(root);fixture().append(host);
  const flush=async()=>{for(let i=0;i<8;i++){await ff.settle();await nextFrame();}};
  const control=createController(root,ff.browser);await control.refresh();await flush();
  return {ff,host,root,control,flush};
}

test('keyboard UNLOAD focus survives tab-event board replacement', async () => {
  const f=await liveMemoryFixture();
  try {
    const button=f.root.querySelector('.memory-unload');button.focus();
    const oldTile=f.root.querySelector('[data-kind="memory"]');
    await f.ff.browser.tabs.create({windowId:1,url:'about:blank',active:false});await f.flush();
    assert.ok(f.root.querySelector('[data-kind="memory"]')!==oldTile,'board replaced the tile');
    assert.equal(document.activeElement?.closest('.memory-row')?.dataset.host,'alpha.test');
    assert.ok(document.activeElement.classList.contains('memory-unload'));
  } finally {f.host.remove();}
});

test('keyboard UNLOAD keeps focus on the next site then the list when emptied', async () => {
  const f=await liveMemoryFixture();
  try {
    f.root.querySelector('.memory-unload').focus();document.activeElement.click();await f.flush();
    assert.equal((await f.ff.browser.tabs.get(5)).discarded,true);
    assert.equal(document.activeElement?.closest('.memory-row')?.dataset.host,'beta.test');
    document.activeElement.click();await f.flush();
    assert.equal((await f.ff.browser.tabs.get(6)).discarded,true);
    assert.equal(document.activeElement,f.root.querySelector('.memory-sites'));
  } finally {f.host.remove();}
});

test('UNLOAD handles an initial tab lookup failure without an unhandled rejection and can retry', async () => {
  const f=setup();
  try {
    f.render();await f.settle();
    const query=f.api.tabs.query;
    f.api.tabs.query=async()=>{throw Error('lookup failed');};
    const action=f.root.querySelector('.memory-unload');action.click();await f.settle();
    assert.equal(action.hasAttribute('aria-disabled'),false);
    f.api.tabs.query=query;action.click();await f.settle();
    assert.deepEqual(f.discarded,[1,2]);
  } finally {f.controller.stop();f.root.remove();}
});

function textLeft(node) {
  const range=document.createRange();range.selectNodeContents(node);
  return range.getBoundingClientRect().left;
}

test('memory title, numeric header and sparkline share an 18 px inset in both schemes', async () => {
  await styles();const f=setup();
  try {
    f.render();await f.settle();
    const tile=f.root.querySelector('[data-kind="memory"]');
    for(const scheme of ['dark','light']) {
      tile.style.colorScheme=scheme;
      for(const selector of ['.column-title','.memory-total','.memory-system'])
        assert.equal(textLeft(tile.querySelector(selector))-tile.getBoundingClientRect().left,18,selector);
      assert.equal(tile.querySelector('.memory-sparkline').getBoundingClientRect().left-tile.getBoundingClientRect().left,18);
    }
  } finally {f.controller.stop();f.root.remove();}
});

test('memory site icons and empty/install text align at the title inset', async () => {
  await styles();const f=setup();
  try {
    f.render();await f.settle();
    const tile=f.root.querySelector('[data-kind="memory"]'), left=tile.getBoundingClientRect().left;
    assert.equal(tile.querySelector('.memory-row .icon').getBoundingClientRect().left-left,18);
    f.tabs.length=0;f.api.runtime.sendMessage=async()=>({unavailable:true});await f.tick();
    assert.equal(textLeft(tile.querySelector('.memory-empty'))-left,18);
    assert.equal(textLeft(tile.querySelector('.memory-unavailable'))-left,18);
    assert.equal(getComputedStyle(tile.querySelector('.memory-system')).display,'none','empty system line reserves no margin');
    assert.equal(getComputedStyle(tile.querySelector('.memory-total')).display,'none');
  } finally {f.controller.stop();f.root.remove();}
});

test('minimum memory tile at S exposes three site rows and hides sparkline before system line', async () => {
  await styles();const f=setup();
  try {
    for(let id=10;id<20;id++)f.tabs.push({id,windowId:1,url:`https://host${id}.test/`});
    f.render();await f.settle();
    assert.ok(getComputedStyle(f.root.querySelector('.memory-sparkline')).display!=='none','roomy sparkline');
    f.view.tiles[0]={id:'memory',kind:'memory',x:0,y:0,w:4,h:5};f.render();await f.settle();
    assert.equal(getComputedStyle(f.root.querySelector('.memory-sparkline')).display,'none','hide sparkline first');
    assert.ok(getComputedStyle(f.root.querySelector('.memory-system')).display!=='none','system fits at S minimum');
    const list=f.root.querySelector('.memory-sites'), rows=[...list.querySelectorAll('.memory-row')];
    assert.ok(rows.length>=3);
    assert.ok(rows[2].getBoundingClientRect().bottom<=list.getBoundingClientRect().bottom,'three full rows fit at S');
    f.view.cell=f.view.targetCell=40;f.render();await f.settle();
    assert.equal(getComputedStyle(f.root.querySelector('.memory-system')).display,'none','hide system next on shorter cells');
    const shortList=f.root.querySelector('.memory-sites');
    assert.ok(shortList.querySelectorAll('.memory-row')[2].getBoundingClientRect().bottom<=shortList.getBoundingClientRect().bottom);
  } finally {f.controller.stop();f.root.remove();}
});

test('one helper error or timeout keeps the last values and reports unavailable, then recovers', async () => {
  const f=setup();
  try {
    f.render();await f.settle();const original=f.api.runtime.sendMessage;
    for(const error of ['denied','Memory request timed out']) {
      f.api.runtime.sendMessage=async()=>({error});await f.tick();
      assert.equal(f.root.querySelector('.memory-total').textContent,'3.4 GB');
      assert.equal(f.root.querySelector('.memory-system').textContent,'of 48 GB · system 71 % used');
      assert.equal(f.root.querySelector('.memory-unavailable').hidden,false);
      assert.equal(f.root.querySelector('.memory-unavailable').textContent,'Memory unavailable');
    }
    f.render();await f.settle();assert.equal(f.root.querySelector('.memory-total').textContent,'3.4 GB');
    f.api.runtime.sendMessage=original;await f.tick();assert.equal(f.root.querySelector('.memory-unavailable').hidden,true);
  } finally {f.controller.stop();f.root.remove();}
});

test('Windows explains that memory needs the macOS or Linux helper, not a Windows install', async () => {
  const f=setup();
  try {
    f.api.runtime.sendMessage=async()=>({unavailable:true,platform:'win'});f.render();await f.settle();
    assert.equal(f.root.querySelector('.memory-unavailable').textContent,'Memory needs the Foxy helper on macOS or Linux');
  } finally {f.controller.stop();f.root.remove();}
});
