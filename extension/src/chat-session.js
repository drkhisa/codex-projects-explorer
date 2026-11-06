'use strict';
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const { collectPages } = require('./rpc');
const { validId } = require('./local-store');
const { toolView } = require('./history');
const { generatedImageAttachment } = require('./attachments');

const ACCESS = {
  project: { sandbox: 'workspace-write', policy: cwd => ({ type: 'workspaceWrite', writableRoots: cwd ? [cwd] : [], networkAccess: false }) },
  read: { sandbox: 'read-only', policy: () => ({ type: 'readOnly' }) },
  full: { sandbox: 'danger-full-access', policy: () => ({ type: 'dangerFullAccess' }) }
};
class ChatSession extends EventEmitter {
  constructor(backend, thread) {
    super(); if (!validId(thread?.id)) throw new Error('Некорректный ID чата.');
    this.backend = backend; this.thread = thread; this.models = []; this.pending = new Map(); this.items = new Map();
    this.running = false; this.resumed = false; this.disposed = false; this.turnId = null; this.stopRequested = false;
    this.onNotification = msg => this.notification(msg);
    this.onRequest = request => this.serverRequest(request);
    this.onClosed = () => { if (this.running) this.requiresSync = true; this.running = false; this.resumed = false; this.turnId = null; this.pending.clear(); this.emit('update', { type: 'requestsCleared' }); this.emit('update', { type: 'error', message: 'Соединение с Codex закрыто. Обновите вкладку перед повторной отправкой.' }); this.state(); };
  }
  async prepare() {
    if (this.disposed) throw new Error('Чат закрыт.');
    const rpc = await this.backend.connect();
    if (this.rpc !== rpc) {
      this.detach(); this.rpc = rpc; this.resumed = false;
      rpc.on('notification', this.onNotification); rpc.on('serverRequest', this.onRequest); rpc.on('closed', this.onClosed);
    }
    this.models = await collectPages(rpc, 'model/list', { limit: 100, includeHidden: false });
    return this.models;
  }
  state() { this.emit('update', { type: 'state', running: this.running, turnId: this.turnId }); }
  validate(selection) {
    const model = this.models.find(m => (m.model || m.id) === selection.model);
    if (!model) throw new Error('Выберите модель из списка, полученного от Codex.');
    const efforts = (model.supportedReasoningEfforts || []).map(x => x.reasoningEffort);
    if (selection.effort && !efforts.includes(selection.effort)) throw new Error('Эта глубина размышлений не поддерживается выбранной моделью.');
    if (!ACCESS[selection.access]) throw new Error('Выберите режим доступа.');
    return model;
  }
  async send({ text, model, effort, access = 'project', extraInputs = [] }) {
    if (this.running) throw new Error('Дождитесь ответа или остановите текущую задачу.');
    if (this.thread.archived) throw new Error('Сначала восстановите архивный чат в приложении Codex.');
    if (this.requiresSync) throw new Error('Результат прошлой отправки неизвестен. Нажмите «Обновить» и проверьте историю перед повтором.');
    if (typeof text !== 'string' || text.length > 1000000 || (!text.trim() && !extraInputs.length)) throw new Error('Введите сообщение или добавьте файл.');
    this.running = true; this.stopRequested = false; this.turnId = null; this.state();
    let startingTurn = false;
    try {
      if (!this.rpc || this.rpc.closed || !this.models.length) await this.prepare();
      const selected = this.validate({ model, effort, access });
      if (extraInputs.some(i => i.type === 'localImage') && !(selected.inputModalities || ['text', 'image']).includes('image')) throw new Error('Выбранная модель не поддерживает изображения.');
      if (this.thread.cwd && !(await fs.stat(this.thread.cwd)).isDirectory()) throw new Error('Рабочая папка чата недоступна.');
      const permissions = ACCESS[access];
      if (!this.resumed) {
        const params = { threadId: this.thread.id, model, sandbox: permissions.sandbox, approvalPolicy: 'on-request', approvalsReviewer: 'user', excludeTurns: true,
          ...(this.thread.cwd ? { cwd: this.thread.cwd } : {}) };
        let result;
        // Reuse this server's live thread, including new threads without a rollout.
        if ((await collectPages(this.rpc, 'thread/loaded/list')).includes(this.thread.id)) {
          result = await this.rpc.request('thread/read', { threadId: this.thread.id, includeTurns: false });
        } else {
          try { result = await this.rpc.request('thread/resume', params, 120000); }
          catch (e) {
            if (e.code !== -32602) throw e;
            delete params.excludeTurns; delete params.approvalsReviewer;
            result = await this.rpc.request('thread/resume', params, 120000);
          }
        }
        if (result.thread?.status?.type === 'active') throw new Error('Этот чат уже выполняется в другом клиенте Codex. Дождитесь завершения.');
        this.resumed = true;
      }
      if (this.stopRequested) { this.running = false; this.state(); return { cancelled: true }; }
      const input = [...(text.trim() ? [{ type: 'text', text }] : []), ...extraInputs];
      startingTurn = true;
      const result = await this.rpc.request('turn/start', { threadId: this.thread.id, input, model,
        ...(effort ? { effort } : {}), approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: permissions.policy(this.thread.cwd) }, 120000);
      if (this.running) this.turnId = result.turn?.id || this.turnId;
      if (!this.thread.preview && text.trim()) this.thread.preview = text.trim().slice(0, 200);
      this.emit('update', { type: 'sent' }); this.state();
      if (this.stopRequested && this.running) await this.stop();
      return result;
    } catch (e) {
      if (startingTurn && !Number.isFinite(e.code)) this.requiresSync = true;
      this.running = Boolean(this.requiresSync && this.turnId); this.state(); throw e;
    }
  }
  notification(msg) {
    const p = msg.params || {}; if (p.threadId !== this.thread.id || this.disposed) return;
    const method = msg.method;
    if (method === 'turn/started') { this.turnId = p.turn?.id; this.running = true; this.state(); }
    else if (method === 'turn/completed') {
      this.running = false; this.turnId = null; this.stopRequested = false;
      this.pending.clear(); this.emit('update', { type: 'requestsCleared' });
      this.emit('update', { type: 'finished', status: p.turn?.status, error: p.turn?.error?.message || '' }); this.state();
    } else if (method === 'turn/diff/updated' && typeof p.diff === 'string') {
      this.emit('update',{type:'tool',item:{id:'turn-diff-'+p.turnId,type:'fileChange',turnId:p.turnId,text:p.diff,changes:[{path:'Изменения ответа',diff:p.diff}],status:'updated'}});
    } else if (method === 'item/agentMessage/delta') {
      this.emit('update', { type: 'delta', itemId: p.itemId, delta: p.delta || '' });
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = p.item; if (!item?.id) return; this.items.set(item.id, item);
      if (item.type === 'agentMessage' || item.type === 'plan') this.emit('update', { type: 'message', itemId: item.id, turnId: p.turnId || this.turnId, text: item.text || '', completed: method === 'item/completed' });
      else if (!['userMessage', 'reasoning'].includes(item.type)) {
        this.emit('update', { type: 'tool', item: { ...toolView(item), turnId: p.turnId || this.turnId } });
        if (item.type === 'imageGeneration' && method === 'item/completed' && (item.savedPath || item.result || item.fileId)) this.emit('update', { type: 'message', itemId: item.id + '-image', text: '', attachments: [generatedImageAttachment(item)], completed: true });
      }
    } else if (method === 'item/commandExecution/outputDelta') {
      this.emit('update', { type: 'toolDelta', itemId: p.itemId, delta: p.delta || '' });
    } else if (method === 'serverRequest/resolved') {
      this.pending.delete(String(p.requestId)); this.emit('update', { type: 'requestResolved', requestId: String(p.requestId) });
    } else if (method === 'error') {
      this.emit('update', { type: 'error', message: p.error?.message || 'Ошибка Codex', retrying: Boolean(p.willRetry) });
    } else if (method === 'warning') this.emit('update', { type: 'notice', message: p.message || '' });
  }
  serverRequest(request) {
    if (request.params?.threadId !== this.thread.id || this.disposed) return;
    request.claimed = true;
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'tool/requestUserInput', 'mcpServer/elicitation/request'];
    if (!supported.includes(request.method)) { request.reject('This client does not support this interaction.'); this.emit('update', { type: 'notice', message: `Codex запросил неподдерживаемое действие: ${request.method}` }); return; }
    const requestId = String(request.id); this.pending.set(requestId, request);
    const p = request.params;
    const item = this.items.get(p.itemId);
    // Only present requested operations; accepting never grants more than these fields.
    const view = { requestId, method: request.method, reason: p.reason || p.message || '',
      command: p.command || item?.command || '', cwd: p.cwd || '',
      files: item?.changes?.map(c => ({ path: c.path, diff: c.diff || '' })) || [],
      permissions: p.permissions || null, network: p.networkApprovalContext || null,
      questions: p.questions || [], schema: p.requestedSchema || null, mode: p.mode || null,
      availableDecisions: p.availableDecisions || null };
    this.emit('update', { type: 'request', request: view });
  }
  answer(requestId, answer) {
    const request = this.pending.get(String(requestId)); if (!request) throw new Error('Запрос уже завершён.');
    const p = request.params; let result;
    if (request.method === 'item/permissions/requestApproval') result = { permissions: answer.accept ? (p.permissions || {}) : {}, scope: 'turn' };
    else if (['item/tool/requestUserInput', 'tool/requestUserInput'].includes(request.method)) {
      const answers = {};
      for (const q of p.questions || []) {
        const value = answer.answers?.[q.id];
        if (typeof value !== 'string' || !value.trim()) throw new Error('Ответьте на каждый вопрос.');
        answers[q.id] = { answers: [value] };
      }
      result = { answers };
    } else if (request.method === 'mcpServer/elicitation/request') {
      // Complex connector forms are declined explicitly; no implicit authorization or URL opening.
      result = { action: 'decline', content: null };
    } else {
      const decision = answer.decision === 'cancel' ? 'cancel' : answer.accept ? 'accept' : 'decline';
      if (Array.isArray(p.availableDecisions) && !p.availableDecisions.includes(decision)) throw new Error('Этот вариант не разрешён сервером.');
      result = { decision };
    }
    request.respond(result); this.pending.delete(String(requestId));
    this.emit('update', { type: 'requestResolved', requestId: String(requestId) });
  }
  async stop() {
    this.stopRequested = true;
    if (this.running && this.turnId && this.rpc && !this.rpc.closed) await this.rpc.request('turn/interrupt', { threadId: this.thread.id, turnId: this.turnId });
  }
  async synchronize() {
    if (this.requiresSync) {
      const metadata = await this.rpc.request('thread/read', { threadId: this.thread.id, includeTurns: false });
      if (!metadata.thread) throw new Error('Не удалось подтвердить состояние чата.');
      if (metadata.thread.status?.type === 'active') throw new Error('Прошлый запрос ещё выполняется. Дождитесь завершения или откройте чат в приложении.');
    }
    this.requiresSync = false;
  }
  detach() {
    this.rpc?.off('notification', this.onNotification); this.rpc?.off('serverRequest', this.onRequest); this.rpc?.off('closed', this.onClosed);
  }
  dispose() {
    this.disposed = true;
    for (const request of this.pending.values()) {
      try {
        if (request.method === 'item/permissions/requestApproval') request.respond({ permissions: {}, scope: 'turn' });
        else if (request.method === 'mcpServer/elicitation/request') request.respond({ action: 'cancel', content: null });
        else if (request.method.endsWith('/requestApproval')) request.respond({ decision: 'cancel' });
        else request.reject('Chat closed.');
      } catch {}
    }
    this.pending.clear(); this.detach(); this.removeAllListeners();
  }
}
module.exports = { ChatSession, ACCESS };
