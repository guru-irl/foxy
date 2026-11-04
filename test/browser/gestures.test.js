import { test, assert, fixture, nextFrame, dispatchDrag } from './harness.js';
import { createBoardFirefox } from './controller.js';
import { createController } from '../../extension/src/main.js';
let css;
async function flush(ff){for(let i=0;i<5;i++){await ff.settle();await nextFrame();}}
async function setup({width=1600,remote=false,folders={1:'one',2:'two',3:'three'}}={}){
 css??=new Promise(resolve=>{const l=document.createElement('link');l.rel='stylesheet';l.href='/extension/newtab.css';l.onload=resolve;document.head.append(l);});await css;
 const ff=createBoardFirefox({windows:[{id:1},{id:2}],selfTabId:99,groups:[1,2,3].map(id=>({id,windowId:remote&&id===3?2:1,title:`Group ${id}`})),tabs:[{id:99,windowId:1},...Array.from({length:3},(_,i)=>({id:10+i,windowId:remote&&i===2?2:1,groupId:i+1,title:'Tab'}))]},m=>m.type==='foxy:saved'?{saved:[{folderId:'closed',title:'Saved',color:'grey',count:1,cantReopen:[]}],missing:[],folders}:m.type==='foxy:reconcile'?{ok:true}:undefined);
 await ff.browser.storage.sync.set({settings:{widgetsWidth:304,railWidth:304},board:{order:['group:one','group:two','group:three'],heights:{},widgets:[],t:1}});
 const root=document.createElement('div');root.className='board';root.style.cssText=`width:${width}px;height:650px;position:relative`;fixture().append(root);
 const control=createController(root,ff.browser);await control.refresh();await flush(ff);ff.calls.length=0;return{root,ff,control};
}
function pointer(node,type,x,y){node.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,isPrimary:true,pointerType:'mouse',pointerId:7,button:0,buttons:type==='pointerup'?0:1,clientX:x,clientY:y}));}
function at(node,x=.5,y=.5){const r=node.getBoundingClientRect();return[r.left+r.width*x,r.top+r.height*y];}
function begin(node){const [x,y]=at(node);pointer(node,'pointerdown',x,y);return[x,y];}
const writes=ff=>ff.calls.filter(c=>c.api==='storage.sync.set');
async function board(ff){return(await ff.browser.storage.sync.get('board')).board;}
for(const key of ['widgetsWidth','railWidth'])test(`${key} previews in pixels, clamps, and writes once on release`,async()=>{
 const {root,ff}=await setup();const handle=root.querySelector(`[data-bar="${key}"]`),[x,y]=begin(handle);
 pointer(document,'pointermove',x+(key==='widgetsWidth'?96:-96),y);await nextFrame();assert.equal(writes(ff).length,0);
 const bar=root.querySelector(key==='widgetsWidth'?'.widgets-column':'.rail');assert.equal(bar.getBoundingClientRect().width,400);
 pointer(document,'pointerup',x+(key==='widgetsWidth'?96:-96),y);await flush(ff);
 assert.equal(writes(ff).length,1);assert.equal((await ff.browser.storage.sync.get('settings')).settings[key],400);
});
test('group bottom resize previews whole rows, keeps its width, and double click restores fit',async()=>{
 const {root,ff}=await setup();let tile=root.querySelector('[data-tile-id="group:one"]');const width=tile.getBoundingClientRect().width,[x,y]=begin(tile.querySelector('.tile-resize'));
 pointer(document,'pointermove',x+200,y+64);await nextFrame();assert.equal(writes(ff).length,0);assert.equal(tile.getBoundingClientRect().width,width);assert.equal(tile.getBoundingClientRect().height,208);
 pointer(document,'pointerup',x+200,y+64);await flush(ff);assert.equal(writes(ff).length,1);assert.equal((await board(ff)).heights['group:one'],5);
 root.querySelector('[data-tile-id="group:one"] .tile-resize').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));await flush(ff);
 assert.equal(writes(ff).length,2);assert.equal((await board(ff)).heights['group:one'],undefined);assert.equal(root.querySelector('[data-tile-id="group:one"]').getBoundingClientRect().height,144);
});
test('widget bottom resize stores a pixel height without changing another widget',async()=>{
 const {root,ff}=await setup();const clock=root.querySelector('.clock'),pinned=root.querySelector('.pinned').getBoundingClientRect().height,[x,y]=begin(clock.querySelector('.tile-resize'));
 pointer(document,'pointermove',x,y+71);await nextFrame();assert.equal(writes(ff).length,0);assert.equal(clock.getBoundingClientRect().height,231);
 pointer(document,'pointerup',x,y+71);await flush(ff);assert.equal(writes(ff).length,1);assert.equal((await board(ff)).widgets.find(w=>w.kind==='clock').h,231);assert.equal(root.querySelector('.pinned').getBoundingClientRect().height,pinned);
});
for(const cancel of ['Escape','pointercancel'])test(`${cancel} restores a resize and writes nothing`,async()=>{
 const {root,ff}=await setup();const [x,y]=begin(root.querySelector('.clock .tile-resize'));pointer(document,'pointermove',x,y+80);
 if(cancel==='Escape')document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));else pointer(document,'pointercancel',x,y+80);
 await flush(ff);assert.equal(writes(ff).length,0);assert.equal(root.querySelector('.clock').getBoundingClientRect().height,160);
});
test('Alt+Arrow moves one group in order, preserves header focus and writes once per move',async()=>{
 const {root,ff}=await setup();const header=root.querySelector('[data-tile-id="group:two"] .column-header');header.focus();header.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',altKey:true,bubbles:true,cancelable:true}));await flush(ff);
 assert.deepEqual((await board(ff)).order,['group:two','group:one','group:three']);assert.equal(writes(ff).length,1);assert.equal(document.activeElement.closest('.group').dataset.tileId,'group:two');
});
test('dragging a group header shows a neutral pill insertion line then writes the new order once',async()=>{
 const {root,ff}=await setup();const header=root.querySelector('[data-tile-id="group:one"] .column-header'),[x,y]=begin(header);
 const target=root.querySelector('[data-tile-id="group:three"]'),[tx,ty]=at(target,.5,.9);pointer(document,'pointermove',tx,ty);await nextFrame();
 const line=root.querySelector('.layout-insertion');assert.ok(line);assert.equal(line.getBoundingClientRect().height,2);assert.equal(getComputedStyle(line).borderRadius,'999px');assert.equal(writes(ff).length,0);
 pointer(document,'pointerup',tx,ty);await flush(ff);assert.equal(writes(ff).length,1);assert.deepEqual((await board(ff)).order,['group:two','group:three','group:one']);assert.equal(root.querySelector('.layout-insertion'),null);
});
test('widgets reorder by empty space while pin icons remain tab drags',async()=>{
 const {root,ff}=await setup();const [x,y]=begin(root.querySelector('.clock'));const [tx,ty]=at(root.querySelector('.saved'),.5,.9);
 pointer(document,'pointermove',tx,ty);await nextFrame();assert.ok(root.querySelector('.layout-insertion'));pointer(document,'pointerup',tx,ty);await flush(ff);
 assert.deepEqual([...root.querySelectorAll('.widget')].map(w=>w.dataset.kind),['pinned','saved','clock']);assert.equal(writes(ff).length,1);
});
test('empty kanban tab drop creates a group and editor, never a free-placement write',async()=>{
 const {root,ff}=await setup();const dt=new DataTransfer();dt.setData('application/x-foxy-tab','10');const kanban=root.querySelector('.kanban'),[x,y]=at(kanban,.8,.9);
 dispatchDrag('drop',kanban,{dataTransfer:dt,clientX:x,clientY:y});await flush(ff);assert.ok(root.querySelector('.name-editor'));assert.equal(writes(ff).length,0);
});
test('an unmapped local group can resize in memory but never stores its local id',async()=>{
 const {root,ff}=await setup({folders:{1:'one',3:'three'}});const handle=root.querySelector('[data-tile-id="local:2"] .tile-resize'),[x,y]=begin(handle);
 pointer(document,'pointermove',x,y+64);pointer(document,'pointerup',x,y+64);await flush(ff);
 assert.equal(root.querySelector('[data-tile-id="local:2"]').getBoundingClientRect().height,208);
 assert.equal(JSON.stringify(await board(ff)).includes('local:'),false);
});

for(const delta of [-10000,10000])test(`row resize clamps at ${delta<0?2:40} rows`,async()=>{
 const {root,ff}=await setup();const [x,y]=begin(root.querySelector('[data-tile-id="group:one"] .tile-resize'));
 pointer(document,'pointermove',x,y+delta);pointer(document,'pointerup',x,y+delta);await flush(ff);
 assert.equal((await board(ff)).heights['group:one'],delta<0?2:40);assert.equal(writes(ff).length,1);
});
for(const key of ['widgetsWidth','railWidth'])test(`${key} clamps to a third of page and Escape restores it`,async()=>{
 const {root,ff}=await setup({width:1200});const [x,y]=begin(root.querySelector(`[data-bar="${key}"]`));
 pointer(document,'pointermove',x+(key==='widgetsWidth'?1000:-1000),y);await nextFrame();
 assert.equal(root.querySelector(key==='widgetsWidth'?'.widgets-column':'.rail').getBoundingClientRect().width,400);
 document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await flush(ff);
 assert.equal(root.querySelector(key==='widgetsWidth'?'.widgets-column':'.rail').getBoundingClientRect().width,304);assert.equal(writes(ff).length,0);
});
test('pin button pointer motion stays a native tab drag, not a widget move',async()=>{
 const {root,ff}=await setup();await ff.browser.tabs.update(10,{pinned:true});await flush(ff);ff.calls.length=0;
 const open=root.querySelector('.pinned .row-open'),[x,y]=begin(open);pointer(document,'pointermove',x+60,y+60);pointer(document,'pointerup',x+60,y+60);await flush(ff);
 assert.equal(root.querySelector('.layout-insertion'),null);assert.equal(writes(ff).length,0);
 const dt=dispatchDrag('dragstart',open).dataTransfer;assert.equal(dt.getData('application/x-foxy-tab'),'10');dispatchDrag('dragend',open,{dataTransfer:dt});
});
test('rendered remote storage changes wait for a resize release and do not add a second write',async()=>{
 const {root,ff}=await setup();const clock=root.querySelector('.clock'),[x,y]=begin(clock.querySelector('.tile-resize'));
 pointer(document,'pointermove',x,y+80);await ff.browser.storage.sync.set({settings:{showPinned:false,widgetsWidth:304,railWidth:304}});await flush(ff);
 assert.ok(root.querySelector('.pinned'));ff.calls.length=0;pointer(document,'pointerup',x,y+80);await flush(ff);
 assert.equal(root.querySelector('.pinned'),null);assert.equal(root.querySelector('.clock').getBoundingClientRect().height,240);assert.equal(writes(ff).length,1);
});

test('moving a widget preserves hidden widget positions relative to the resting widgets',async()=>{
 const {root,ff}=await setup();const [x,y]=begin(root.querySelector('.clock'));const [tx,ty]=at(root.querySelector('.saved'),.5,.9);
 pointer(document,'pointermove',tx,ty);pointer(document,'pointerup',tx,ty);await flush(ff);
 assert.deepEqual((await board(ff)).widgets.map(w=>w.kind),['pinned','weather','memory','saved','clock']);
});
test('a row resize that snaps back to the original height keeps the default and writes nothing',async()=>{
 const {root,ff}=await setup();const [x,y]=begin(root.querySelector('[data-tile-id="group:one"] .tile-resize'));
 pointer(document,'pointermove',x,y+8);pointer(document,'pointerup',x,y+8);await flush(ff);
 assert.equal(writes(ff).length,0);assert.equal((await board(ff)).heights['group:one'],undefined);
});

for(const compact of [false,true])test(`${compact?'compact':'normal'} remote tiles fit their row count below the window label`,async()=>{
 const {root,ff}=await setup({remote:true});
 if(compact){await ff.browser.storage.local.set({deviceSettings:{density:'compact'}});await flush(ff);}
 const tile=root.querySelector('[data-tile-id="group:three"]'),list=tile.querySelector('.rows'),row=compact?24:32;
 assert.equal(list.clientHeight,3*row,'three full rows below the label');
 const [x,y]=begin(tile.querySelector('.tile-resize'));pointer(document,'pointermove',x,y+2*row);pointer(document,'pointerup',x,y+2*row);await flush(ff);
 assert.equal((await board(ff)).heights['group:three'],5);assert.equal(root.querySelector('[data-tile-id="group:three"] .rows').clientHeight,5*row);
});
