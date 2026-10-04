import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFirefox } from './fakes/firefox.js';

const own = await import('../extension/src/tabs/own.js');
const agent = await import('../extension/src/agent.js').catch(() => ({}));

test('Foxy-created markers expire at 30 seconds and can be refreshed', t => {
  assert.equal(typeof own.markOwn,'function');
  assert.equal(typeof own.isOwn,'function');
  let now = 100;
  t.mock.method(Date,'now',()=>now);
  own.markOwn(91);
  assert.equal(own.isOwn(91),true);
  now = 30099;
  assert.equal(own.isOwn(91),true);
  now = 30100;
  assert.equal(own.isOwn(91),false);
  assert.equal(own.isOwn(92),false);
  own.markOwn(91);
  now = 60099;
  assert.equal(own.isOwn(91),true);
  now = 60100;
  assert.equal(own.isOwn(91),false);
});

test('bridge defaults to the shared marker for tabs it creates', async () => {
  assert.equal(typeof agent.createAgentHandler,'function');
  const ff=createFirefox({tabs:[{id:1,windowId:1,active:true,url:'about:blank'}]});
  const handle=agent.createAgentHandler({api:ff.browser,saved:async()=>({saved:[],folders:{}})});
  const reply=await handle({command:'new',title:'Own',urls:['https://example.com/']});
  assert.equal(reply.ok,true);
  const [tab]=await ff.browser.tabs.query({groupId:reply.group.id});
  assert.equal(own.isOwn(tab.id),true);
});
