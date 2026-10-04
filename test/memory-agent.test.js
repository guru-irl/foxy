import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectAgent } from '../extension/src/agent.js';

function fixture(os = 'mac') {
  const listeners = [], sent = [], timers = new Map(), handled = [];
  let receive, disconnect, timerId = 0;
  const api = { runtime: {
    onMessage: { addListener: fn => listeners.push(fn) },
    getPlatformInfo: async () => ({ os }),
  } };
  const port = { onMessage: { addListener: fn => receive = fn },
    onDisconnect: { addListener: fn => disconnect = fn }, postMessage: message => sent.push(message) };
  const options = { api, handle: async request => { handled.push(request); return { ok: true }; },
    portFactory: () => port, schedule: (fn, ms) => { timers.set(++timerId, {fn, ms}); return timerId; },
    cancel: id => timers.delete(id) };
  return { options, sent, timers, handled, request: message => listeners.map(fn => fn(message)).find(r => r !== undefined),
    receive: message => receive(message), disconnect: () => disconnect() };
}

test('memory page requests are correlated independently and never enter the CLI handler', async () => {
  const f = fixture(); await connectAgent(f.options);
  const first = f.request({type: 'foxy:memory'}), second = f.request({type: 'foxy:memory'});
  assert.equal(typeof first?.then, 'function', 'memory request has a response promise');
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].type, 'memory');
  assert.notEqual(f.sent[0].rid, f.sent[1].rid);
  const reply = {type: 'memory', rid: f.sent[1].rid, firefox: 42, processes: 2, system: {total: 100, used: 50}};
  await f.receive(reply); assert.deepEqual(await second, reply);
  await f.receive({type: 'memory', rid: f.sent[0].rid, error: 'denied'});
  assert.equal((await first).error, 'denied');
  await f.receive({type: 'memory', rid: 'unknown', firefox: 1});
  assert.deepEqual(f.handled, []);
  assert.equal(f.timers.size, 0);
  await f.receive({id: 'cli', command: 'groups'});
  assert.deepEqual(f.sent.at(-1), {ok: true, id: 'cli'});
  assert.equal(f.request({type: 'foxy:saved'}), undefined);
});

test('missing host and Windows answer unavailable without waiting', async () => {
  for (const os of ['mac', 'win']) {
    const f = fixture(os); f.options.portFactory = () => { throw Error('not installed'); };
    await connectAgent(f.options);
    assert.deepEqual(await f.request({type: 'foxy:memory'}), os === 'win' ? {unavailable:true,platform:'win'} : {unavailable:true});
  }
});

test('a silent host times out after 3 s; late replies do not leak to the CLI', async () => {
  const f = fixture(); await connectAgent(f.options);
  const pending = f.request({type: 'foxy:memory'});
  assert.equal(typeof pending?.then, 'function');
  const [id, timer] = [...f.timers][0]; assert.equal(timer.ms, 3000);
  timer.fn(); f.timers.delete(id);
  assert.deepEqual(await pending, {error:'Memory request timed out'});
  await f.receive({type: 'memory', rid: f.sent[0].rid, firefox: 42});
  assert.deepEqual(f.handled, []);
});

test('disconnect and closed pipes report errors; subsequent no-port requests answer unavailable', async () => {
  const f = fixture(); await connectAgent(f.options);
  const pending = f.request({type: 'foxy:memory'});
  assert.equal(typeof pending?.then, 'function');
  f.disconnect(); assert.deepEqual(await pending, {error:'Memory helper disconnected'});
  assert.deepEqual(await f.request({type: 'foxy:memory'}), {unavailable: true});
  assert.equal([...f.timers.values()].filter(t => t.ms === 3000).length, 0);
  const other = fixture(); other.options.portFactory = () => ({onMessage:{addListener(){}},onDisconnect:{addListener(){}},postMessage(){throw Error('closed');}});
  await connectAgent(other.options);
  assert.deepEqual(await other.request({type:'foxy:memory'}), {error:'Memory helper disconnected'});
  assert.equal(other.timers.size,0);
});
