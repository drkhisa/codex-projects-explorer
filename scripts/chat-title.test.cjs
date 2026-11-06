'use strict';
const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { createChatPanel } = require('../extension/src/chat-panel');

const vscode = {
  window: { withProgress: async (_, run) => run({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) }), showErrorMessage: message => assert.fail(message) },
  workspace: { workspaceFolders: [] }
};
const originalLoad = Module._load;
mock.method(Module, '_load', function (id, ...args) { return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args); });
const { Controller } = require('../extension/src/extension');
mock.restoreAll();

function fixture() {
  const thread = { id: 'synthetic-chat', name: '', preview: '', cwd: path.resolve(__dirname, '../.local') };
  const messages = [];
  let renders = 0, html = '';
  const panel = { title: thread.id, reveal() {}, webview: { postMessage: message => messages.push(message), get html() { return html; }, set html(value) { html = value; renders++; } } };
  const controller = Object.assign(Object.create(Controller.prototype), {
    panels: new Map([[thread.id, panel]]), sessions: new Map([[thread.id, { thread }]]), threads: [{ ...thread }],
    skillCache: new Map(), tree: { groups: [], refresh() {} }, view: {}, standaloneThreads: {},
    backend: { load: async () => ({ threads: controller.threads, projects: [], diagnostics: { errors: [], apiSucceeded: true } }) },
    ensureBackend: async () => {}, attachActivityRpc() {}, refreshActivity: async () => {},
    rebuildTree() {}, updateViewMessage() {}, output: { appendLine() {} }
  });
  return { controller, panel, thread, messages, renders: () => renders };
}

test('refresh synchronizes an open tab when the list receives a new name', async () => {
  const f = fixture();
  f.controller.threads = [{ ...f.thread, name: 'Новое имя', cwd: 'must-not-replace-session-cwd' }];
  await f.controller.refresh();
  assert.equal(f.panel.title, 'Новое имя');
  assert.equal(f.thread.name, 'Новое имя');
  assert.equal(f.thread.cwd, path.resolve(__dirname, '../.local'));
  assert.deepEqual(f.messages.at(-1), { type: 'title', title: 'Новое имя' });
  assert.equal(f.renders(), 0);
});

test('selecting an already open chat updates its title and keeps the session', async () => {
  const f = fixture(), session = f.controller.sessions.get(f.thread.id);
  await f.controller.openChat({ ...f.thread, name: 'Имя из дерева' });
  assert.equal(f.panel.title, 'Имя из дерева');
  assert.equal(f.controller.sessions.get(f.thread.id), session);
  assert.equal(f.thread.name, 'Имя из дерева');
  assert.equal(f.renders(), 0);
});

test('the first message becomes the title when no explicit name is assigned', async () => {
  const f = fixture();
  f.controller.threads = [{ ...f.thread, preview: 'Чё как\nтут' }];
  await f.controller.refresh();
  assert.equal(f.panel.title, 'Чё как тут');
  assert.deepEqual(f.messages.at(-1), { type: 'title', title: 'Чё как тут' });
});

test('rename notifications update the tree record and open tab, including cleared names', () => {
  const f = fixture(), rpc = new EventEmitter();
  let changes = 0;
  f.controller.rebuildTree = () => { changes++; };
  Controller.prototype.attachActivityRpc.call(f.controller, rpc);
  rpc.emit('notification', { method: 'thread/name/updated', params: { threadId: f.thread.id, threadName: 'Новое имя' } });
  assert.equal(f.controller.threads[0].name, 'Новое имя');
  assert.equal(f.panel.title, 'Новое имя');
  rpc.emit('notification', { method: 'thread/name/updated', params: { threadId: 'other-chat', threadName: 'Чужое имя' } });
  rpc.emit('notification', { method: 'thread/name/updated', params: { threadId: f.thread.id, threadName: 123 } });
  assert.equal(f.panel.title, 'Новое имя');
  assert.equal(changes, 1);
  rpc.emit('notification', { method: 'thread/name/updated', params: { threadId: f.thread.id, threadName: null } });
  assert.equal(f.panel.title, f.thread.id);
});

test('the webview updates the heading as plain text and preserves the draft', () => {
  const nodes = new Map(), listeners = new Map();
  const document = {
    title: 'synthetic-chat', addEventListener() {}, querySelectorAll: () => [],
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', addEventListener() {} });
      return nodes.get(id);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/media/chat.js'), 'utf8'), {
    document, window: { addEventListener: (type, listener) => listeners.set(type, listener) },
    acquireVsCodeApi: () => ({ getState: () => ({ draft: 'Синтетический черновик' }), postMessage() {} })
  });
  const title = '<img src=x onerror=alert(1)> Имя';
  listeners.get('message')({ data: { type: 'title', title } });
  assert.equal(document.title, title);
  assert.equal(nodes.get('chat-title')?.textContent, title);
  assert.equal(nodes.get('input').value, 'Синтетический черновик');
});

test('a webview ready event receives a title changed before its listener was ready', async () => {
  const f = fixture();
  let receive;
  f.panel.webview.onDidReceiveMessage = handler => { receive = handler; return { dispose() {} }; };
  f.panel.onDidDispose = () => {};
  const backend = { history: async () => ({ messages: [], tools: [], timeline: [] }), connect: async () => Object.assign(new EventEmitter(), { request: async () => ({ data: [] }) }) };
  f.controller.backend = backend;
  f.controller.context = { globalState: { get: () => ({}) } };
  createChatPanel({ window: { createWebviewPanel: () => f.panel }, ViewColumn: { Active: 1 } }, f.controller, f.thread);
  assert.match(f.panel.webview.html, /<h1 id="chat-title">/);
  f.thread.name = 'Имя до загрузки webview';
  await receive({ action: 'ready' });
  assert.equal(f.panel.title, f.thread.name);
  assert.ok(f.messages.some(message => message.type === 'title' && message.title === f.thread.name));
  f.controller.sessions.get(f.thread.id).dispose();
});
