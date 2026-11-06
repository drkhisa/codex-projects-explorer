'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ChatSession } = require('./chat-session');
const { renderChatShell, chatTitle } = require('./view');
const { AttachmentRegistry } = require('./attachments');
const { loadCatalog } = require('./catalog');

const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const TEXT = new Set(['.txt', '.md', '.json', '.yaml', '.yml', '.js', '.ts', '.tsx', '.jsx', '.py', '.gd', '.cs', '.cpp', '.c', '.h', '.log', '.csv', '.html', '.css', '.toml', '.xml', '.sql', '.lrc']);
const MAX_FILE_BYTES = 50 * 1024 * 1024, MAX_ATTACHMENTS = 10;
function fileKind(ext, size) {
  return IMAGES.has(ext) && size <= 10 * 1024 * 1024 ? 'image' : TEXT.has(ext) && size <= 256 * 1024 ? 'text' : 'file';
}
function ownerDraft(text, inputs) {
  return [text, ...inputs.map(item => item.type === 'localImage' ? `Прикреплённое изображение: ${item.path}` : item.text || `Контекст: ${item.path || ''}`)].filter(Boolean).join('\n\n');
}

function createChatPanel(vscode, controller, thread) {
  const panel = vscode.window.createWebviewPanel('codexProjects.chat', chatTitle(thread), controller.files?.editorColumn || vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
  const session = new ChatSession(controller.backend, thread), attachments = new Map();
  const patches = new Map();
  const rememberPatch = item=>{if(item?.type==='fileChange' && typeof item.text==='string')patches.set(item.id,item.text);};
  const media = new AttachmentRegistry(vscode, panel, thread); let catalog = new Map();
  controller.sessions.set(thread.id, session); controller.panels.set(thread.id, panel);
  let closed = false, booting = false, pasting = false;
  const post = message => { if (!closed) panel.webview.postMessage(message); };
  const fail = error => {
    const writerConflict = /already has an active writer/i.test(error.message || '');
    post({ type: 'error', writerConflict, message: writerConflict
      ? 'Этот чат открыт в другом клиенте Codex. Нажмите «Продолжить в Codex с черновиком», чтобы открыть тот же чат у владельца. Текст и вложения здесь сохранены.'
      : error.message || String(error), retrying: session.running });
  };
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
  session.getAccess = async () => { await controller.waitForProjectAccess?.(); return controller.getProjectAccess?.(thread) || 'project'; };
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
      session.state(); session.queueState(); attachmentView();
    } finally { booting = false; }
  }
  async function attach() {
    const files = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true,
      openLabel: 'Добавить в сообщение' });
    for (const uri of files || []) {
      if (attachments.size >= MAX_ATTACHMENTS) throw new Error('Можно добавить до 10 вложений к одному сообщению.');
      const ext = path.extname(uri.fsPath).toLowerCase();
      const stat = await fs.stat(uri.fsPath), kind = fileKind(ext, stat.size);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Можно прикрепить файл размером до 50 МБ.');
      const id = crypto.randomUUID(), name = path.basename(uri.fsPath), preview = await media.register({ kind: kind === 'image' ? 'image' : 'document', location: uri.fsPath, name, explicit: true }, 'user');
      attachments.set(id, { id, name, path: uri.fsPath, kind, preview });
    }
    attachmentView();
  }
  async function pasteFiles(files) {
    if (!Array.isArray(files) || !files.length || files.length + attachments.size > MAX_ATTACHMENTS) throw new Error('Можно добавить до 10 вложений к одному сообщению.');
    let total = 0;
    const prepared = files.map(file => {
      if (typeof file?.name !== 'string' || file.name.length > 255 || /[\x00-\x1f]/.test(file.name)) throw new Error('Некорректное имя файла из буфера обмена.');
      const name = path.basename(file.name.replace(/\\/g, '/')), ext = path.extname(name).toLowerCase();
      if (!name || name === '.' || name === '..') throw new Error('Некорректное имя файла из буфера обмена.');
      if (typeof file.data !== 'string' || file.data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || file.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new Error('Файл из буфера обмена слишком большой или повреждён.');
      const bytes = Buffer.from(file.data, 'base64'); total += bytes.length;
      if (bytes.length > MAX_FILE_BYTES || total > MAX_FILE_BYTES) throw new Error('Превышен допустимый размер вложений из буфера обмена.');
      return { id: crypto.randomUUID(), name, ext, kind: fileKind(ext, bytes.length), bytes };
    });
    const directory = path.join(controller.context.globalStorageUri.fsPath, 'clipboard', thread.id);
    await fs.mkdir(directory, { recursive: true });
    try {
      for (const file of prepared) {
        const location = path.join(directory, file.id + file.ext);
        await fs.writeFile(location, file.bytes, { flag: 'wx' });
        const preview = await media.register({ kind: file.kind === 'image' ? 'image' : 'document', location, name: file.name, explicit: true }, 'user');
        attachments.set(file.id, { id: file.id, name: file.name, path: location, kind: file.kind, preview });
      }
    } finally { attachmentView(); }
  }
  async function folder() {
    const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Добавить папку в контекст' });
    if (!selected?.[0]) return; if (attachments.size >= MAX_ATTACHMENTS) throw new Error('Можно добавить до 10 элементов.');
    const id = crypto.randomUUID(), file = selected[0].fsPath; attachments.set(id, { id, name: path.basename(file), path: file, kind: 'folder' }); attachmentView();
  }
  function code() {
    const editor = vscode.window.activeTextEditor || controller.lastEditor;
    if (!editor) throw new Error('Сначала откройте файл в редакторе и выделите код.');
    const text = editor.document.getText(editor.selection.isEmpty ? undefined : editor.selection);
    if (text.length > 256 * 1024) throw new Error('Выделите фрагмент до 256 КБ.');
    if (attachments.size >= MAX_ATTACHMENTS) throw new Error('Можно добавить до 10 элементов.');
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
      else if (['send', 'steer', 'enqueue', 'handoff'].includes(message.action)) {
        if (booting || pasting) throw new Error('Дождитесь загрузки истории и вложений.');
        await controller.waitForProjectAccess?.();
        const ids = Array.isArray(message.attachments) ? [...new Set(message.attachments)] : [];
        if (ids.length > MAX_ATTACHMENTS) throw new Error('Можно добавить до 10 вложений к одному сообщению.');
        const selected = ids.map(id => attachments.get(id));
        if (selected.some(a => !a)) throw new Error('Обновите список вложений.');
        const extraInputs = [];
        for (const item of selected) {
          if (item.input) extraInputs.push(item.input);
          else if (item.kind === 'image') extraInputs.push({ type: 'localImage', path: item.path });
          else if (item.kind === 'code') extraInputs.push({ type: 'text', text: `Код из редактора: ${item.name}\n\n${item.text}` });
          else if (item.kind === 'folder') extraInputs.push({ type: 'text', text: `Папка, выбранная пользователем для контекста: ${item.path}\nИзучи нужные файлы этой папки по задаче.` });
          else if (item.kind === 'file') {
            const stat = await fs.stat(item.path); if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error('Документ изменился или недоступен; добавьте его заново.');
            extraInputs.push({ type: 'text', text: `Прикреплённый файл: [${item.name}](<${item.path}>)\nИзучи этот локальный файл подходящими инструментами, если это требуется для задачи. Прикрепление само по себе не является разрешением на запуск файла. Если подходящего инструмента нет, сообщи об этом.` });
          } else {
            const stat = await fs.stat(item.path);
            if (stat.size > 256 * 1024) throw new Error('Размер выбранного файла изменился; добавьте его заново.');
            extraInputs.push({ type: 'text', text: `Прикреплённый файл: [${item.name}](<${item.path}>)\n\n${await fs.readFile(item.path, 'utf8')}` });
          }
        }
        if (message.action === 'handoff') {
          if (typeof message.text !== 'string' || message.text.length > 1000000) throw new Error('Некорректный черновик.');
          await controller.openInApp(thread, ownerDraft(message.text, extraInputs));
          return;
        }
        const access = controller.getProjectAccess?.(thread) || 'project';
        const options = { text: message.text, model: message.model, effort: message.effort, access, extraInputs,
          display: { text: message.text, ids, names: selected.map(a => a.name), assets: selected.filter(a => a.preview).map(a => a.preview) } };
        const result = message.action === 'enqueue' ? session.enqueue(options) : message.action === 'steer' ? await session.steer(options) : await session.send(options);
        if (!result?.cancelled) { for (const id of ids) attachments.delete(id); attachmentView(); }
        else post({ type: 'error', message: 'Отправка отменена; текст и вложения сохранены.' });
        if (!result?.cancelled) {
          const all = { ...controller.context.globalState.get('chatPreferences', {}), [thread.id]: { model: message.model, effort: message.effort } };
          await controller.context.globalState.update('chatPreferences', all);
        }
      } else if (message.action === 'handoffQueued') {
        const item = session.queue.find(item => item.id === message.id);
        if (!item?.writerConflict || session.draining) throw new Error('Запрос больше недоступен для передачи.');
        await controller.openInApp(thread, ownerDraft(item.text, item.extraInputs || []));
      }
      else if (message.action === 'removeQueued') session.removeQueued(message.id);
      else if (message.action === 'resumeQueue') session.resumeQueue();
      else if (message.action === 'stop') await session.stop();
      else if (message.action === 'setProjectAccess') {
        try { await controller.setProjectAccess(thread, message.access); }
        finally { post({ type: 'projectAccess', access: controller.getProjectAccess?.(thread) || 'project', projectName: controller.projectScope?.(thread).name || '' }); }
      }
      else if (message.action === 'answer') session.answer(message.requestId, message.answer || {});
      else if (message.action === 'pasteFiles') {
        if (pasting) throw new Error('Дождитесь добавления предыдущих вложений.');
        pasting = true;
        try { await pasteFiles(message.files); }
        finally { pasting = false; post({ type: 'pasteDone' }); }
      }
      else if (['attach', 'attachFolder', 'attachCode'].includes(message.action)) {
        if (pasting) throw new Error('Дождитесь добавления предыдущих вложений.');
        pasting = true;
        try { if (message.action === 'attach') await attach(); else if (message.action === 'attachFolder') await folder(); else code(); }
        finally { pasting = false; attachmentView(); post({ type: 'pasteDone' }); }
      }
      else if (message.action === 'catalog') await showCatalog();
      else if (message.action === 'selectCatalog') {
        if (pasting) throw new Error('Дождитесь добавления предыдущих вложений.');
        const item = catalog.get(message.id); if (!item) throw new Error('Обновите список плагинов и скиллов.');
        if (attachments.size >= MAX_ATTACHMENTS) throw new Error('Можно добавить до 10 элементов.');
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
