import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFirefox } from './fakes/firefox.js';
import { loadSettings, saveSetting, DEFAULT_SETTINGS, DEFAULT_DEVICE, cardAlpha } from '../extension/src/settings/store.js';

test('settings use pixel widths and no device cell settings',async()=>{
  const ff=createFirefox(), {synced,device}=await loadSettings(ff.browser);
  assert.equal(synced.widgetsWidth,304); assert.equal(synced.railWidth,304);
  assert.equal('railCells' in synced,false); assert.equal('cellSize' in device,false); assert.equal('customCell' in device,false);
  assert.deepEqual(device,{density:'normal',weatherPlace:'auto'});
  synced.showClock=false; assert.equal(DEFAULT_SETTINGS.showClock,true); assert.equal(DEFAULT_DEVICE.density,'normal');
});
test('legacy settings are ignored without being normalized or rewritten',async()=>{
  const ff=createFirefox(), old={cellSize:'XL',customCell:144,density:'normal',future:7};
  await ff.browser.storage.local.set({deviceSettings:old}); await ff.browser.storage.sync.set({settings:{railCells:5}});
  ff.calls.length=0; const state=await loadSettings(ff.browser);
  assert.deepEqual(state.device,{density:'normal',weatherPlace:'auto'}); assert.equal(state.synced.railWidth,304);
  assert.equal(ff.calls.some(c=>c.api.endsWith('.set')),false);
  await saveSetting(ff.browser,'device','density','compact');
  assert.deepEqual((await ff.browser.storage.local.get(null)).deviceSettings,{...old,density:'compact'});
});
for(const [scope,key,value] of [['synced','railWidth',240],['synced','widgetsWidth',600],['device','density','compact'],
  ['synced','showClock',false],['synced','timeFormat','12'],['synced','tempUnit','F'],['device','weatherPlace',{name:'Dublin',lat:53,lon:-6}]]) {
  test(`persists valid ${key} in its scope and retains unknown keys`,async()=>{
    const ff=createFirefox(),area=scope==='synced'?'sync':'local',storageKey=scope==='synced'?'settings':'deviceSettings';
    await ff.browser.storage[area].set({[storageKey]:{future:7}}); ff.calls.length=0;
    const state=await saveSetting(ff.browser,scope,key,value); assert.deepEqual(state[scope][key],value);
    assert.deepEqual((await ff.browser.storage[area].get(storageKey))[storageKey],{future:7,[key]:value});
    assert.equal(ff.calls.filter(c=>c.api.endsWith('.set')).length,1);
  });
}
for(const [scope,key,value] of [['synced','railWidth',239],['synced','widgetsWidth',240.5],['synced','railWidth',Infinity],
  ['synced','railCells',5],['device','cellSize','S'],['device','customCell',80],['device','density','bad'],['synced','showClock',1],
  ['device','weatherPlace',{name:'X',lat:100,lon:0}],['synced','toString',true],['local','density','compact']]) {
  test(`rejects invalid or removed ${scope}.${key} without writing`,async()=>{
    const ff=createFirefox(); await assert.rejects(saveSetting(ff.browser,scope,key,value));
    assert.equal(ff.calls.some(c=>c.api.endsWith('.set')),false);
  });
}
test('failed reads do not allow settings to be overwritten',async t=>{
  const ff=createFirefox(); t.mock.method(ff.browser.storage.sync,'get',async()=>{throw Error('offline');});
  t.mock.method(console,'warn',()=>{});
  await assert.rejects(saveSetting(ff.browser,'synced','showDate',false),/offline/);
  assert.equal(ff.calls.some(c=>c.api.endsWith('.set')),false);
});
test('concurrent settings saves retain both changes',async()=>{
  const ff=createFirefox(); await Promise.all([saveSetting(ff.browser,'synced','showClock',false),saveSetting(ff.browser,'synced','showDate',false)]);
  const {synced}=await loadSettings(ff.browser); assert.equal(synced.showClock,false);assert.equal(synced.showDate,false);
});
for(const [level,scheme,want] of [['low','dark',.75],['low','light',.85],['medium','dark',.6],['medium','light',.7],['high','dark',.45],['high','light',.55]]){
 test(`card transparency ${level} ${scheme}`,()=>assert.equal(cardAlpha(level,scheme),want));
}
