import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFirefox } from './fakes/firefox.js';
import { createSync } from '../extension/src/sync/sync.js';
import { createInbound } from '../extension/src/sync/inbound.js';
import { emptyState } from '../extension/src/sync/state.js';

const agent = await import('../extension/src/agent.js').catch(() => ({}));
async function fixture() {
  assert.equal(typeof agent.createAgentHandler, 'function', 'agent command handler exists');
  const ff = createFirefox({
    windows: [{id: 1}, {id: 2, focused: true}, {id: 3, incognito: true}],
    groups: [{id: 11, windowId: 1, title: 'Work'}, {id: 22, windowId: 2, title: ' work ', color: 'red', collapsed: true}],
    tabs: [{id: 1, windowId: 1, groupId: 11, url: 'https://example.com/one'},
      {id: 2, windowId: 2, groupId: 22, url: 'https://example.com/two#old'},
      {id: 3, windowId: 2, active: true, url: 'https://example.com/active'},
      {id: 4, windowId: 3, active: true, url: 'https://example.com/private'}],
    bookmarks: [{id: 'root', title: 'Foxy', children: [{title: '📌 Pinned'},
      {id: 'saved', title: '🟢 Later', children: [{url: 'https://example.com/later#one', title: 'Later page'}]}]}],
  });
  const marked = [];
  const saved = async () => ({saved: [{folderId: 'saved', title: 'Later', color: 'green', count: 1}], folders: {}});
  const handle = agent.createAgentHandler({api: ff.browser, saved, mark: id => marked.push(id)});
  return {ff, handle, marked};
}

test('groups lists open metadata and saved closed groups without private data', async () => {
  const {handle} = await fixture();
  const reply = await handle({command: 'groups'});
  assert.equal(reply.ok, true);
  assert.equal(reply.windowId, 2);
  assert.deepEqual(reply.open.map(g => [g.id,g.title,g.color,g.windowId,g.collapsed,g.count,g.lastFocused]),
    [[11,'Work','blue',1,false,1,false], [22,' work ','red',2,true,1,true]]);
  assert.deepEqual(reply.saved, [{folderId:'saved', title:'Later', color:'green', count:1}]);
});

test('tabs matches trimmed case-insensitive names and prefers last focused normal window', async () => {
  const {handle,ff} = await fixture();
  assert.deepEqual((await handle({command:'tabs',group:' WORK '})).tabs.map(t => [t.title,t.url]),
    [['https://example.com/two#old','https://example.com/two#old']]);
  await ff.browser.windows.update(3, {focused:true});
  await ff.settle();
  assert.equal((await handle({command:'tabs',group:'work'})).group.id, 22);
  const saved = await handle({command:'tabs',group:'later'});
  assert.deepEqual(saved.tabs, [{title:'Later page',url:'https://example.com/later#one'}]);
});

test('ambiguous groups outside focused window use the lowest window ID', async () => {
  const {ff,handle} = await fixture();
  await ff.browser.windows.create({focused:true});
  await ff.settle();
  assert.equal((await handle({command:'tabs',group:'work'})).group.id, 11);
});

test('add skips fragment duplicates including repeats in the request and preserves selection', async () => {
  const {ff,handle,marked} = await fixture();
  const reply = await handle({command:'add', group:'work', urls:['https://example.com/two#new','https://example.com/next','https://example.com/next#x']});
  assert.equal(reply.ok,true);
  assert.equal(reply.added,1);
  assert.equal(reply.skipped,2);
  assert.equal(reply.closed,false);
  const tabs = await ff.browser.tabs.query({groupId:22});
  assert.deepEqual(tabs.map(t => t.url), ['https://example.com/two#old','https://example.com/next']);
  assert.equal(tabs.at(-1).active,false);
  assert.deepEqual(marked,[tabs.at(-1).id]);
  assert.equal((await ff.browser.tabs.query({windowId:2,active:true}))[0].id,3);
  assert.equal((await ff.browser.windows.getLastFocused()).id,2);
  assert.equal((await ff.browser.tabGroups.get(22)).collapsed,true);
});

test('adding to a closed saved group writes bookmarks and inbound keeps it closed', async () => {
  const {ff,handle,marked} = await fixture();
  const reply = await handle({command:'add',group:' LATER ',urls:['https://example.com/later#two','https://example.com/saved-new']});
  assert.equal(reply.added,1);
  assert.equal(reply.skipped,1);
  assert.equal(reply.closed,true);
  const state = {...emptyState(),rootId:'root'};
  const inbound = createInbound({api:ff.browser,getState:()=>state,save:async()=>{}});
  await inbound.reconcileFolder('saved');
  assert.deepEqual((await ff.browser.bookmarks.getChildren('saved')).map(b=>b.url),
    ['https://example.com/later#one','https://example.com/saved-new']);
  assert.deepEqual((await ff.browser.tabGroups.query({})).map(g=>g.id),[11,22]);
  assert.equal((await ff.browser.tabs.query({})).length,4);
  assert.deepEqual(marked,[]);
});

test('missing groups refuse with names; create and new make inactive groups without focus', async () => {
  const {ff,handle,marked} = await fixture();
  const missing = await handle({command:'add',group:'Missing',urls:['https://example.com/new']});
  assert.equal(missing.ok,false);
  assert.match(missing.error,/Work/);
  assert.match(missing.error,/Later/);
  for (const request of [
    {command:'add',group:'Created',create:true,color:'cyan',urls:['https://example.com/new']},
    {command:'new',title:'Default',urls:['https://example.com/default']},
  ]) {
    const reply = await handle(request);
    assert.equal(reply.ok,true);
    const group = await ff.browser.tabGroups.get(reply.group.id);
    assert.equal(group.title, request.group ?? request.title);
    if (request.color) assert.equal(group.color,'cyan');
    else {
      const update = ff.calls.filter(c => c.api === 'tabGroups.update').at(-1);
      assert.equal(Object.hasOwn(update.args[1], 'color'), false, 'leave Firefox default colour untouched');
    }
    assert.equal(group.windowId,2);
    const [tab] = await ff.browser.tabs.query({groupId:group.id});
    assert.equal(tab.active,false);
    assert.ok(marked.includes(tab.id));
  }
  assert.equal((await ff.browser.tabs.query({windowId:2,active:true}))[0].id,3);
  assert.equal((await ff.browser.windows.getLastFocused()).id,2);
});

test('bridge-created groups are saved by the ordinary sync event path', async () => {
  const ff = createFirefox({tabs:[{id:1,windowId:1,url:'about:blank',active:true}]});
  assert.equal(typeof agent.createAgentHandler,'function');
  const sync = createSync({api:ff.browser,settleMs:0,maxWaitMs:0});
  for (const [name,fn] of Object.entries(sync.handlers)) {
    const [ns,event] = name.split('.'); ff.browser[ns][event].addListener(fn);
  }
  await sync.start();
  const handle = agent.createAgentHandler({api:ff.browser,saved:()=>sync.onMessage({type:'foxy:saved'})});
  assert.equal((await handle({command:'new',title:'Agent',color:'green',urls:['https://example.com/agent']})).ok,true);
  await ff.settle(); await sync.idle();
  const roots = await ff.browser.bookmarks.search({title:'🟢 Agent'});
  assert.equal(roots.length,1);
  assert.deepEqual((await ff.browser.bookmarks.getChildren(roots[0].id)).map(b=>b.url),['https://example.com/agent']);
});

test('validation refuses invalid input before creating any tabs or bookmarks', async () => {
  const {ff,handle} = await fixture();
  const bad = [null, {}, {command:'remove'}, {command:'tabs',group:''},
    {command:'new',title:'x'.repeat(201),urls:['https://example.com/']},
    {command:'new',title:' ',urls:['https://example.com/']},
    {command:'new',title:'Bad',color:'black',urls:['https://example.com/']},
    {command:'new',title:'Bad',color:['blue'],urls:['https://example.com/']},
    ...[[], ['file:///a'], ['about:blank'], ['https://example.com/', 'javascript:alert(1)'], ['not a url'], Array(51).fill('https://example.com/')]
      .map(urls=>({command:'add',group:'work',urls}))];
  const before = ff.calls.length;
  for (const request of bad) assert.equal((await handle(request)).ok,false,JSON.stringify(request));
  assert.equal(ff.calls.slice(before).filter(c=>/^(tabs.create|bookmarks.create|tabGroups.update)$/.test(c.api)).length,0);
  assert.equal((await handle({command:'new',title:'x'.repeat(200),color:'grey',urls:Array.from({length:50},(_,i)=>`https://example.com/${i}`)})).added,50);
});

test('no normal non-private window refuses creation', async () => {
  assert.equal(typeof agent.createAgentHandler,'function');
  const ff = createFirefox({windows:[{id:1,type:'popup',focused:true}],tabs:[{id:1,windowId:1,url:'about:blank'}]});
  const handle=agent.createAgentHandler({api:ff.browser,saved:async()=>({saved:[],folders:{}})});
  assert.equal((await handle({command:'new',title:'No',urls:['https://example.com/']})).ok,false);
  assert.equal((await ff.browser.tabs.query({})).length,1);
});

test('native port connects on startup and retries after 5 seconds then every 60 seconds', async () => {
  assert.equal(typeof agent.connectAgent,'function','native connection exists');
  const {ff,handle}=await fixture();
  const messages=[], scheduled=[], ports=[];
  const portFactory=name=>{
    assert.equal(name,'foxy_agent');
    const port={onMessage:{addListener:fn=>port.receive=fn},onDisconnect:{addListener:fn=>port.disconnect=fn},postMessage:msg=>messages.push(msg)};
    ports.push(port); return port;
  };
  await agent.connectAgent({api:ff.browser,handle,portFactory,schedule:(fn,ms)=>scheduled.push({fn,ms})});
  await ports[0].receive({id:'request-1',command:'groups'});
  assert.equal(messages[0].id,'request-1'); assert.equal(messages[0].ok,true);
  ports[0].disconnect();
  assert.equal(scheduled[0].ms,5000);
  scheduled[0].fn(); assert.equal(ports.length,2);
  const failed=[];
  let attempts = 0;
  await agent.connectAgent({api:ff.browser,handle,portFactory:()=>{attempts++; throw Error('not installed');},schedule:(fn,ms)=>failed.push({fn,ms})});
  assert.equal(attempts,1);
  assert.equal(failed[0].ms,5000);
  failed[0].fn();
  assert.equal(attempts,2);
  assert.equal(failed[1].ms,60000);
  failed[1].fn();
  assert.equal(attempts,3);
  assert.equal(failed[2].ms,60000);
});


test('new refuses an existing open name after trimming and case folding, suggesting add', async () => {
  const {ff,handle} = await fixture();
  const before = ff.calls.length;
  const reply = await handle({command:'new',title:' WORK ',urls:['https://example.com/new']});
  assert.equal(reply.ok,false);
  assert.match(reply.error,/exists.*add/i);
  assert.equal(ff.calls.slice(before).filter(c => /^(tabs.create|bookmarks.create|tabGroups.update)$/.test(c.api)).length,0);
});

test('Windows never connects to a native host or schedules retries', async () => {
  const {ff,handle} = await fixture();
  ff.browser.runtime.getPlatformInfo = async () => ({os:'win',arch:'x86-64'});
  let attempts=0, retries=0;
  await agent.connectAgent({api:ff.browser,handle,portFactory:()=>{attempts++; throw Error('unsupported');},schedule:()=>{retries++;}});
  assert.equal(attempts,0);
  assert.equal(retries,0);
});

test('oversized UTF-8 replies are refused with the request id and the port remains usable', async () => {
  const {ff} = await fixture();
  const messages=[];
  let receive;
  const handle = async request => request.command === 'big'
    ? {ok:true,tabs:[{title:'Big',url:'https://example.com/?q='+'é'.repeat(530000)}]}
    : {ok:true,open:[]};
  await agent.connectAgent({api:ff.browser,handle,portFactory:()=>({
    onMessage:{addListener:fn=>receive=fn},onDisconnect:{addListener:()=>{}},postMessage:msg=>messages.push(msg),
  })});
  await receive({id:'big',command:'big'});
  assert.equal(messages[0].id,'big');
  assert.equal(messages[0].ok,false);
  assert.match(messages[0].error,/reply too large/i);
  assert.equal(messages[0].unreachable,undefined);
  assert.ok(new TextEncoder().encode(JSON.stringify(messages[0])).length < 1024*1024);
  await receive({id:'next',command:'groups'});
  assert.deepEqual(messages[1],{ok:true,open:[],id:'next'});
});

test('replies below 1 MB including multibyte text are delivered unchanged', async () => {
  const {ff} = await fixture();
  let receive, sent;
  const reply = {ok:true,tabs:[{title:'Big',url:'https://example.com/?q='+'é'.repeat(500000)}]};
  await agent.connectAgent({api:ff.browser,handle:async()=>reply,portFactory:()=>({
    onMessage:{addListener:fn=>receive=fn},onDisconnect:{addListener:()=>{}},postMessage:msg=>sent=msg,
  })});
  await receive({id:'small',command:'tabs'});
  assert.deepEqual(sent,{...reply,id:'small'});
});
