import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLayouts, saveTiles } from '../extension/src/grid/store.js';
import { kindOf, defaultSize, clampRect } from '../extension/src/grid/layout.js';
import { buildView } from '../extension/src/grid/view.js';
import { loadSettings, saveSetting, DEFAULT_SETTINGS, DEFAULT_DEVICE } from '../extension/src/settings/store.js';
import { createFirefox } from './fakes/firefox.js';
const memory = await import('../extension/src/tiles/memory.js').catch(() => ({}));

const windows = [{id: 1, type: 'normal'}, {id: 2, type: 'normal'}, {id: 3, type: 'normal', incognito: true}, {id: 4, type: 'popup'}];
const tabs = [
  {id: 1, windowId: 1, url: 'https://www.alpha.test/a', lastAccessed: 10, favIconUrl: 'data:alpha'},
  {id: 2, windowId: 2, url: 'http://alpha.test/b', lastAccessed: 20, active: true},
  {id: 3, windowId: 1, url: 'https://beta.test/', lastAccessed: 40},
  {id: 4, windowId: 1, url: 'https://gamma.test/', lastAccessed: 30},
  {id: 5, windowId: 1, url: 'https://alpha.test/sleep', discarded: true},
  {id: 6, windowId: 3, url: 'https://private.test/'},
  {id: 7, windowId: 4, url: 'https://popup.test/'},
  {id: 8, windowId: 1, url: 'about:blank'},
  {id: 9, windowId: 1, url: 'not a url'},
  {id: 10, windowId: 1, incognito: true, url: 'https://private.test/extra'},
];

test('loaded sites exclude discarded/private/non-web tabs and sort counts then recency', () => {
  assert.equal(typeof memory.loadedSites, 'function');
  assert.deepEqual(memory.loadedSites(tabs, windows), [
    {host:'alpha.test', ids:[1,2], count:2, lastAccessed:20, icon:'data:alpha'},
    {host:'beta.test', ids:[3], count:1, lastAccessed:40, icon:null},
    {host:'gamma.test', ids:[4], count:1, lastAccessed:30, icon:null},
  ]);
});

test('unload rereads live tabs, preserves every active tab and private windows, tolerates closed tabs', async () => {
  assert.equal(typeof memory.unloadHost, 'function');
  const state = tabs.map(t => ({...t})); const discarded = [];
  const api = {windows:{getAll:async()=>windows}, tabs:{query:async()=>state,
    get:async id => { if(id===1) return {...state[0],active:true}; return state.find(t=>t.id===id); },
    discard:async id => discarded.push(id)}};
  state.push({id: 11,windowId:1,url:'https://alpha.test/new'}, {id:12,windowId:2,url:'https://alpha.test/gone'});
  const get = api.tabs.get; api.tabs.get = async id => { if(id===12) throw Error('gone'); return get(id); };
  await memory.unloadHost(api, 'alpha.test');
  assert.deepEqual(discarded, [11]);
});

test('five-minute sparkline retains only fresh samples and stays finite for equal values', () => {
  assert.equal(typeof memory.addSample, 'function');
  let samples = [];
  for (let i=0;i<=65;i++) samples = memory.addSample(samples, {time:i*5000, bytes:100});
  assert.equal(samples.length, 60);
  assert.equal(samples[0].time, 30000);
  assert.equal(samples.at(-1).time, 325000);
  const points = memory.sparklinePoints(samples);
  assert.equal(points.split(' ').length, 60);
  assert.ok(!/NaN|Infinity/.test(points));
  assert.equal(memory.sparklinePoints([]), '');
  const changed = memory.sparklinePoints([{time:0,bytes:734003200},{time:5000,bytes:796917760}]).split(' ').map(p=>p.split(',').map(Number));
  assert.ok(changed[1][0] > changed[0][0]);
  assert.ok(changed[1][1] < changed[0][1]);
});

test('sparkline draws a flat full-width line from the first sample', () => {
  assert.equal(memory.sparklinePoints([{time:0,bytes:734003200}]), '2.00,16.00 298.00,16.00');
});

test('sparkline centres small drift within a minimum 256 MB vertical span', () => {
  const points = memory.sparklinePoints([{time:0,bytes:734003200},{time:5000,bytes:796917760}])
    .split(' ').map(p=>p.split(',').map(Number));
  assert.deepEqual(points.map(p=>p[1]), [19.28,12.72]);
});

test('memory placements reload and a hidden tile retains its saved rectangle without new writes', async () => {
  const ff = createFirefox();
  await saveTiles(ff.browser, 13, [{id:'memory',x:2,y:1,w:5,h:6}], {now:10});
  const {layouts} = await loadLayouts(ff.browser);
  assert.deepEqual(layouts[13].tiles, [{id:'memory',x:2,y:1,w:5,h:6}]);
  const options = {layouts,synced:{...DEFAULT_SETTINGS,showClock:false,showPinned:false,showWeather:false},device:DEFAULT_DEVICE,contentWidth:1600};
  const board = {columns:[],saved:[],tabs:[],pinned:[]};
  assert.deepEqual(buildView(board,options).newTiles, []);
  const hidden = buildView(board,{...options,synced:{...options.synced,showMemory:false}});
  assert.deepEqual(hidden.tiles, []);
  assert.deepEqual(hidden.saved, [{id:'memory',x:2,y:1,w:5,h:6}]);
});

test('memory is visible by default with a 5 x 6 rectangle and its own minimum', async () => {
  const ff = createFirefox(); const settings = await loadSettings(ff.browser);
  assert.equal(settings.synced.showMemory, true);
  assert.equal(kindOf('memory'), 'memory');
  assert.deepEqual(defaultSize('memory', 48, 20), {w:5,h:6});
  assert.deepEqual(defaultSize('memory', 80, 20), {w:5,h:6});
  assert.deepEqual(clampRect('memory', {x:0,y:0,w:1,h:1}, 20), {id:'memory',x:0,y:0,w:4,h:5});
  const options = {layouts:{},synced:{...DEFAULT_SETTINGS,showClock:false,showPinned:false,showWeather:false},device:DEFAULT_DEVICE,contentWidth:1600};
  const board = {columns:[],saved:[],tabs:[],pinned:[]};
  assert.deepEqual(buildView(board,options).tiles.map(t=>t.kind), ['memory']);
  await saveSetting(ff.browser,'synced','showMemory',false);
  assert.equal((await loadSettings(ff.browser)).synced.showMemory,false);
  assert.deepEqual(buildView(board,{...options,synced:{...options.synced,showMemory:false}}).tiles,[]);
  await assert.rejects(()=>saveSetting(ff.browser,'synced','showMemory','yes'), /Invalid/);
});

test('UNLOAD skips currently audible tabs even when they started playing after the query', async () => {
  const discarded=[];
  const live=[{id:1,windowId:1,url:'https://music.test/a'},
    {id:2,windowId:1,url:'https://music.test/b',audible:true},
    {id:3,windowId:1,url:'https://music.test/c'}];
  const api={windows:{getAll:async()=>windows},tabs:{query:async()=>live,
    get:async id=>({...live.find(t=>t.id===id),audible:id!==3}),discard:async id=>discarded.push(id)}};
  await memory.unloadHost(api,'music.test');
  assert.deepEqual(discarded,[3]);
});
