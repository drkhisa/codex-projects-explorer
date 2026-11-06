'use strict';
const { CodexRpc, collectPages } = require('./rpc');
const { scanLocal, readRollout, contentText, timeSeconds } = require('./local-store');
const { readProjectState, canonical } = require('./projects');
const path = require('node:path');
const { toolView, historyResult } = require('./history');
const { contentAttachments, generatedImageAttachment } = require('./attachments');

const SOURCES = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
function unsupported(e) { return [-32601, -32602].includes(e?.code) || /unsupported|unknown method|not supported/i.test(e?.message || ''); }
function normalizeThread(t, archived, home) {
  return { ...t, id: t.id, home, archived,
    name: t.name || '', preview: t.preview || '', cwd: t.cwd || '',
    createdAt: timeSeconds(t.createdAt), updatedAt: timeSeconds(t.updatedAt),
    origin: 'appServer' };
}
function normalizeTurns(turns) {
  const timeline = [];
  for (const [turnIndex, turn] of turns.entries()) {
    const turnId = turn.id || `turn-${turnIndex}`;
    for (const [itemIndex, item] of (turn.items || []).entries()) {
      const id = item.id || `${turnId}-item-${itemIndex}`;
      if (['userMessage', 'agentMessage', 'plan'].includes(item.type)) {
        const role = item.type === 'userMessage' ? 'user' : 'assistant';
        const text = item.type === 'userMessage' ? contentText(item.content) : item.text || contentText(item.content);
        const attachments = contentAttachments(item.content);
        if (text || attachments.length) timeline.push({ kind: 'message', id, turnId, role, text, ...(attachments.length ? { attachments } : {}) });
      } else if (item.type === 'imageGeneration') {
        timeline.push({ kind: 'tool', ...toolView({ ...item, id }), turnId });
        if (item.savedPath || item.result || item.fileId) timeline.push({ kind: 'message', id: id + '-image', turnId, role: 'assistant', text: '', attachments: [generatedImageAttachment(item)] });
      } else if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'collabToolCall', 'imageView', 'contextCompaction'].includes(item.type)) {
        timeline.push({ kind: 'tool', ...toolView({ ...item, id }), turnId });
      }
    }
    if (turn.error) timeline.push({ kind: 'message', id: `${turnId}-error`, turnId, role: 'error', text: turn.error.message || String(turn.error) });
  }
  return historyResult(timeline);
}
class Backend {
  constructor(options) { this.options = options; this.rpc = null; this.lastDiagnostics = {}; }
  async connect() {
    if (this.rpc && !this.rpc.closed) { await this.rpc.start(); return this.rpc; }
    if (!this.options.executable) throw new Error('Не найден codex.exe. Установите официальное расширение Codex или укажите путь в настройках.');
    this.rpc?.dispose();
    this.rpc = this.options.rpcFactory ? this.options.rpcFactory() : new CodexRpc(this.options.executable, this.options.home);
    await this.rpc.start(); return this.rpc;
  }
  async load(includeArchived, { signal, onProgress } = {}) {
    const { home, dataSource, stateFile } = this.options;
    const state = await readProjectState(stateFile || path.join(home, '.codex-global-state.json'));
    const errors = state.error ? [state.error] : [];
    let apiThreads = [], apiSucceeded = false, apiProjects = [], projectApiSucceeded = false;
    if (dataSource !== 'localFiles') {
      try {
        const rpc = await this.connect();
        for (const archived of includeArchived ? [false, true] : [false]) {
          const rows = await collectPages(rpc, 'thread/list', {
            limit: 100, modelProviders: [], sourceKinds: SOURCES, archived, sortKey: 'updated_at'
          }, { signal, onPage: n => onProgress?.(`Codex: ${n} ${archived ? 'архивных ' : ''}чатов…`) });
          apiThreads.push(...rows.map(t => normalizeThread(t, archived, home)));
        }
        apiSucceeded = true;
        try {
          const projects = await collectPages(rpc, 'project/list', { limit: 100, sortKey: 'position' }, { signal });
          apiProjects = projects.filter(p => typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.roots)).map(p => ({ ...p, projectId: p.id, paths: p.roots.map(r => r.path).filter(Boolean), origin: 'canonical' }));
          projectApiSucceeded = true;
        } catch (e) { if (signal?.aborted) throw e; if (!unsupported(e)) errors.push(`Каталог проектов Codex: ${e.message}`); }
      } catch (e) {
        if (signal?.aborted) throw e;
        errors.push(`App Server: ${e.message}`);
        // Never retain half a page range as a complete successful result.
        apiThreads = [];
        if (dataSource === 'appServer') throw e;
      }
    }
    let local = { threads: [], files: 0, errors: [] };
    if (dataSource !== 'appServer') {
      try {
        local = await scanLocal(home, includeArchived, { signal, titles: state.titles,
          onProgress: (n, total) => { if (n % 25 === 0) onProgress?.(`Локальные сессии: ${n} из ${total}…`); } });
      } catch (e) { if (signal?.aborted) throw e; errors.push(`Локальные сессии: ${e.message}`); }
    }
    const merged = new Map();
    for (const t of local.threads) merged.set(t.id, { ...t, home });
    for (const t of apiThreads) {
      const old = merged.get(t.id);
      merged.set(t.id, { ...old, ...t,
        file: old?.file || (typeof t.path === 'string' ? t.path : undefined),
        localSource: old?.source, originator: t.originator || old?.originator || null, threadSource: t.threadSource || old?.threadSource || null,
        name: t.name || old?.name || state.titles[t.id] || '', preview: t.preview || old?.preview || '' });
    }
    // A state-only title may be newer than a legacy rollout title, but an API name wins.
    const threads = [...merged.values()].filter(t => this.options.showSubagents || !/sub.?agent/i.test(typeof t.source === 'string' ? t.source : JSON.stringify(t.source || '')));
    this.lastDiagnostics = {
      extensionVersion: require('../package.json').version, platform: process.platform, codexHome: home,
      executable: this.options.executable || 'не найден', dataSource,
      stateFile: stateFile || path.join(home, '.codex-global-state.json'),
      projectStateFound: state.found, projectStateRecognized: state.recognized,
      projectStateRelevantKeys: state.relevantKeys, desktopProjects: state.projects.length,
      projectApiSucceeded, canonicalProjectRecords: apiProjects.length,
      apiSucceeded, apiThreads: apiThreads.length, localFiles: local.files,
      localThreads: local.threads.length, uniqueThreads: threads.length,
      includesArchived: includeArchived, errors: [...errors, ...local.errors],
      scope: 'Локальное хранилище выбранного CODEX_HOME. Облачная история аккаунта не запрашивалась.',
      generatedAt: new Date().toISOString()
    };
    const legacyProjects = state.projects.filter(p => !apiProjects.some(a => p.paths.some(r => a.paths.some(root => canonical(root) === canonical(r)))));
    return { threads, projects: projectApiSucceeded ? [...apiProjects, ...legacyProjects] : state.projects, diagnostics: this.lastDiagnostics };
  }
  async history(thread) {
    let rpcError;
    if (this.options.dataSource !== 'localFiles') {
      try {
        const rpc = await this.connect();
        let turns;
        try { turns = await collectPages(rpc, 'thread/turns/list', { threadId: thread.id, limit: 50, sortDirection: 'asc', itemsView: 'full' }); }
        catch (e) {
          // A newly started thread has no persisted turns until its first message.
          if (!thread.file && /not materialized yet.*unavailable before first user message/i.test(e.message)) return normalizeTurns([]);
          if (!unsupported(e)) throw e;
          const result = await rpc.request('thread/read', { threadId: thread.id, includeTurns: true });
          if (!Array.isArray(result?.thread?.turns)) throw new Error('Сервер не вернул историю.');
          turns = result.thread.turns;
        }
        const result = normalizeTurns(turns);
        if (!result.messages.length && thread.file) return await readRollout(thread.file);
        return result;
      } catch (e) { rpcError = e; }
    }
    if (thread.file) {
      const result = await readRollout(thread.file);
      if (rpcError) result.note += `\nApp Server недоступен для этой истории: ${rpcError.message}`;
      return result;
    }
    throw rpcError || new Error('Для этого чата не найден доступный файл истории.');
  }
  dispose() { this.rpc?.dispose(); this.rpc = null; }
}
module.exports = { Backend, SOURCES, normalizeThread, normalizeTurns, unsupported };
