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
  let receive, input, dialog, handoff, chosen = [];
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
    backend: { connect: async () => rpc }, panels: new Map(), sessions: new Map(), updateChatTitle() {}, rebuildTree() {}, setChatRunning() {}, getProjectAccess: () => 'project', waitForProjectAccess: async () => {}, openInApp: async (target, draft) => { handoff = { target, draft }; },
    context: { globalStorageUri: { fsPath: root }, globalState: { get: () => ({}), update: async () => {} } }
  };
  createChatPanel({ window: { createWebviewPanel: () => panel, showOpenDialog: async options => { dialog = options; return chosen; } }, ViewColumn: { Active: 1 } }, controller, thread);
  return {
    root, messages, receive: message => receive(message), input: () => input, choose: files => { chosen = files; }, dialog: () => dialog, handoff: () => handoff, session: () => controller.sessions.get(thread.id),
    failSend() { const request=rpc.request;rpc.request=async(method,...args)=>{if(method==='turn/start')throw Object.assign(new Error('thread synthetic-chat already has an active writer'),{code:-32600});return request(method,...args);}; },
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

test('owner handoff carries draft and attachment references without sending or clearing attachments', async () => {
  const f = await fixture();
  try {
    await f.receive({ action: 'pasteFiles', files: [{ name: 'backup.awg', data: 'AP+A' }] });
    const items = f.messages.findLast(message => message.type === 'attachments').items;
    await f.receive({ action: 'handoff', text: 'Synthetic owner draft', attachments: items.map(item => item.id) });
    assert.equal(f.handoff().target.id, 'synthetic-chat');
    assert.match(f.handoff().draft, /Synthetic owner draft/); assert.match(f.handoff().draft, /backup.awg/);
    assert.equal(f.input(), undefined);
    await f.receive({ action: 'handoff', text: 'Still available', attachments: items.map(item => item.id) });
    assert.match(f.handoff().draft, /Still available/);
  } finally { await f.close(); }
});

test('queued owner handoff uses the selected saved request and retains its attachments and queue entry', async () => {
  const f=await fixture();
  try {
    await f.session().prepare(); f.failSend();
    await f.receive({action:'pasteFiles',files:[{name:'backup.awg',data:'AP+A'}]});
    const items=f.messages.findLast(message=>message.type==='attachments').items;
    const paused = new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{f.session().off('update',listener);reject(new Error('Queue did not pause'));},2000);
      const listener=update=>{if(update.type==='queue' && update.paused){clearTimeout(timer);f.session().off('update',listener);resolve();}};
      f.session().on('update',listener);
    });
    await f.receive({action:'enqueue',text:'Saved queued request',model:'test-model',attachments:items.map(item=>item.id)});
    await paused;
    const item=f.session().queue[0];assert.equal(item.writerConflict,true);
    await f.receive({action:'handoffQueued',id:item.id});
    assert.match(f.handoff().draft,/Saved queued request/);assert.match(f.handoff().draft,/backup.awg/);
    assert.equal(f.session().queue.length,1);
  } finally {await f.close();}
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

test('malformed, oversized and excessive clipboard batches are rejected before writing', async () => {
  for (const files of [
    [{ name: '\u0000bad', data: 'YQ==' }], [{ name: 'image.png', data: 'not base64' }],
    [{ name: 'large.bin', data: 'A'.repeat(70 * 1024 * 1024) }], Array.from({ length: 11 }, () => ({ name: 'a.txt', data: 'YQ==' }))
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

test('ten arbitrary files are accepted; binaries and large text stay local file references', async () => {
  const f = await fixture();
  try {
    const files = [{ name: 'backup.awg', data: Buffer.from([0, 255, 128]).toString('base64') }, { name: 'large.txt', data: Buffer.from('z'.repeat(300000)).toString('base64') },
      ...Array.from({ length: 8 }, (_, i) => ({ name: 'file-' + i, data: 'YQ==' }))];
    await f.receive({ action: 'pasteFiles', files });
    const items = f.messages.find(message => message.type === 'attachments').items;
    assert.equal(items.length, 10); assert.ok(items.every(item => item.kind === 'file'));
    await f.receive({ action: 'send', text: 'Inspect backups', model: 'test-model', attachments: items.map(item => item.id) });
    assert.equal(f.input().length, 11);
    assert.ok(f.input().slice(1).every(item => item.type === 'text' && item.text.includes('Прикреплённый файл:') && item.text.length < 1000));
  } finally { await f.close(); }
});

test('file picker has no extension filter and enforces the ten attachment limit', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.root, 'backup.awg'); await fs.writeFile(file, 'synthetic backup');
    f.choose(Array.from({ length: 10 }, () => ({ fsPath: file })));
    await f.receive({ action: 'attach' });
    assert.equal(f.dialog().filters, undefined);
    assert.equal(f.messages.findLast(message => message.type === 'attachments').items.length, 10);
    f.choose([{ fsPath: file }]); await f.receive({ action: 'attach' });
    assert.match(f.messages.at(-1).message, /10/);
  } finally { await f.close(); }
});
