'use strict';
const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const Module = require('node:module');
const calls = [], vscode = { env: { clipboard: { writeText: async text => calls.push(['clipboard', text]) }, openExternal: async uri => { calls.push(['open', uri]); return true; } }, Uri: { parse: value => value }, window: { showInformationMessage: text => calls.push(['notice', text]) } };
const load = Module._load;
mock.method(Module, '_load', function(id, ...args) { return id === 'vscode' ? vscode : load.call(this, id, ...args); });
const { Controller } = require('../extension/src/extension'); mock.restoreAll();
const thread = { id: 'synthetic-chat' };
test('short owner draft targets the same chat and encodes text as a prompt', async () => {
  calls.length = 0; await Controller.prototype.openInApp.call({}, thread, 'Text & ? #\nSecond line');
  const url = new URL(calls[0][1]); assert.equal(url.pathname, '/synthetic-chat'); assert.equal(url.hostname, 'threads');
  assert.equal(url.searchParams.get('prompt'), 'Text & ? #\nSecond line'); assert.ok(!calls.some(([kind]) => kind === 'clipboard'));
});
test('long draft stays complete in clipboard and opens the same chat without oversized URI', async () => {
  calls.length = 0; const text = 'Длинный черновик\n'.repeat(500);
  await Controller.prototype.openInApp.call({}, thread, text);
  assert.deepEqual(calls[0], ['clipboard', text]); assert.deepEqual(calls[1], ['open', 'codex://threads/synthetic-chat']);
});
test('failed opening is reported and invalid targets or drafts never reach the OS', async () => {
  calls.length = 0;
  await assert.rejects(Controller.prototype.openInApp.call({}, { id: '../bad' }, 'text'));
  await assert.rejects(Controller.prototype.openInApp.call({}, thread, { text: 'bad' }));
  assert.equal(calls.length, 0);
  const old = vscode.env.openExternal; vscode.env.openExternal = async () => false;
  try { await assert.rejects(Controller.prototype.openInApp.call({}, thread, 'text'), /не открыл/); }
  finally { vscode.env.openExternal = old; }
});
