import { test, assert, fixture, nextFrame } from './harness.js';
import { renderBoard } from './view.js';
let css;
for(const density of ['normal','compact'])for(const width of [240,304]){
 test(`${density} ${width}px rail keeps its gear fixed and the last tab reachable`,async()=>{
  css??=new Promise(resolve=>{const l=document.createElement('link');l.rel='stylesheet';l.href='/extension/newtab.css';l.onload=resolve;document.head.append(l);});await css;
  const root=document.createElement('div');root.className='board';root.style.cssText=`width:1520px;height:400px;--row:${density==='compact'?24:32}px`;fixture().append(root);
  const rows=Array.from({length:30},(_,i)=>({id:i+1,windowId:1,title:`Tab ${i+1}`}));
  renderBoard(root,{columns:[],pinned:[],saved:[],tabs:[{current:true,windowId:1,rows}],missing:[],windowOrder:[1]}, {}, {},{device:{density},synced:{railWidth:width}});
  await nextFrame();await nextFrame();const rail=root.querySelector('.rail'),list=rail.querySelector('.rows'),gear=rail.querySelector('.settings-gear');
  const g=gear.getBoundingClientRect(),r=rail.getBoundingClientRect();
  assert.equal(r.width,width);assert.equal(r.bottom,root.getBoundingClientRect().bottom);
  assert.equal(g.width,32);assert.equal(g.height,32);assert.equal(g.right+8,r.right);assert.equal(g.bottom+8,r.bottom);
  assert.equal(list.getBoundingClientRect().bottom+16,g.top);assert.equal(rail.querySelector('h2').textContent,'UNGROUPED TABS');
  assert.equal(list.hasAttribute('data-scroll-end'),true);list.scrollTop=list.scrollHeight;await nextFrame();await nextFrame();
  assert.equal(list.hasAttribute('data-scroll-end'),false);assert.equal(list.hasAttribute('data-scroll-start'),true);
  assert.equal(list.lastElementChild.getBoundingClientRect().bottom,list.getBoundingClientRect().bottom);
  assert.equal(gear.getBoundingClientRect().top,g.top);assert.equal(getComputedStyle(gear).boxShadow,'none');
 });
}
