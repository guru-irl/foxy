import { test } from 'node:test';
import assert from 'node:assert/strict';
const model = await import('../extension/src/kanban/layout.js').catch(() => ({}));

test('column widths fill the kanban, up to four columns', () => {
  for (const [width, count, tile] of [[199,1,199],[615,1,615],[616,2,300],[932,3,300],[1248,4,300],[1904,4,464]]) {
    assert.deepEqual(model.columns?.(width), { count, width: tile });
  }
});
test('shortest-column placement uses leftmost ties and does not leave holes', () => {
  assert.deepEqual(model.placeTiles?.([{id:'a',height:200},{id:'b',height:100},{id:'c',height:80},{id:'d',height:70}],616), {
    height:282, tiles:[{id:'a',height:200,x:0,y:0,w:300},{id:'b',height:100,x:316,y:0,w:300},
      {id:'c',height:80,x:316,y:116,w:300},{id:'d',height:70,x:316,y:212,w:300}],
  });
});
test('group heights fit three to twelve rows unless explicitly resized', () => {
  for (const [tabs,rows,density,want] of [[0,null,'normal',144],[20,null,'normal',432],[1,2,'normal',112],[99,40,'compact',1008],[6,null,'compact',192]]) {
    assert.equal(model.groupHeight?.(tabs, rows, density), want);
  }
});
test('bars clamp before testing the narrow fallback without mutating preferences', () => {
  assert.deepEqual(model.pageColumns?.(2560,304,304),{widgets:304,rail:304,kanban:1920,fallback:false});
  const clamped = model.pageColumns?.(1024,999,999);
  assert.equal(clamped.widgets,1024/3); assert.equal(clamped.rail,1024/3);
  assert.ok(Math.abs(clamped.kanban - 309.3333333333) < 1e-8); assert.equal(clamped.fallback,false);
  assert.deepEqual(model.pageColumns?.(640,304,304),{widgets:240,rail:240,kanban:384,fallback:true});
});
test('widget default sizes follow content and respect their minimums', () => {
  assert.equal(model.widgetHeight?.('clock',null,304,0,'normal'),160);
  assert.equal(model.widgetHeight?.('clock',20,304,0,'normal'),112);
  assert.equal(model.widgetHeight?.('pinned',null,304,30,'normal'),224);
  assert.equal(model.widgetHeight?.('saved',null,304,30,'compact'),240);
  assert.equal(model.widgetHeight?.('weather',null,304,0,'normal'),304);
});
