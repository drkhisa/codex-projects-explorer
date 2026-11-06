'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ChatSession } = require('./chat-session');
const { renderChatShell, chatTitle } = require('./view');
const { AttachmentRegistry, DOCUMENT } = require('./attachments');
const { loadCatalog } = require('./catalog');

const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const TEXT = new Set(['.txt', '.md', '.json', '.yaml', '.yml', '.js', '.ts', '.tsx', '.jsx', '.py', '.gd', '.cs', '.cpp', '.c', '.h', '.log', '.csv', '.html', '.css', '.toml', '.xml', '.sql', '.lrc']);

function createChatPanel(vscode, controller, thread) {
  const panel = vscode.window.createWebviewPanel('codexProjects.chat', chatTitle(thread), controller.files?.editorColumn || vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
  const session = new ChatSession(controller.backend, thread), attachments = new Map();
  const patches = new Map();
  const rememberPatch = item=>{if(item?.type==='fileChange' && typeof item.text==='string')patches.set(item.id,item.text);};
  const media = new AttachmentRegistry(vscode, panel, thread); let catalog = new Map();
  controller.sessions.set(thread.id, session); controller.panels.set(thread.id, panel);
  let closed = false, booting = false;
  const post = message => { if (!closed) panel.webview.postMessage(message); };
  const fail = error => post({ type: 'error', message: error.message || String(error), retrying: session.running });
  session.on('update', update => {
    if (update.type === 'sent') { controller.updateChatTitle(thread); controller.rebuildTree(); }
    if(update.type==='tool' && update.item?.type==='fileChange'){rememberPatch(update.item);controller.files?.refreshChanges();}
    if(update.type==='finished')controller.files?.refreshChanges();
    if (update.type === 'state') controller.setChatRunning?.(thread.id, update.running);
    post(update);
    if (update.type === 'message' && update.completed) media.decorate({ role: 'assistant', text: update.text, attachments: update.attachments }).then(item => post({ type: 'messageAssets', itemId: update.itemId, attachments: item.attachments })).catch(fail);
  });
  const preferences = () => {
    const { access: _, ...saved } = controller.context.globalState.get('chatPreferences', {})[thread.id] || {};
    return { ...(thread.model ? { model: thread.model } : {}), ...(thread.reasoningEffort ? { effort: thread.reasoningEffort } : {}), ...saved,
      access: controller.getProjectAccess?.(thread) || 'project', projectName: controller.projectScope?.(thread).name || '' };
  };
  const attachmentView = () => post({ type: 'attachments', items: [...attachments.values()].map(a => ({ id: a.id, name: a.name, kind: a.kind, ...(a.preview ? { preview: a.preview } : {}) })) });
  async function bootstrap() {
    if (booting || session.running) return; booting = true;
    try {
      panel.title = chatTitle(thread); post({ type: 'title', title: panel.title });
      const results = await Promise.allSettled([controller.backend.history(thread), session.prepare()]);
      if (results[0].status === 'fulfilled') { for(const item of results[0].value.tools||[])rememberPatch(item);post({ type: 'history', history: await media.history(results[0].value) }); await session.synchronize(); }
      else fail(results[0].reason);
      if (results[1].status === 'fulfilled') post({ type: 'models', models: results[1].value, preferences: preferences() });
      else { post({ type: 'models', models: [] }); fail(results[1].reason); }
      session.state(); attachmentView();
    } finally { booting = false; }
  }
  async function attach() {
    if (session.running) return;
    const files = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true,
      openLabel: 'Добавить в сообщение', filters: { 'Изображения и документы': [...IMAGES, ...TEXT, ...DOCUMENT].map(s => s.slice(1)) } });
    for (const uri of files || []) {
      if (attachments.size >= 8) throw new Error('Можно добавить до 8 файлов к одному сообщению.');
      const ext = path.extname(uri.fsPath).toLowerCase();
      if (!IMAGES.has(ext) && !TEXT.has(ext) && !DOCUMENT.has(ext)) throw new Error('Поддерживаются изображения, документы и текстовые файлы.');
      const stat = await fs.stat(uri.fsPath), kind = IMAGES.has(ext) ? 'image' : TEXT.has(ext) ? 'text' : 'document';
      if (!stat.isFile() || stat.size > (kind === 'image' ? 10 * 1024 * 1024 : kind === 'text' ? 256 * 1024 : 50 * 1024 * 1024)) throw new Error('Файл слишком большой: изображение — до 10 МБ, текст — до 256 КБ, документ — до 50 МБ.');
      const id = crypto.randomUUID(), name = path.basename(uri.fsPath), preview = await media.register({ kind: kind === 'image' ? 'image' : 'document', location: uri.fsPath, name, explicit: true }, 'user');
      attachments.set(id, { id, name, path: uri.fsPath, kind, preview });
    }
    attachmentView();
  }
  async function folder() {
    if (session.running) return;
    const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Добавить папку в контекст' });
    if (!selected?.[0]) return; if (attachments.size >= 8) throw new Error('Можно добавить до 8 элементов.');
    const id = crypto.randomUUID(), file = selected[0].fsPath; attachments.set(id, { id, name: path.basename(file), path: file, kind: 'folder' }); attachmentView();
  }
  function code() {
    if (session.running) return;
    const editor = vscode.window.activeTextEditor || controller.lastEditor;
    if (!editor) throw new Error('Сначала откройте файл в редакторе и выделите код.');
    const text = editor.document.getText(editor.selection.isEmpty ? undefined : editor.selection);
    if (text.length > 256 * 1024) throw new Error('Выделите фрагмент до 256 КБ.');
    if (attachments.size >= 8) throw new Error('Можно добавить до 8 элементов.');
    const id = crypto.randomUUID(); attachments.set(id, { id, name: path.basename(editor.document.uri.fsPath) + ' · код', kind: 'code', text }); attachmentView();
  }
  async function showCatalog() {
    try {
    const rpc = await controller.backend.connect(), result = await loadCatalog(rpc, thread.cwd);
    catalog = new Map(result.items.map(item => [item.id, item]));
    post({ type: 'catalog', items: result.items.map(({ input: _, ...view }) => view), errors: result.errors });
    } catch (error) { post({ type: 'catalog', items: [], errors: [error.message] }); }
  }
  const listener = panel.webview.onDidReceiveMessage(async message => {
    try {
      if (!message || typeof message.action !== 'string') return;
      if(message.action==='reviewChange'){const patch=patches.get(message.itemId);if(!patch)throw new Error('Изменения этого ответа недоступны. Обновите историю.');const {ChangesReview}=require('./changes');controller.changes ||= new ChangesReview(vscode);await controller.changes.patch(patch,chatTitle(thread)+' · изменения');return;}
      if (message.action === 'ready' || message.action === 'refresh') await bootstrap();
      else if (message.action === 'send') {
        if (booting) throw new Error('Дождитесь загрузки истории.');
        await controller.waitForProjectAccess?.();
        const ids = Array.isArray(message.attachments) ? [...new Set(message.attachments)] : [];
        const selected = ids.map(id => attachments.get(id));
        if (selected.some(a => !a)) throw new Error('Обновите список вложений.');
        const extraInputs = [];
        for (const item of selected) {
          if (item.input) extraInputs.push(item.input);
          else if (item.kind === 'image') extraInputs.push({ type: 'localImage', path: item.path });
          else if (item.kind === 'code') extraInputs.push({ type: 'text', text: `Код из редактора: ${item.name}\n\n${item.text}` });
          else if (item.kind === 'folder') extraInputs.push({ type: 'text', text: `Папка, выбранная пользователем для контекста: ${item.path}\nИзучи нужные файлы этой папки по задаче.` });
          else if (item.kind === 'document') {
            const stat = await fs.stat(item.path); if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error('Документ изменился или недоступен; добавьте его заново.');
            extraInputs.push({ type: 'text', text: `Прикреплённый документ: [${item.name}](<${item.path}>)\nПрочитай этот локальный документ доступными инструментами, если это требуется для задачи. Если подходящего инструмента нет, сообщи об этом.` });
          } else {
            const stat = await fs.stat(item.path);
            if (stat.size > 256 * 1024) throw new Error('Размер выбранного файла изменился; добавьте его заново.');
            extraInputs.push({ type: 'text', text: `Прикреплённый файл: [${item.name}](<${item.path}>)\n\n${await fs.readFile(item.path, 'utf8')}` });
          }
        }
        const access = controller.getProjectAccess?.(thread) || 'project';
        const result = await session.send({ text: message.text, model: message.model, effort: message.effort, access, extraInputs });
        if (!result.cancelled) {
          const all = { ...controller.context.globalState.get('chatPreferences', {}), [thread.id]: { model: message.model, effort: message.effort } };
          await controller.context.globalState.update('chatPreferences', all);
        }
      } else if (message.action === 'stop') await session.stop();
      else if (message.action === 'setProjectAccess') {
        try { await controller.setProjectAccess(thread, message.access); }
        finally { post({ type: 'projectAccess', access: controller.getProjectAccess?.(thread) || 'project', projectName: controller.projectScope?.(thread).name || '' }); }
      }
      else if (message.action === 'answer') session.answer(message.requestId, message.answer || {});
      else if (message.action === 'attach') await attach();
      else if (message.action === 'attachFolder') await folder();
      else if (message.action === 'attachCode') code();
      else if (message.action === 'catalog') await showCatalog();
      else if (message.action === 'selectCatalog') {
        if (session.running) return; const item = catalog.get(message.id); if (!item) throw new Error('Обновите список плагинов и скиллов.');
        if (attachments.size >= 8) throw new Error('Можно добавить до 8 элементов.');
        if (![...attachments.values()].some(a => a.input?.path === item.input.path)) { const id = crypto.randomUUID(); attachments.set(id, { id, name: item.name, kind: item.kind, input: item.input }); }
        attachmentView();
      }
      else if (message.action === 'openAttachment') await media.open(message.id);
      else if (message.action === 'removeAttachment') { attachments.delete(message.id); attachmentView(); }
      else if (message.action === 'clearAttachments') { attachments.clear(); attachmentView(); }
      else if (message.action === 'app') await controller.openInApp(thread);
      else if (message.action === 'changes') await controller.openProject({name:controller.projectScope?.(thread)?.name || path.basename(thread.cwd || ''),paths:[thread.cwd].filter(Boolean)});
      else if (message.action === 'resume') await controller.resume(thread);
      else if (message.action === 'openLink' && typeof message.url === 'string') {
        const url = new URL(message.url); if (['https:', 'http:'].includes(url.protocol)) await vscode.env.openExternal(vscode.Uri.parse(url.href));
      }
    } catch (error) { fail(error); }
  });
  panel.onDidDispose(() => {
    closed = true; listener.dispose(); controller.panels.delete(thread.id);
    if (session.running) session.stop().catch(e => vscode.window.showWarningMessage(`Остановка Codex не подтверждена: ${e.message}`)).finally(() => { session.dispose(); controller.releaseSessionActivity?.(thread.id); });
    else { session.dispose(); controller.releaseSessionActivity?.(thread.id); }
    controller.sessions.delete(thread.id);
  });
  panel.webview.html = renderChatShell(thread, panel.webview.cspSource);
  return panel;
}
module.exports = { createChatPanel, IMAGES, TEXT };
