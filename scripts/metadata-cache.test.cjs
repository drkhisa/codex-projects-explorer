'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Backend } = require('../extension/src/backend');

const local = path.resolve(__dirname, '../.local/tmp');
async function fixture() {
  await fsp.mkdir(local, { recursive: true });
  const home = await fsp.mkdtemp(path.join(local, 'metadata-cache-'));
  await fsp.mkdir(path.join(home, 'sessions'));
  const values = new Map();
  const cacheState = { get: key => values.has(key) ? structuredClone(values.get(key)) : undefined, update: async (key, value) => { values.set(key, structuredClone(value)); } };
  async function session(id) {
    const file = path.join(home, 'sessions', id + '.jsonl');
    await fsp.writeFile(file, [
      { type: 'session_meta', payload: { id, cwd: home, source: 'cli', git: { repositoryUrl: 'synthetic-private-git-info' } } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic first message ' + id } }
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    return file;
  }
  return { home, values, cacheState, session, backend: options => new Backend({ home, dataSource: 'localFiles', cacheState, ...options }), async close() { assert.ok(home.startsWith(local + path.sep)); await fsp.rm(home, { recursive: true, force: true }); } };
}

test('a fresh backend shows the saved list before I/O and does not reread unchanged histories', async t => {
  const f = await fixture();
  try {
    const file = await f.session('synthetic-one');
    assert.equal((await f.backend().load(false)).diagnostics.localFilesRead, 1);
    let cached, reads = 0;
    const original = fs.createReadStream;
    t.mock.method(fs, 'createReadStream', function (name, ...args) { if (name === file) reads++; return original.call(this, name, ...args); });
    const result = await f.backend().load(false, { onCached: snapshot => { cached = snapshot; assert.equal(reads, 0); } });
    assert.equal(cached.threads[0].id, 'synthetic-one');
    assert.equal(reads, 0);
    assert.equal(result.diagnostics.localFilesCached, 1);
    assert.equal(result.diagnostics.localFilesRead, 0);
    assert.ok(!JSON.stringify(f.values.get('threadMetadataCacheV1')).includes('synthetic-private-git-info'));
  } finally { t.mock.restoreAll(); await f.close(); }
});

test('only new and changed files are read and deleted entries disappear', async () => {
  const f = await fixture();
  try {
    const one = await f.session('synthetic-one'), two = await f.session('synthetic-two');
    await f.backend().load(false);
    await fsp.appendFile(one, JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Synthetic update' } }) + '\n');
    await f.session('synthetic-three');
    const changed = await f.backend().load(false);
    assert.equal(changed.diagnostics.localFilesRead, 2);
    assert.equal(changed.diagnostics.localFilesCached, 1);
    await fsp.unlink(two);
    const removed = await f.backend().load(false);
    assert.equal(removed.threads.length, 2);
    assert.equal(removed.diagnostics.localFilesRead, 0);
    assert.ok(!removed.threads.some(thread => thread.id === 'synthetic-two'));
    assert.ok(!Object.hasOwn(f.values.get('threadMetadataCacheV1').local, two));
  } finally { await f.close(); }
});

test('title index changes are applied without reading session contents again', async () => {
  const f = await fixture();
  try {
    await f.session('synthetic-one');
    await f.backend().load(false);
    await fsp.writeFile(path.join(f.home, 'session_index.jsonl'), JSON.stringify({ id: 'synthetic-one', thread_name: 'Новое имя' }) + '\n');
    const result = await f.backend().load(false);
    assert.equal(result.threads[0].name, 'Новое имя');
    assert.equal(result.diagnostics.localFilesRead, 0);
  } finally { await f.close(); }
});

test('switching archive views reuses unchanged file summaries', async () => {
  const f = await fixture();
  try {
    await f.session('synthetic-one');
    await f.backend().load(false);
    assert.equal((await f.backend().load(true)).diagnostics.localFilesRead, 0);
    assert.equal((await f.backend().load(false)).diagnostics.localFilesRead, 0);
  } finally { await f.close(); }
});

test('cache keys isolate homes and archive views and malformed snapshots are ignored', async () => {
  const f = await fixture();
  try {
    await f.session('synthetic-one'); await f.backend().load(false);
    let snapshots = 0;
    await f.backend().load(true, { onCached: () => { snapshots++; } });
    assert.equal(snapshots, 0);
    await f.backend({ home: path.join(f.home, 'other-store') }).load(false, { onCached: () => { snapshots++; } });
    assert.equal(snapshots, 0);
    await f.backend().load(false);
    const broken = f.values.get('threadMetadataCacheV1'); broken.projects = [null];
    const fresh = await f.backend().load(false, { onCached: () => { snapshots++; } });
    assert.equal(snapshots, 0);
    assert.equal(fresh.threads.length, 1);
  } finally { await f.close(); }
});

test('API metadata caches omit turns, auth and stale runtime state; warm queries use the state DB', async () => {
  const f = await fixture(), requests = [];
  try {
    const rpc = { start: async () => {}, request: async (method, params) => {
      if (method === 'project/list') return { data: [] };
      assert.equal(method, 'thread/list'); requests.push(params);
      return { data: [{ id: 'synthetic-api', name: 'Title', preview: 'Preview', cwd: f.home, status: { type: 'active' }, auth: 'synthetic-secret-token', turns: [{ text: 'synthetic-private-turn' }] }] };
    } };
    const options = { dataSource: 'appServer', executable: 'synthetic', rpcFactory: () => rpc };
    await f.backend(options).load(false);
    let snapshot;
    await f.backend(options).load(false, { onCached: value => { snapshot = value; } });
    assert.equal(requests[0].useStateDbOnly, false);
    assert.equal(requests[1].useStateDbOnly, true);
    assert.equal(snapshot.threads[0].status, undefined);
    const stored = JSON.stringify(f.values.get('threadMetadataCacheV1'));
    assert.ok(!stored.includes('synthetic-secret-token'));
    assert.ok(!stored.includes('synthetic-private-turn'));
  } finally { await f.close(); }
});
