'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { ChatSession } = require('../extension/src/chat-session');
const tick = () => new Promise(resolve => setImmediate(resolve));
const options = text => ({ text, model: 'synthetic', access: 'project' });
function fixture() {
  const rpc = new EventEmitter(), calls = [], updates = [];
  let release, failure;
  rpc.releaseThread = async () => { calls.push(['release']); if (release) await release; };
  rpc.request = async (method, params) => {
    calls.push([method, params]);
    if (method === 'model/list') return { data: [{ id: 'synthetic' }] };
    if (method === 'thread/loaded/list') return { data: ['synthetic-chat'] };
    if (method === 'thread/read') return { thread: { status: { type: 'idle' } } };
    if (method === 'turn/start') { if (failure) throw failure; return { turn: { id: 'turn-' + calls.length } }; }
    if (method === 'turn/steer') { if (failure) throw failure; return { turnId: params.expectedTurnId }; }
    if (method === 'turn/interrupt') return {};
    throw new Error(method);
  };
  const session = new ChatSession({ connect: async () => rpc }, { id: 'synthetic-chat' });
  session.on('update', value => updates.push(value));
  const complete = (status = 'completed') => rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'synthetic-chat', turn: { status } } });
  return { session, calls, updates, complete, blockRelease: promise => { release = promise; }, fail: error => { failure = error; } };
}
test('steer appends input only to the expected active turn with no turn overrides or fallback', async () => {
  const f = fixture();
  try {
    await f.session.send(options('Start')); const id = f.session.turnId;
    await f.session.steer({ ...options('Clarify'), extraInputs: [{ type: 'localImage', path: 'synthetic.png' }] });
    assert.deepEqual(f.calls.at(-1), ['turn/steer', { threadId: 'synthetic-chat', expectedTurnId: id, input: [{ type: 'text', text: 'Clarify' }, { type: 'localImage', path: 'synthetic.png' }] }]);
    f.fail(Object.assign(new Error('No active turn'), { code: -32600 }));
    await assert.rejects(f.session.steer(options('Race')), /No active/);
    assert.equal(f.calls.filter(([method]) => method === 'turn/start').length, 1);
  } finally { f.session.dispose(); }
});
test('queue drains in order only after release and uses the current project access', async () => {
  const f = fixture();
  try {
    await f.session.send(options('Start')); f.session.enqueue(options('Second')); f.session.enqueue(options('Third'));
    let unlock; f.blockRelease(new Promise(resolve => { unlock = resolve; }));
    f.session.getAccess = async () => 'read'; f.complete(); await tick();
    assert.equal(f.calls.filter(([method]) => method === 'turn/start').length, 1);
    unlock(); await tick(); await tick();
    const starts = f.calls.filter(([method]) => method === 'turn/start');
    assert.equal(starts.length, 2); assert.equal(starts[1][1].input[0].text, 'Second'); assert.deepEqual(starts[1][1].sandboxPolicy, { type: 'readOnly' });
    assert.equal(f.session.queue.length, 1); f.complete(); await tick(); await tick();
    assert.equal(f.calls.filter(([method]) => method === 'turn/start').at(-1)[1].input[0].text, 'Third');
  } finally { f.session.dispose(); }
});
test('stop pauses pending work and removal prevents an unwanted next turn', async () => {
  const f = fixture();
  try {
    await f.session.send(options('Start')); f.session.enqueue(options('Remove me'));
    await f.session.stop(); f.complete('interrupted'); await tick();
    assert.equal(f.session.queuePaused, true); assert.equal(f.session.queue.length, 1);
    f.session.removeQueued(f.session.queue[0].id); f.session.resumeQueue(); await tick();
    assert.equal(f.calls.filter(([method]) => method === 'turn/start').length, 1);
  } finally { f.session.dispose(); }
});
test('unknown queue acceptance pauses and blocks automatic or explicit replay', async () => {
  const f = fixture();
  try {
    await f.session.send(options('Start')); f.session.enqueue(options('Unknown'));
    f.fail(new Error('RPC timeout')); f.complete(); await tick(); await tick();
    assert.equal(f.session.queuePaused, true); assert.equal(f.session.queue[0].uncertain, true);
    assert.throws(() => f.session.resumeQueue(), /неизвестен/);
    assert.equal(f.calls.filter(([method]) => method === 'turn/start').length, 2);
  } finally { f.session.dispose(); }
});

test('an uncertain steer pauses queued work until history can be checked', async () => {
  const f = fixture();
  try {
    await f.session.send(options('Start')); f.session.enqueue(options('Later'));
    f.fail(new Error('Steer timeout'));
    await assert.rejects(f.session.steer(options('Unknown steer')), /timeout/);
    assert.equal(f.session.requiresSync, true); assert.equal(f.session.queuePaused, true);
    f.complete(); await tick(); await tick();
    assert.equal(f.calls.filter(([method]) => method === 'turn/start').length, 1);
  } finally { f.session.dispose(); }
});

test('closing a session never starts its queued work', async () => {
  const f = fixture();
  await f.session.send(options('Start')); f.session.enqueue(options('Do not start'));
  f.session.dispose(); f.complete(); await tick();
  assert.equal(f.calls.filter(([method]) => method === 'turn/start').length, 1);
});
