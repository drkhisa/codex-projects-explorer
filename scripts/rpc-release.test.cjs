'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { CodexRpc } = require('../extension/src/rpc');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

test('the owned server gets an immediate idle-unload override without editing global settings', async () => {
  let args;
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: 0 });
  proc.stdin = new Writable({ write(chunk, _, done) {
    const request = JSON.parse(chunk);
    if (request.id !== undefined) queueMicrotask(() => proc.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n'));
    done();
  } });
  const rpc = new CodexRpc('synthetic', '.local', { processFactory: (_, argv) => { args = argv; return proc; } });
  try { await rpc.start(); assert.deepEqual(args, ['app-server', '-c', 'thread_unload_delay_secs=0']); }
  finally { rpc.dispose(); }
});

test('unsubscribe waits for this thread to close before allowing a writer handoff', async () => {
  const rpc = new CodexRpc('synthetic', '.local');
  rpc.request = async (method, params) => {
    assert.equal(method, 'thread/unsubscribe'); assert.equal(params.threadId, 'synthetic-chat');
    return { status: 'unsubscribed' };
  };
  let finished = false;
  const releasing = rpc.releaseThread('synthetic-chat').then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  rpc.emit('notification', { method: 'thread/closed', params: { threadId: 'another-chat' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  rpc.emit('notification', { method: 'thread/closed', params: { threadId: 'synthetic-chat' } });
  await releasing;
  assert.equal(finished, true);
  assert.equal(rpc.listenerCount('notification'), 0);
  assert.equal(rpc.listenerCount('closed'), 0);
});

test('an already unloaded thread needs no close notification', async () => {
  const rpc = new CodexRpc('synthetic', '.local');
  rpc.request = async () => ({ status: 'notLoaded' });
  await rpc.releaseThread('synthetic-chat');
  assert.equal(rpc.listenerCount('notification'), 0);
});

test('a rejected unsubscribe cleans up listeners and remains visible', async () => {
  const rpc = new CodexRpc('synthetic', '.local'), error = new Error('Synthetic unsubscribe failure');
  rpc.request = async () => { throw error; };
  await assert.rejects(rpc.releaseThread('synthetic-chat'), received => received === error);
  assert.equal(rpc.listenerCount('notification'), 0);
  assert.equal(rpc.listenerCount('closed'), 0);
});

test('unknown unsubscribe results do not falsely confirm a writer release', async () => {
  const rpc = new CodexRpc('synthetic', '.local');
  rpc.request = async () => ({});
  await assert.rejects(rpc.releaseThread('synthetic-chat'), /неизвестное состояние/);
  assert.equal(rpc.listenerCount('notification'), 0);
});
