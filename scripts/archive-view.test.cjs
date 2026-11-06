'use strict';
const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const { Backend } = require('../extension/src/backend');
const { OnlineStore } = require('../extension/src/online-store');

let confirmation, prompts = [];
const vscode = {
  EventEmitter: class { event() {} fire() {} }, TreeItem: class { constructor(label) { this.label = label; } }, ThemeIcon: class { constructor(id) { this.id = id; } },
  TreeItemCollapsibleState: { Collapsed: 1, Expanded: 2 },
  window: { showWarningMessage: async (...args) => { prompts.push(args); return confirmation; } }
};
const original = Module._load;
mock.method(Module, '_load', function (id, ...args) { return id === 'vscode' ? vscode : original.call(this, id, ...args); });
const { Controller, ProjectsTree } = require('../extension/src/extension');
mock.restoreAll();

const local = path.resolve(__dirname, '../.local/tmp');
async function fixture() {
  await fs.mkdir(local, { recursive: true });
  const root = await fs.mkdtemp(path.join(local, 'archive-view-')), one = path.join(root, 'One'), two = path.join(root, 'Two');
  prompts = []; confirmation = undefined;
  const controller = Object.assign(Object.create(Controller.prototype), {
    section: 'codex', includeArchived: false, overrides: {}, pins: {}, chatOrder: {}, projectCategories: {},
    threads: [{ id: 'synthetic-active', home: root, cwd: one, source: 'cli', archived: false }, { id: 'synthetic-archive-one', home: root, cwd: one, source: 'cli', archived: true }, { id: 'synthetic-archive-two', home: root, cwd: two, source: 'cli', archived: true }],
    tree: new ProjectsTree(), view: {}, backend: { options: { home: root } }, online: new OnlineStore(), onlineBridge: { connected: false },
    panels: new Map(), sessions: new Map(), context: { globalStorageUri: { fsPath: root } },
    projectSources: { desktop: [], folders: [{ name: 'One', path: one }, { name: 'Two', path: two }] },
    config: () => ({ get: (_, fallback) => fallback }), chatActivity: () => ({ running: false, label: '' }), saveOrder() {},
    ensureBackend: async () => {}, refresh: async () => {}
  });
  return { root, controller, async close() { assert.ok(root.startsWith(local + path.sep)); await fs.rm(root, { recursive: true, force: true }); } };
}

test('archive mode contains only archived chats grouped under their original projects', async () => {
  const f = await fixture();
  try {
    f.controller.rebuildTree();
    assert.deepEqual(f.controller.visibleThreads().map(t => t.id), ['synthetic-active']);
    const activeKey = f.controller.orderKey('project');
    f.controller.includeArchived = true; f.controller.rebuildTree();
    assert.equal(f.controller.visibleThreads().length, 2);
    assert.deepEqual(f.controller.tree.groups.map(g => [g.name, g.threads.length]).sort(), [['One', 1], ['Two', 1]]);
    assert.notEqual(f.controller.orderKey('project'), activeKey);
    assert.equal(f.controller.orderKey('project', false), activeKey);
    assert.equal(f.controller.tree.getTreeItem({ kind: 'section' }).label, 'Архив Codex ▾');
  } finally { await f.close(); }
});

test('cancelled confirmation never calls delete or touches the archived chat', async () => {
  const f = await fixture();
  try {
    let deleted = false;
    f.controller.backend.deleteArchivedThread = async () => { deleted = true; };
    await f.controller.deleteArchivedChat(f.controller.threads[1]);
    assert.equal(deleted, false);
    assert.equal(f.controller.threads.length, 3);
    assert.equal(prompts[0][1].modal, true);
    assert.match(prompts[0][1].detail, /дочерние чаты/);
  } finally { await f.close(); }
});

test('confirmed deletion targets one archived chat and its own clipboard storage only', async () => {
  const f = await fixture();
  try {
    const target = f.controller.threads[1], calls = [];
    const own = path.join(f.root, 'clipboard', target.id), keep = path.join(f.root, 'clipboard', 'synthetic-keep');
    await fs.mkdir(own, { recursive: true }); await fs.mkdir(keep);
    await fs.writeFile(path.join(own, 'copy.txt'), 'Synthetic attachment'); await fs.writeFile(path.join(keep, 'keep.txt'), 'Keep');
    f.controller.backend.deleteArchivedThread = async thread => { calls.push(thread.id); };
    confirmation = 'Удалить навсегда';
    await f.controller.deleteArchivedChat(target);
    assert.deepEqual(calls, [target.id]);
    assert.equal(f.controller.threads.length, 2);
    await assert.rejects(fs.stat(own), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(keep, 'keep.txt'), 'utf8'), 'Keep');
  } finally { await f.close(); }
});

test('active and online chats cannot reach permanent deletion', async () => {
  const f = await fixture();
  try {
    const archived = f.controller.threads[1];
    f.controller.sessions.set(archived.id, { running: true });
    await assert.rejects(f.controller.deleteArchivedChat(archived), /работающий/);
    await assert.rejects(f.controller.deleteArchivedChat(f.controller.threads[0]), /архивный чат Codex/);
    await assert.rejects(f.controller.deleteArchivedChat({ ...archived, provider: 'chatgpt-browser' }), /архивный чат Codex/);
    assert.equal(prompts.length, 0);
  } finally { await f.close(); }
});

test('backend rechecks archive membership and state, deletes via RPC and prunes cached metadata', async () => {
  const f = await fixture(), target = f.controller.threads[1], requests = [];
  try {
    let saved, inArchive = true, active = false;
    const rpc = { start: async () => {}, request: async (method, params) => {
      requests.push({ method, params });
      if (method === 'thread/list') return { data: inArchive ? [target] : [] };
      if (method === 'thread/read') return { thread: { id: target.id, status: { type: active ? 'active' : 'notLoaded' } } };
      if (method === 'thread/delete') return {};
      throw new Error(method);
    } };
    const backend = new Backend({ home: f.root, dataSource: 'appServer', executable: 'synthetic', rpcFactory: () => rpc, cacheState: { update: async (_, value) => { saved = value; } } });
    backend.cache = { threads: [target, f.controller.threads[0]], local: { target: { thread: target }, keep: { thread: f.controller.threads[0] } } };
    inArchive = false; await assert.rejects(backend.deleteArchivedThread(target), /больше не находится/);
    inArchive = true; active = true; await assert.rejects(backend.deleteArchivedThread(target), /безопасно удалить/);
    assert.equal(requests.filter(r => r.method === 'thread/delete').length, 0);
    active = false; await backend.deleteArchivedThread(target);
    assert.equal(requests.find(r => r.method === 'thread/list').params.useStateDbOnly, false);
    assert.deepEqual(requests.find(r => r.method === 'thread/delete').params, { threadId: target.id });
    assert.deepEqual(saved.threads.map(t => t.id), ['synthetic-active']);
    assert.deepEqual(Object.keys(saved.local), ['keep']);
  } finally { await f.close(); }
});

test('backend rejects read-only sources and stale-home targets before starting a server', async () => {
  const f = await fixture(), target = f.controller.threads[1];
  try {
    const readOnly = new Backend({ home: f.root, dataSource: 'localFiles' });
    await assert.rejects(readOnly.deleteArchivedThread(target), /только для чтения/);
    const changed = new Backend({ home: path.join(f.root, 'another-home'), dataSource: 'appServer' });
    await assert.rejects(changed.deleteArchivedThread(target), /Хранилище изменилось/);
    await assert.rejects(changed.deleteArchivedThread({ ...target, id: '../invalid' }), /архивный чат Codex/);
  } finally { await f.close(); }
});
