'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const Module = require('node:module');
const path = require('node:path');
const { Backend } = require('../extension/src/backend');
const { ChatSession } = require('../extension/src/chat-session');
const { RpcError } = require('../extension/src/rpc');

function fixture({ loaded = true, materialized = true, status = 'idle', historyError, resumeError } = {}) {
  const thread = { id: 'synthetic-chat', cwd: path.resolve(__dirname, '../.local') };
  const calls = [], turns = [];
  const rpc = new EventEmitter();
  rpc.start = async () => ({});
  rpc.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'model/list') return { data: [{ id: 'test-model', supportedReasoningEfforts: [] }] };
    if (method === 'thread/loaded/list') return { data: loaded ? [thread.id] : [] };
    if (method === 'thread/read') return { thread: { ...thread, status: { type: status } } };
    if (method === 'thread/turns/list') {
      if (historyError) throw historyError;
      if (!materialized) throw new RpcError(`thread ${thread.id} is not materialized yet; thread/turns/list is unavailable before first user message`, -32600);
      return { data: turns };
    }
    if (method === 'thread/resume') {
      if (resumeError) throw resumeError;
      if (loaded) throw new RpcError(`thread ${thread.id} already has an active writer`, -32600);
      if (!materialized) throw new RpcError(`no rollout found for thread id ${thread.id}`, -32600);
      loaded = true;
      return { thread: { ...thread, status: { type: status } } };
    }
    if (method === 'turn/start') {
      assert.ok(loaded, 'The thread must be loaded before starting a turn');
      materialized = true;
      const turn = { id: `turn-${turns.length}`, items: [{ id: `user-${turns.length}`, type: 'userMessage', content: params.input }] };
      turns.push(turn);
      return { turn };
    }
    throw new Error(`Unexpected RPC method: ${method}`);
  };
  const backend = new Backend({ executable: 'synthetic', home: thread.cwd, dataSource: 'appServer', rpcFactory: () => rpc });
  const session = () => new ChatSession(backend, thread);
  return { thread, rpc, backend, session, calls };
}
const message = { text: 'Synthetic message', model: 'test-model', access: 'project' };

test('a new unmaterialized thread has empty history', async () => {
  const f = fixture({ materialized: false });
  const history = await f.backend.history(f.thread);
  assert.deepEqual(history.messages, []);
  assert.deepEqual(history.tools, []);
  assert.deepEqual(f.calls.map(c => c.method), ['thread/turns/list']);
});

test('the first message uses the loaded thread without resuming it', async () => {
  const f = fixture({ materialized: false }), session = f.session();
  try {
    await session.send(message);
    assert.equal(f.calls.filter(c => c.method === 'thread/resume').length, 0);
    assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
    assert.equal((await f.backend.history(f.thread)).messages[0].text, message.text);
    const params = f.calls.find(c => c.method === 'turn/start').params;
    assert.equal(params.approvalPolicy, 'on-request');
    assert.equal(params.approvalsReviewer, 'user');
    assert.equal(params.sandboxPolicy.networkAccess, false);
    assert.deepEqual(params.sandboxPolicy.writableRoots, [f.thread.cwd]);
  } finally { session.dispose(); }
});

test('reopening a completed chat in the same server does not acquire another writer', async () => {
  const f = fixture(), first = f.session();
  await first.send(message);
  f.rpc.emit('notification', { method: 'turn/completed', params: { threadId: f.thread.id, turn: { status: 'completed' } } });
  first.dispose();
  const reopened = f.session();
  try {
    await reopened.send(message);
    assert.equal(f.calls.filter(c => c.method === 'thread/resume').length, 0);
    assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 2);
  } finally { reopened.dispose(); }
});

test('a stored thread not loaded in this server is resumed once', async () => {
  const f = fixture({ loaded: false }), session = f.session();
  try {
    await session.send(message);
    assert.equal(f.calls.filter(c => c.method === 'thread/resume').length, 1);
    assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
  } finally { session.dispose(); }
});

test('a loaded active thread is not sent another turn', async () => {
  const f = fixture({ status: 'active' }), session = f.session();
  try {
    await assert.rejects(session.send(message), /уже выполняется/);
    assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 0);
    assert.equal(session.running, false);
  } finally { session.dispose(); }
});

test('a writer in another client is not overridden or retried', async () => {
  const conflict = new RpcError('thread synthetic-chat already has an active writer', -32600);
  const f = fixture({ loaded: false, resumeError: conflict }), session = f.session();
  try {
    await assert.rejects(session.send(message), error => error === conflict);
    assert.equal(f.calls.filter(c => c.method === 'thread/resume').length, 1);
    assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 0);
    assert.equal(session.running, false);
  } finally { session.dispose(); }
});

test('missing rollout and unrelated history failures remain visible', async () => {
  for (const text of ['no rollout found for thread id synthetic-chat', 'Permission denied']) {
    const error = new RpcError(text, -32600), f = fixture({ historyError: error });
    await assert.rejects(f.backend.history(f.thread), received => received === error);
  }
});

test('an unmaterialized API thread does not hide an available local history', async () => {
  const f = fixture({ materialized: false });
  const directory = await fs.mkdtemp(path.join(f.thread.cwd, 'chat-lifecycle-'));
  f.thread.file = path.join(directory, 'synthetic.jsonl');
  try {
    await fs.writeFile(f.thread.file, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: message.text } }) + '\n');
    assert.equal((await f.backend.history(f.thread)).messages[0].text, message.text);
  } finally {
    await fs.unlink(f.thread.file);
    await fs.rmdir(directory);
  }
});

test('concurrent opens create one panel and reveal the existing one', async t => {
  const panels = new Map(), thread = { id: 'synthetic-chat' };
  let created = 0, revealed = 0, ready;
  const connected = new Promise(resolve => { ready = resolve; });
  const originalLoad = Module._load;
  const extensionFile = require.resolve('../extension/src/extension');
  t.mock.method(Module, '_load', function (id, ...args) {
    if (id === 'vscode') return {};
    if (id === './chat-panel') return { createChatPanel: () => { created++; panels.set(thread.id, { reveal: () => { revealed++; } }); } };
    return originalLoad.call(this, id, ...args);
  });
  let Controller;
  try { ({ Controller } = require(extensionFile)); }
  finally { t.mock.restoreAll(); delete require.cache[extensionFile]; }
  const controller = { panels, ensureBackend: () => connected, updateChatTitle() {} };
  const opens = [Controller.prototype.openChat.call(controller, thread), Controller.prototype.openChat.call(controller, thread)];
  ready();
  await Promise.all(opens);
  assert.equal(created, 1);
  assert.equal(revealed, 1);
});
