'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createChatPanel } = require('../extension/src/chat-panel');

const local = path.resolve(__dirname, '../.local/tmp');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
async function fixture() {
  await fs.mkdir(local, { recursive: true });
  const root = await fs.mkdtemp(path.join(local, 'clipboard-'));
  const thread = { id: 'synthetic-chat', cwd: root }, messages = [], rpc = new EventEmitter();
  let receive, input;
  rpc.releaseThread = async () => {};
  rpc.request = async (method, params) => {
    if (method === 'model/list') return { data: [{ id: 'test-model' }] };
    if (method === 'thread/loaded/list') return { data: [thread.id] };
    if (method === 'thread/read') return { thread: { ...thread, status: { type: 'idle' } } };
    if (method === 'turn/start') { input = params.input; return { turn: { id: 'synthetic-turn' } }; }
    throw new Error('Unexpected method: ' + method);
  };
  const panel = { onDidDispose() {}, webview: { postMessage: message => messages.push(message), onDidReceiveMessage: handler => { receive = handler; return { dispose() {} }; } } };
  const controller = {
    backend: { connect: async () => rpc }, panels: new Map(), sessions: new Map(), updateChatTitle() {}, rebuildTree() {}, setChatRunning() {}, getProjectAccess: () => 'project', waitForProjectAccess: async () => {},
    context: { globalStorageUri: { fsPath: root }, globalState: { get: () => ({}), update: async () => {} } }
  };
  createChatPanel({ window: { createWebviewPanel: () => panel }, ViewColumn: { Active: 1 } }, controller, thread);
  return {
    root, messages, receive: message => receive(message), input: () => input,
    async close() { controller.sessions.get(thread.id).dispose(); assert.ok(root.startsWith(local + path.sep)); await fs.rm(root, { recursive: true, force: true }); }
  };
}

test('pasted images and files become real attachments sent through the existing input path', async () => {
  const f = await fixture();
  try {
    await f.receive({ action: 'pasteFiles', files: [{ name: 'image.png', data: png }, { name: 'note.txt', data: Buffer.from('Synthetic clipboard file').toString('base64') }] });
    const items = f.messages.find(message => message.type === 'attachments').items;
    assert.equal(items.length, 2);
    assert.equal(items[0].name, 'image.png');
    assert.equal(items[0].preview.available, true);
    assert.ok(f.messages.some(message => message.type === 'pasteDone'));
    await f.receive({ action: 'send', text: '', model: 'test-model', attachments: items.map(item => item.id) });
    const image = f.input().find(item => item.type === 'localImage');
    assert.ok(image.path.startsWith(path.join(f.root, 'clipboard') + path.sep));
    assert.deepEqual(await fs.readFile(image.path), Buffer.from(png, 'base64'));
    assert.ok(f.input().some(item => item.type === 'text' && item.text.includes('Synthetic clipboard file')));
  } finally { await f.close(); }
});

test('clipboard filenames cannot select a path outside extension storage', async () => {
  const f = await fixture();
  try {
    await f.receive({ action: 'pasteFiles', files: [{ name: '../../outside.png', data: png }] });
    const items = f.messages.find(message => message.type === 'attachments').items;
    assert.equal(items[0].name, 'outside.png');
    const files = await fs.readdir(path.join(f.root, 'clipboard', 'synthetic-chat'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^[a-f0-9-]+\.png$/);
  } finally { await f.close(); }
});

test('unsupported, malformed, oversized and excessive clipboard batches are rejected before writing', async () => {
  for (const files of [
    [{ name: 'payload.exe', data: 'YQ==' }], [{ name: 'image.png', data: 'not base64' }],
    [{ name: 'note.txt', data: 'A'.repeat(350000) }], Array.from({ length: 9 }, () => ({ name: 'a.txt', data: 'YQ==' }))
  ]) {
    const f = await fixture();
    try {
      await f.receive({ action: 'pasteFiles', files });
      assert.ok(f.messages.some(message => message.type === 'error'));
      assert.ok(f.messages.some(message => message.type === 'pasteDone'));
      assert.deepEqual(await fs.readdir(f.root), []);
    } finally { await f.close(); }
  }
});
