import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validBoard } from '../extension/src/kanban/store.js';
import { DEFAULT_SETTINGS, DEFAULT_DEVICE } from '../extension/src/settings/store.js';
const { buildView } = await import('../extension/src/kanban/view.js').catch(()=>({}));
const group=(id,current=true)=>({id,current,rows:[{id:1}],title:'Group'});
const board={columns:[group(1),group(2),group(3,false),group(4)],pinned:[],saved:[],tabs:[]};
const opts={board:validBoard({order:['group:c','group:b','group:a'],heights:{'group:b':6}}),synced:DEFAULT_SETTINGS,device:DEFAULT_DEVICE,contentWidth:2560,folders:{1:'a',2:'b',3:'c'}};
test('current groups precede remote groups, each in saved order; new and local groups append',()=>{
 const view=buildView?.(board,opts);assert.deepEqual(view?.tiles.map(t=>t.id),['group:b','group:a','local:4','group:c']);
 assert.equal(view.tiles[0].height,240);assert.equal(view.tiles[1].height,144);
});
test('hidden widgets retain their order and dimensions without occupying space',()=>{
 const view=buildView?.(board,{...opts,synced:{...DEFAULT_SETTINGS,showClock:false,showSaved:false},board:validBoard({widgets:[{kind:'memory',h:500}]})});
 assert.deepEqual(view?.widgets.map(w=>[w.kind,w.height]),[['memory',500],['pinned',96],['weather',304]]);
 assert.equal(view.tiles.length,4);
});
