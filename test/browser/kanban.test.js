import { test, assert, fixture, nextFrame } from './harness.js';
import { renderBoard } from './view.js';
import { createBoardFirefox } from './controller.js';
const kinds=['clock','pinned','weather','memory','saved'];
const data={columns:Array.from({length:12},(_,i)=>({id:i+1,title:`Group ${i+1}`,color:'grey',current:i<10,windowId:i<10?1:2,
  rows:Array.from({length:3+i%5},(_,j)=>({id:100+i*10+j,title:'Tab',windowId:1}))})),pinned:[],tabs:[],
  saved:[{folderId:'closed',title:'Saved',color:'grey',count:3,cantReopen:[]}],missing:[],windowOrder:[1,2]};
let css;
export async function makeRoot(width=2560,height=600){
 css??=new Promise(resolve=>{const link=document.createElement('link');link.rel='stylesheet';link.href='/extension/newtab.css';link.onload=resolve;document.head.append(link);});
 await css;const root=document.createElement('div');root.className='board';root.style.cssText=`width:${width}px;height:${height}px;flex:none`;
 fixture().append(root);return root;
}
for(const [width,count,fallback] of [[2560,4,false],[1440,2,false],[1024,1,false],[640,1,true]]){
 test(`three independent columns at ${width}px, ${count} kanban tracks`,async()=>{
  const root=await makeRoot(width);
  renderBoard(root,data,{}, {},{synced:{showMemory:true,showWeather:true}});await nextFrame();
  const widgets=root.querySelector('.widgets'),kanban=root.querySelector('.kanban'),rail=root.querySelector('.rail');
  assert.ok(widgets&&kanban&&rail,'widgets, kanban and rail must exist');
  assert.equal(kanban.contains(widgets),fallback);
  assert.deepEqual([...widgets.querySelectorAll('.widget')].map(w=>w.dataset.kind),kinds);
  assert.equal(kanban.querySelectorAll('.group').length,12);
  const boxes=[...kanban.querySelectorAll('.group')].map(t=>t.getBoundingClientRect());
  assert.equal(new Set(boxes.map(b=>Math.round(b.left))).size,count);
  assert.ok(boxes.every(b=>Math.abs(b.width-boxes[0].width)<.1));
  assert.equal(root.querySelector('.grid-corners, [data-corner]'),null);
  assert.equal(getComputedStyle(kanban).overflowY,'auto');
  assert.equal(getComputedStyle(rail.querySelector('.rows')).overflowY,'auto');
  assert.equal(rail.querySelector('.settings-gear').parentElement,rail);
  assert.ok(root.scrollWidth<=root.clientWidth,'page must not overflow');
 });
}
test('controller window reflow and repeated refreshes never write storage',async()=>{
 const ff=createBoardFirefox({windows:[{id:1}],groups:[{id:1,windowId:1,title:'One'}],tabs:[{id:10,groupId:1,windowId:1},{id:99,windowId:1}],selfTabId:99},
  m=>m.type==='foxy:saved'?{saved:[],missing:[],folders:{1:'one'}}:m.type==='foxy:reconcile'?{ok:true}:undefined);
 await ff.browser.storage.sync.set({board:{order:['group:one'],heights:{},widgets:[],t:1}});
 const root=await makeRoot(2560);const {createController}=await import('../../extension/src/main.js');
 const control=createController(root,ff.browser);await control.refresh();await ff.settle();await nextFrame();await nextFrame();
 ff.calls.length=0;
 for(const width of [1440,1024,640,2560]){root.style.width=`${width}px`;window.dispatchEvent(new Event('resize'));await nextFrame();await nextFrame();}
 await control.refresh();await ff.settle();await nextFrame();
 assert.equal(ff.calls.filter(c=>/storage\..*\.(set|remove)$/.test(c.api)).length,0);
 assert.equal(root.querySelectorAll('.kanban .group').length,1);
});
