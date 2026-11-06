'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { renderChatShell } = require('../extension/src/view');

function fixture() {
  const nodes = new Map(), events = new Map(), classes = new Set(), saved = [];
  const document = { body: { classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) } }, addEventListener() {}, querySelectorAll: () => [],
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', attributes: new Map(),
        addEventListener: (type, listener) => events.set(id + ':' + type, listener),
        setAttribute(name, value) { this.attributes.set(name, value); }, getAttribute(name) { return this.attributes.get(name); }, focus() {} });
      return nodes.get(id);
    } };
  document.getElementById('expand-input').setAttribute('aria-expanded', 'false');
  let message;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/media/chat.js'), 'utf8'), {
    document, window: { addEventListener: (_, listener) => { message = listener; } },
    acquireVsCodeApi: () => ({ getState: () => ({ draft: 'Long synthetic draft\n'.repeat(100) }), setState: value => saved.push(value), postMessage() {} })
  });
  return { input: nodes.get('input'), button: nodes.get('expand-input'), classes, events, saved, message: data => message({ data }) };
}

test('long input saves the draft without assigning an automatic inline height', () => {
  const f = fixture();
  f.input.style = { set height(_) { assert.fail('Input must not auto-grow'); } };
  f.events.get('input:input')();
  assert.equal(f.saved.at(-1).draft, f.input.value);
  assert.equal(f.classes.has('composer-expanded'), false);
  assert.match(renderChatShell({ id: 'synthetic-chat' }), /id="expand-input"[^>]*aria-expanded="false"/);
});

test('explicit expand and collapse retain text and caret and expose accessible state', () => {
  const f = fixture(), text = f.input.value;
  f.input.selectionStart = 7; f.input.selectionEnd = 13;
  f.button.onclick();
  assert.equal(f.classes.has('composer-expanded'), true);
  assert.equal(f.button.getAttribute('aria-expanded'), 'true');
  assert.equal(f.button.textContent, 'Свернуть');
  f.button.onclick();
  assert.equal(f.classes.has('composer-expanded'), false);
  assert.equal(f.button.getAttribute('aria-expanded'), 'false');
  assert.equal(f.input.value, text);
  assert.equal(f.input.selectionStart, 7);
  assert.equal(f.input.selectionEnd, 13);
});

test('an accepted send restores the compact composer for the next message', () => {
  const f = fixture();
  f.button.onclick(); f.message({ type: 'sent' });
  assert.equal(f.classes.has('composer-expanded'), false);
  assert.equal(f.button.textContent, 'Развернуть');
  assert.equal(f.input.value, '');
  assert.equal(f.saved.at(-1).draft, '');
});
