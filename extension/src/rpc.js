'use strict';
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { EventEmitter } = require('node:events');

class RpcError extends Error {
  constructor(message, code) { super(message); this.name = 'RpcError'; this.code = code; }
}

// A separate, owned stdio process. Never attach to/terminate the desktop app's process.
class CodexRpc extends EventEmitter {
  constructor(executable, home, options = {}) {
    super(); this.executable = executable; this.home = home;
    this.timeout = options.timeout || 30000;
    this.processFactory = options.processFactory || spawn;
    this.pending = new Map(); this.nextId = 0; this.closed = false;
    this.stopping = false; this.log = options.log || (() => {});
  }
  async start() {
    if (this.ready) return this.ready;
    this.ready = this._start();
    return this.ready;
  }
  async _start() {
    this.proc = this.processFactory(this.executable, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, CODEX_HOME: this.home }
    });
    this.proc.on('error', e => this.fail(new Error(`Не удалось запустить Codex: ${e.message}`)));
    this.proc.on('exit', (code, signal) => {
      this.fail(new Error(`Процесс Codex завершён (${code ?? signal ?? 'закрыт'}). Обновите список для повторного подключения.`));
      this.emit('closed');
    });
    this.proc.stdin.on('error', e => this.fail(e));
    // Never log raw stderr: installed servers can include paths, prompts or auth details.
    this.proc.stderr.on('data', () => {});
    this.lines = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => this.receive(line));
    try {
      const info = await this.request('initialize', {
        clientInfo: { name: 'codex_projects_explorer', title: 'Codex Projects Explorer', version: require('../package.json').version },
        capabilities: { experimentalApi: true }
      });
      this.send({ method: 'initialized', params: {} });
      return info;
    } catch (e) { this.dispose(); throw e; }
  }
  send(message) {
    if (this.closed || !this.proc?.stdin?.writable) throw new Error('Соединение с Codex закрыто.');
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}, timeoutMs = this.timeout) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('Соединение с Codex закрыто.'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Ignore a late response. Stop waiting without killing an unrelated process.
        reject(new Error(`Codex не ответил на ${method} за ${timeoutMs / 1000} с.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  receive(line) {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id !== undefined) {
      let replied = false;
      const request = { ...msg, claimed: false,
        respond: result => { if (!replied) { replied = true; this.send({ id: msg.id, result }); } },
        reject: message => { if (!replied) { replied = true; this.send({ id: msg.id, error: { code: -32601, message } }); } }
      };
      this.emit('serverRequest', request);
      if (!request.claimed) { try { request.reject('No active chat can handle this request.'); } catch {} }
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error.message || 'Ошибка Codex', msg.error.code));
      else p.resolve(msg.result);
    } else if (msg.method) this.emit('notification', msg);
  }
  fail(error) {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  dispose() {
    if (this.stopping) return; this.stopping = true;
    this.fail(new Error('Соединение закрыто.'));
    this.lines?.close();
    if (this.proc) {
      this.proc.stdin.end();
      const proc = this.proc;
      const timer = setTimeout(() => { if (proc.exitCode === null && !proc.killed) proc.kill(); }, 1500);
      timer.unref();
    }
  }
}

async function collectPages(rpc, method, params = {}, { signal, onPage } = {}) {
  const data = []; const seen = new Set(); let cursor;
  do {
    if (signal?.aborted) throw new Error('Загрузка отменена.');
    const page = await rpc.request(method, { ...params, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page?.data)) throw new Error(`${method}: сервер вернул неизвестный формат списка.`);
    data.push(...page.data); onPage?.(data.length);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error(`${method}: сервер повторил курсор. Список неполон.`);
    if (cursor) seen.add(cursor);
  } while (cursor);
  return data;
}

module.exports = { CodexRpc, RpcError, collectPages };
