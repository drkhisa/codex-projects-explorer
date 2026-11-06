'use strict';
const vscode = require('vscode');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { Backend, SOURCES } = require('./backend');
const { collectPages } = require('./rpc');
const { groupThreads, baseName, secondaryGroup } = require('./projects');
const { validId } = require('./local-store');
const { findExecutable, codexHome, expand } = require('./discovery');
const { chatTitle, renderChat } = require('./view');
const { resumeLaunch } = require('./terminal-launch');
const { createChatPanel } = require('./chat-panel');
const { ProjectFiles } = require('./file-panel');
const { classifyThread, threadKey, LABELS, sourceReport } = require('./sections');
const crypto = require('node:crypto');
const { reconcileOrder, orderedThreads, moveBefore } = require('./chat-order');
const categories = require('./categories');
const { projectAccessKey, validateAccess } = require('./project-access');
const { OnlineStore } = require('./online-store');
const { OnlineBridge } = require('./online-bridge');
const { renderSetup, renderOnline } = require('./online-view');
const { RolloutActivity, runtimeActivity } = require('./activity');
const DRAG_MIME = 'application/vnd.code.tree.codexprojects.tree';

const PREFIX = 'codexProjects';
const originLabels = { desktop: 'Импортировано из состояния приложения Codex', configured: 'Название и папки заданы в расширении', workspace: 'Папка из рабочего пространства VS Code', canonical: 'Проект с каноническим projectId. Название и папки берутся из каталога Codex, когда он доступен.', inferred: 'Группировка по рабочей папке. Расширение не получило запись проекта из приложения; это не означает, что проекта нет.' };

class ProjectsTree {
  constructor() { this.groups = []; this.loading = false; this.section = 'codex'; this._changed = new vscode.EventEmitter(); this.onDidChangeTreeData = this._changed.event; }
  refresh() { this._changed.fire(); }
  getChildren(element) {
    if (element?.kind === 'onlineRoot') return this.onlineGroups.map(group => ({ kind: 'onlineProject', group }));
    if (element?.kind === 'onlineProject') return element.group.threads.map(thread => ({ kind: 'onlineChat', thread }));
    if (element?.kind === 'category') return element.category.threads.filter(thread => !thread.pinned).map(thread => ({ kind: 'chat', thread }));
    if (element?.kind === 'skills') return Promise.resolve(this.skillsProvider(element.group));
    if (element?.kind === 'skillScope') return element.skills.map(skill => ({ kind: 'skill', skill, owner: element.id }));
    if (element?.kind === 'unassigned') return (this.looseThreads || this.groups.filter(secondaryGroup).flatMap(group => group.threads)).map(thread => ({ kind: 'chat', thread }));
    if (element?.kind === 'project') {
      const group = element.group;
      return [
        ...(group.pinnedThreads || group.threads.filter(t => t.pinned)).map(thread => ({ kind: 'chat', thread })),
        ...(group.categories || []).map(category => ({ kind: 'category', group, category })),
        ...(group.directThreads || group.threads).filter(t => !t.pinned).map(thread => ({ kind: 'chat', thread })),
        ...(this.skillsProvider ? [{ kind: 'skills', group }] : [])
      ];
    }
    if (element) return [];
    const roots = [{ kind: 'section' },{kind:'newChat'}];
    if (this.section === 'chatgpt') { roots.push({ kind: 'sourceStatus' }); if (this.onlineGroups?.length) roots.push({ kind: 'onlineRoot' }); }
    if (!this.groups.length) { if (this.section !== 'chatgpt' || this.loading) roots.push({ kind: 'empty' }); return roots; }
    roots.push(...this.groups.filter(g => !secondaryGroup(g)).map(group => ({ kind: 'project', group })));
    if (this.groups.some(secondaryGroup)) roots.push({ kind: 'unassigned' });
    return roots;
  }
  getTreeItem(element) {
    if(element.kind==='newChat'){const item=new vscode.TreeItem('＋ Новый чат');item.id='codexProjects:newChat';item.iconPath=new vscode.ThemeIcon('add');item.command={command:`${PREFIX}.newChatMenu`,title:'Новый чат: в проекте или вне проекта'};item.tooltip='Создать чат вне проекта или выбрать проект';return item;}
    if (element.kind === 'onlineRoot') {
      const item = new vscode.TreeItem('Онлайн ChatGPT — из браузера', vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'codexProjects:onlineRoot'; item.iconPath = new vscode.ThemeIcon(this.onlineGroups.some(g=>g.threads.some(t=>t.running)) ? 'loading~spin' : 'globe'); item.description = 'Часть истории'; return item;
    }
    if (element.kind === 'onlineProject') {
      const g = element.group, item = new vscode.TreeItem(g.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = g.id; item.iconPath = new vscode.ThemeIcon(g.threads.some(t=>t.running) ? 'loading~spin' : 'folder'); item.description = String(g.threads.length); item.contextValue = 'chatgptOnlineProject';
      item.tooltip = `${g.name}\nОнлайн ChatGPT: только загруженные записи.\nУ онлайн-проекта нет обязательной локальной папки.`; return item;
    }
    if (element.kind === 'onlineChat') {
      const t = element.thread, item = new vscode.TreeItem(t.name); item.id = t.id; item.iconPath = new vscode.ThemeIcon(t.running ? 'loading~spin' : 'comment-discussion');item.description=t.running?'Отвечает · в браузере':'';
      item.contextValue = 'chatgptOnlineChat'; item.tooltip = 'Онлайн ChatGPT · открыть текст снимка. Продолжить можно в исходном ChatGPT.';
      item.command = { command: `${PREFIX}.openChat`, title: 'Открыть онлайн-чат', arguments: [element] }; return item;
    }
    if (element.kind === 'category') {
      const item = new vscode.TreeItem(element.category.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `${element.group.id}:category:${element.category.id}`; item.contextValue = 'codexCategory'; item.iconPath = new vscode.ThemeIcon(element.category.threads.some(t=>t.running) ? 'loading~spin' : 'folder');
      const pinned = element.category.threads.filter(t => t.pinned).length;
      item.description = String(element.category.threads.length - pinned);
      item.tooltip = `${element.group.name} → ${element.category.name}\nКатегория внутри проекта${pinned ? `\nЗакреплённых чатов показано выше категорий: ${pinned}` : ''}`; return item;
    }
    if (element.kind === 'sourceStatus') {
      const item = new vscode.TreeItem(this.onlineStatus || 'Подключить онлайн ChatGPT…');
      item.id = 'codexProjects:chatgptAccountHistory'; item.iconPath = new vscode.ThemeIcon('plug');
      item.tooltip = `Подключение через браузер, где вы вошли в ChatGPT. Данные отображённых страниц, а не подтверждённая полная история аккаунта. Нажмите для настройки.\n${this.onlineStatusDetail || ''}`;
      item.command = { command: `${PREFIX}.connectOnline`, title: 'Подключить онлайн ChatGPT' }; return item;
    }
    if (element.kind === 'skills' || element.kind === 'skillScope') {
      const item = new vscode.TreeItem(element.kind === 'skills' ? 'Скиллы' : element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = element.kind === 'skills' ? `skills:${element.group.id}` : element.id; item.iconPath = new vscode.ThemeIcon('symbol-method');
      if (element.skills) item.description = String(element.skills.length);
      item.tooltip = 'Скиллы, доступные Codex в контексте этого проекта. Каталог Copilot ведётся отдельно.'; return item;
    }
    if (element.kind === 'skill') {
      const s = element.skill, item = new vscode.TreeItem(s.interface?.displayName || s.name);
      item.id = `skill:${element.owner}:${s.path}`; item.iconPath = new vscode.ThemeIcon(s.enabled ? 'symbol-method' : 'circle-slash');
      item.description = s.enabled ? '' : 'Выключен'; item.tooltip = `${s.description || ''}\n${s.path}`;
      item.command = { command: `${PREFIX}.openSkill`, title: 'Посмотреть инструкции скилла', arguments: [s] }; return item;
    }
    if (element.kind === 'skillNote') { const item = new vscode.TreeItem(element.label); item.iconPath = new vscode.ThemeIcon('info'); return item; }
    if (element.kind === 'section') {
      const item = new vscode.TreeItem((this.includeArchived ? 'Архив Codex' : LABELS[this.section]) + ' ▾'); item.id = 'codexProjects:section'; item.iconPath = new vscode.ThemeIcon(this.includeArchived ? 'archive' : this.section === 'chatgpt' ? 'comment-discussion' : 'hubot');
      item.command = { command: `${PREFIX}.switchSection`, title: 'Переключить Codex / ChatGPT' }; item.tooltip = 'Нажмите, чтобы переключить раздел. Истории Codex и ChatGPT показываются раздельно.'; return item;
    }
    if (element.kind === 'unassigned') {
      const groups = this.groups.filter(secondaryGroup);
      const item = new vscode.TreeItem('Отдельные чаты', vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'codexProjects:unassigned'; item.iconPath = new vscode.ThemeIcon(groups.some(g=>g.threads.some(t=>t.running)) ? 'loading~spin' : 'folder-library');
      item.description = `${groups.reduce((n, g) => n + g.threads.length, 0)} чатов`;
      item.tooltip = 'Чаты из автоматически созданных рабочих папок показаны прямо списком, без промежуточных new-chat. Явные проекты сохраняются отдельно.';
      return item;
    }
    if (element.kind === 'empty') {
      const item = new vscode.TreeItem(this.loading ? 'Загружаю локальные чаты…' : this.includeArchived ? 'Архив Codex пуст' : `В выбранном хранилище нет загруженных записей: ${LABELS[this.section]}`);
      item.iconPath = new vscode.ThemeIcon(this.loading ? 'loading~spin' : 'info');
      item.command = { command: `${PREFIX}.diagnostics`, title: 'Диагностика' }; return item;
    }
    if (element.kind === 'project') {
      const g = element.group;
      const item = new vscode.TreeItem(g.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = g.id; item.contextValue = g.origin === 'inferred' ? 'codexInferredProject' : 'codexProject';
      item.description = `${g.threads.length}`;
      item.iconPath = new vscode.ThemeIcon(g.threads.some(t => t.running) ? 'loading~spin' : g.origin === 'inferred' ? 'folder' : 'project');
      item.tooltip = `${g.name}\n${originLabels[g.origin]}\n${g.paths.join('\n')}\nЧатов: ${g.threads.length}`;
      return item;
    }
    const t = element.thread;
    const item = new vscode.TreeItem(chatTitle(t));
    item.id = `thread:${t.id}`; item.contextValue = `codexChat${t.archived ? ':archived' : ':active'}${t.pinned ? ':pinned' : ':unpinned'}`;
    item.iconPath = new vscode.ThemeIcon(t.running ? 'loading~spin' : t.pinned ? 'pinned' : t.archived ? 'archive' : 'comment-discussion');
    item.description = [t.activityLabel || (t.running ? 'Работает…' : ''), t.pinned ? 'Закреплён' : '', t.updatedAt ? new Date(t.updatedAt * 1000).toLocaleDateString() : ''].filter(Boolean).join(' · ');
    item.tooltip = `${chatTitle(t)}\n${t.cwd || 'Нет рабочей папки'}\n${t.id}${t.archived ? '\nАрхив' : ''}\n${t.sectionReason || ''}`;
    item.command = { command: `${PREFIX}.openChat`, title: 'Открыть переписку', arguments: [element] };
    return item;
  }
  dispose() { this._changed.dispose(); }
}

class Controller {
  constructor(context) {
    this.context = context; this.tree = new ProjectsTree(); this.backend = null;
    this.panels = new Map(); this.sessions = new Map(); this.threads = []; this.includeArchived = context.globalState.get('includeArchived', false);
    this.section = context.globalState.get('section', 'codex'); this.overrides = context.globalState.get('threadSections', {}); this.pins = context.globalState.get('pinnedThreads', {});
    this.chatOrder = context.globalState.get('chatOrder', {}); this.dragMimeTypes = [DRAG_MIME]; this.dropMimeTypes = [DRAG_MIME];
    this.projectCategories = context.globalState.get('projectCategories', {}); this.projectAccess = context.globalState.get('projectAccess', {});
    this.standaloneThreads = context.globalState.get('standaloneThreads',{});
    this.ownedActive = new Set(); this.reportedActive = new Set();
    this.runtimeStates = new Map(); this.rolloutStates = new Map(); this.localEnds = new Map(); this.activityReader = new RolloutActivity();
    this.online = new OnlineStore(); this.onlinePanels = new Map();
    this.onlineBridge = new OnlineBridge(snapshot => { this.online.ingest(snapshot); this.rebuildTree(); this.updateOnlineStatus(); }, {onPair:async credentials=>{
      if(!this.context.secrets)throw new Error('Secret storage unavailable');
      await this.context.secrets.store('onlineBrowserPairing',JSON.stringify(credentials)); this.updateOnlineStatus();
    },onScanStatus:status=>{this.online.scanStatus(status);this.rebuildTree();this.updateOnlineStatus();}});
    this.skillCache = new Map(); this.tree.skillsProvider = group => this.projectSkills(group);
    if (!LABELS[this.section]) this.section = 'codex';
    if (this.section !== 'codex') this.includeArchived = false;
    this.tree.section = this.section; this.tree.includeArchived = this.includeArchived;
    this.diagnostics = { status: 'Данные ещё не загружены.' }; this.disposed = false; this.lastLoad = 0;
    this.output = vscode.window.createOutputChannel('Codex Projects Explorer');
    this.view = vscode.window.createTreeView('codexProjects.tree', { treeDataProvider: this.tree, showCollapseAll: true, dragAndDropController: this });
    this.lastEditor = vscode.window.activeTextEditor;
    if (vscode.window.onDidChangeActiveTextEditor) context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => { if (editor) this.lastEditor = editor; }));
    context.subscriptions.push(this.tree, this.output, this.view, { dispose: () => this.dispose() });
    this.register();
    this.onlineInit = this.restoreOnline();
    this.activityTimer = setInterval(() => { this.refreshActivity(); if(this.onlineConnected !== this.onlineBridge.connected) { this.rebuildTree(); this.updateOnlineStatus(); } }, 2000); this.activityTimer.unref?.();
  }
  register() {
    const bind = (name, fn) => this.context.subscriptions.push(vscode.commands.registerCommand(`${PREFIX}.${name}`, async (...args) => {
      try { await fn(...args); } catch (e) { vscode.window.showErrorMessage(`Codex Projects: ${e.message}`); }
    }));
    bind('refresh', () => this.refresh());
    bind('newChatMenu',()=>this.newChatMenu());bind('newStandaloneChat',()=>this.newStandaloneChat());
    bind('connectOnline', () => this.connectOnline(true));
    bind('disconnectOnline', () => this.disconnectOnline());
    bind('openOnlineInBrowser', item => this.openOnlineInBrowser(item?.thread || item?.group || item));
    if(vscode.window.registerUriHandler)this.context.subscriptions.push(vscode.window.registerUriHandler({handleUri:uri=>{if(uri.path==='/online')this.connectOnline(false).catch(e=>vscode.window.showErrorMessage(e.message));}}));
    bind('toggleArchived', async () => {
      this.includeArchived = this.section !== 'codex' || !this.includeArchived; this.section = 'codex';
      await this.context.globalState.update('section', this.section);
      await this.context.globalState.update('includeArchived', this.includeArchived);
      await this.refresh();
    });
    bind('search', () => this.search()); bind('openChat', item => this.openChat(item?.thread || item));
    bind('resume', item => this.resume(item?.thread || item));
    bind('openInApp', item => this.openInApp(item?.thread || item));
    bind('openProject', item => this.openProject(item?.group || item));
    bind('switchSection', () => this.switchSection()); bind('assignSection', item => this.assignSection(item?.thread || item));
    bind('pinChat', item => this.pinChat(item?.thread || item, true)); bind('unpinChat', item => this.pinChat(item?.thread || item, false));
    bind('archiveChat', item => this.archiveChat(item?.thread || item, true)); bind('unarchiveChat', item => this.archiveChat(item?.thread || item, false));
    bind('deleteArchivedChat', item => this.deleteArchivedChat(item?.thread || item));
    bind('createProject', () => this.createProject()); bind('newChat', item => this.newChat(item?.group || item));
    bind('moveChatUp', item => this.moveChat(item?.thread || item, -1)); bind('moveChatDown', item => this.moveChat(item?.thread || item, 1));
    bind('openSkill', skill => this.openSkill(skill));
    bind('chatgptConnectionInfo', () => this.chatgptConnectionInfo()); bind('copySourceDiagnostics', () => this.copySourceDiagnostics());
    bind('createCategory', item => this.createCategory(item)); bind('renameCategory', item => this.renameCategory(item)); bind('deleteCategory', item => this.deleteCategory(item));
    bind('moveToCategory', item => this.moveToCategory(item?.thread || item)); bind('newChatInCategory', item => this.newChat(item?.group, item?.category?.id));
    bind('setProjectAccess', item => this.chooseProjectAccess(item?.group || item));
    bind('addProject', () => this.addProject()); bind('chooseHome', () => this.chooseHome());
    bind('nameProject', item => this.nameProject(item?.group || item));
    bind('diagnostics', () => this.showDiagnostics());
    this.context.subscriptions.push(vscode.window.onDidChangeWindowState(s => {
      if (s.focused && this.config().get('refreshOnFocus', true) && Date.now() - this.lastLoad > 30000) this.refresh();
    }));
    this.context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(PREFIX)) {
        if (!['codexHome','codexExecutable','dataSource','projectStateFile','showSubagents'].some(key => e.affectsConfiguration(`${PREFIX}.${key}`))) { this.rebuildTree(); return; }
        // Serialize reconfiguration after an in-flight read rather than killing it mid-read.
        this.reconfigure = true;
        this.refresh();
      }
    }));
  }
  config() { return vscode.workspace.getConfiguration(PREFIX); }
  async ensureBackend() {
    if (this.backend && !this.reconfigure) return;
    if (this.reconfigure && [...this.sessions.values()].some(s => s.running)) throw new Error('Остановите активный ответ перед изменением подключения к Codex.');
    this.backend?.dispose(); this.reconfigure = false;
    const c = this.config(); const official = vscode.extensions.getExtension('openai.chatgpt');
    let executable = ''; let executableError = '';
    try { executable = await findExecutable(c.get('codexExecutable', ''), official?.extensionPath); }
    catch (e) { executableError = e.message; }
    this.backend = new Backend({ home: codexHome(c.get('codexHome', '')), executable,
      dataSource: c.get('dataSource', 'auto'), stateFile: expand(c.get('projectStateFile', '')),
      showSubagents: c.get('showSubagents', false), cacheState: this.context.globalState });
    this.executableError = executableError;
  }
  async refresh() {
    if (this.disposed) return;
    if (this.refreshPromise) { this.refreshAgain = true; return this.refreshPromise; }
    this.skillCache.clear();
    this.refreshPromise = vscode.window.withProgress({ location: { viewId: 'codexProjects.tree' }, cancellable: true, title: 'Загрузка проектов Codex' }, async (progress, token) => {
      const abort = new AbortController(); const cancel = token.onCancellationRequested(() => abort.abort());
      this.tree.loading = true; this.tree.refresh();
      try {
        await this.ensureBackend();
        const result = await this.backend.load(this.includeArchived, { signal: abort.signal, onProgress: message => progress.report({ message }), onCached: cached => {
          if (abort.signal.aborted || this.disposed) return;
          this.threads = cached.threads.map(t=>({...t,standalone:!!this.standaloneThreads[threadKey(t)]}));
          for (const thread of this.threads) this.updateChatTitle(thread);
          this.projectSources = { desktop: cached.projects, folders: (vscode.workspace.workspaceFolders || []).filter(f=>f.uri.scheme==='file').map(f=>({name:f.name,path:f.uri.fsPath})) };
          this.rebuildTree();
        } });
        if (abort.signal.aborted || this.disposed) return;
        const folders = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file').map(f => ({ name: f.name, path: f.uri.fsPath }));
        this.threads = result.threads.map(t=>({...t,standalone:!!this.standaloneThreads[threadKey(t)]}));
        for (const thread of this.threads) this.updateChatTitle(thread);
        this.attachActivityRpc(this.backend?.rpc);
        this.runtimeStates = new Map(result.threads.map(t => [t.id, runtimeActivity(t.status)]).filter(([,s]) => s));
        this.reportedActive = new Set(result.threads.filter(t => t.status?.type === 'active').map(t => t.id));
        this.projectSources = { desktop: result.projects, folders }; this.rebuildTree();
        this.diagnostics = { ...result.diagnostics, projectGroups: this.tree.groups.map(g => ({ name: g.name, paths: g.paths, origin: g.origin, chatCount: g.threads.length })) };
        if (this.executableError) this.diagnostics.errors.push(this.executableError);
        const visibleGroups = this.tree.groups.filter(g => !secondaryGroup(g)).length;
        const canonicalProjects = new Set(result.threads.map(t => t.projectId).filter(Boolean)).size;
        this.diagnostics.canonicalProjects = canonicalProjects;
        this.updateViewMessage();
        this.lastLoad = Date.now();
        await this.refreshActivity();
        this.output.appendLine(`${new Date().toISOString()} — чатов: ${this.threads.length}; проектов/папок: ${this.tree.groups.length}; App Server: ${result.diagnostics.apiSucceeded ? 'да' : 'нет'}; замечаний: ${this.diagnostics.errors.length}`);
      } catch (e) {
        if (!abort.signal.aborted && !this.disposed) {
          this.diagnostics = { ...this.diagnostics, lastError: e.message };
          this.view.message = 'Ошибка загрузки — ⋯ → Показать диагностику';
          vscode.window.showErrorMessage(`Не удалось загрузить чаты Codex: ${e.message}`);
        }
      } finally { cancel.dispose(); this.tree.loading = false; if (!this.disposed) this.tree.refresh(); }
    });
    try { await this.refreshPromise; }
    finally {
      this.refreshPromise = null;
      if (this.refreshAgain && !this.disposed) { this.refreshAgain = false; await this.refresh(); }
    }
  }
  async search() {
    if (!this.lastLoad) await this.refresh();
    const groups = new Map(this.tree.groups.flatMap(g => g.threads.map(t => [t.id, g.name])));
    const items = this.visibleThreads().map(thread => ({ label: chatTitle(thread), description: groups.get(thread.id), detail: `${thread.cwd || ''}${thread.archived ? ' · Архив' : ''}`, thread }));
    if (this.section === 'chatgpt') for (const g of this.online.groups()) for (const thread of g.threads) items.push({label: thread.name, description: `Онлайн · ${g.name}`, thread});
    const item = await vscode.window.showQuickPick(items, { placeHolder: `Поиск по ${items.length} чатам раздела ${LABELS[this.section]}`, matchOnDescription: true, matchOnDetail: true });
    if (item) await this.openChat(item.thread);
  }
  updateChatTitle(thread) {
    const session = this.sessions.get(thread.id), panel = this.panels.get(thread.id);
    const stored = this.threads.find(t => t.id === thread.id);
    const metadata = { name: thread.name || '', preview: thread.preview || session?.thread.preview || stored?.preview || '' };
    if (stored) Object.assign(stored, metadata);
    if (!session || !panel) return;
    Object.assign(session.thread, metadata);
    const title = chatTitle(session.thread);
    if (panel.title !== title) { panel.title = title; panel.webview.postMessage({ type: 'title', title }); }
  }
  async openChat(thread) {
    if (thread?.provider === 'chatgpt-browser') return this.openOnlineChat(thread);
    if (!thread || !validId(thread.id)) throw new Error('Выберите чат в дереве проектов.');
    let panel = this.panels.get(thread.id);
    if (panel) { this.updateChatTitle(thread); panel.reveal(); return; }
    await this.ensureBackend();
    panel = this.panels.get(thread.id);
    if (panel) { this.updateChatTitle(thread); panel.reveal(); return; }
    createChatPanel(vscode, this, thread);
  }
  async resume(thread) {
    if (thread?.provider === 'chatgpt-browser') throw new Error('Онлайн-чат ChatGPT продолжается в браузере, а не через Codex CLI.');
    if (!thread || !validId(thread.id)) throw new Error('Выберите чат.');
    if (thread.archived) {
      await vscode.window.showInformationMessage('Это архивный чат. Восстановите его в приложении Codex, затем обновите список.'); return;
    }
    await this.ensureBackend();
    const binary = this.backend.options.executable;
    if (!binary) throw new Error('Для продолжения нужен codex.exe. Укажите codexProjects.codexExecutable в настройках.');
    let cwd = thread.cwd || undefined;
    if (cwd) {
      try { if (!(await fsp.stat(cwd)).isDirectory()) cwd = undefined; } catch { cwd = undefined; }
      if (!cwd) throw new Error('Рабочая папка этого чата недоступна на этом компьютере. Откройте его в приложении Codex.');
    }
    const launch = resumeLaunch({ platform: process.platform, executable: binary, id: thread.id,
      home: thread.home || this.backend.options.home, cwd, name: chatTitle(thread),
      windowsDirectory: process.env.SystemRoot || process.env.WINDIR });
    this.diagnostics.lastLaunch = { threadId: thread.id, executable: binary, shellPath: launch.shellPath, cwd: cwd || null,
      codexHome: launch.env.CODEX_HOME, timestamp: new Date().toISOString() };
    const terminal = vscode.window.createTerminal(launch);
    terminal.show();
  }
  async openInApp(thread, draft) {
    if (thread?.provider === 'chatgpt-browser') return this.openOnlineInBrowser(thread);
    if (!validId(thread?.id)) throw new Error('Выберите чат.');
    const target = `codex://threads/${encodeURIComponent(thread.id)}`;
    if (draft !== undefined && (typeof draft !== 'string' || draft.length > 4000000)) throw new Error('Черновик слишком большой для передачи.');
    const withDraft = draft ? `${target}?prompt=${encodeURIComponent(draft)}` : target;
    // Windows protocol handlers have short URI limits; clipboard keeps long drafts complete.
    const clipboard = withDraft.length > 1800;
    if (clipboard) await vscode.env.clipboard.writeText(draft);
    const ok = await vscode.env.openExternal(vscode.Uri.parse(clipboard ? target : withDraft));
    if (!ok) throw new Error('Windows не открыл ссылку Codex. Проверьте установку приложения.');
    if (clipboard) vscode.window.showInformationMessage('Полный черновик скопирован. Вставьте его в открытый чат Codex через Ctrl+V и отправьте.');
    else if (draft) vscode.window.showInformationMessage('Открыт исходный чат Codex с черновиком. Проверьте его и отправьте в приложении.');
  }
  async openProject(group) {
    if (!group?.paths?.length) throw new Error('У проекта нет доступной рабочей папки.');
    this.files ||= new ProjectFiles(vscode);
    await this.files.show(group);
  }
  visibleThreads() { return this.threads.filter(t => classifyThread(t, this.overrides).section === this.section && !!t.archived === !!this.includeArchived); }
  rebuildTree() {
    this.tree.section = this.section;
    this.tree.includeArchived = this.includeArchived;
    this.onlineConnected = this.onlineBridge.connected;
    this.tree.onlineGroups = this.online.groups();
    this.tree.onlineStatusDetail=this.online.scan.note;
    this.tree.onlineStatus = this.online.lastSync ? `${this.onlineBridge.connected ? 'Браузер подключён' : 'Снимок браузера'} · проектов: ${this.online.projects.size} · чатов: ${this.online.chats.size}${this.online.scan.state==='loading'?' · загрузка проектов…':this.online.scan.state==='failed'?' · сбор остановлен':''} · часть истории` : this.onlineBridge.connected ? 'Браузер подключён · ожидаю данные страниц' : 'Подключить онлайн ChatGPT…';
    const selected = this.visibleThreads().map(t => { const activity = this.chatActivity(t.id); return { ...t, pinned: !!this.pins[threadKey(t)], running: activity.running, activityLabel: activity.label, sectionReason: classifyThread(t, this.overrides).reason }; });
    const projects = this.config().get('projects', []).filter(p => (p.section || 'codex') === this.section);
    const desktop = (this.projectSources?.desktop || []).filter(p => !p.metadata?.['codexProjects.section'] || p.metadata['codexProjects.section'] === this.section);
    this.tree.groups = groupThreads(selected, desktop, projects, this.projectSources?.folders || []);
    if (this.includeArchived) this.tree.groups = this.tree.groups.filter(g => g.threads.length);
    if (this.section !== 'codex') this.tree.groups = this.tree.groups.filter(g => g.threads.length || g.metadata?.['codexProjects.section'] === this.section || projects.some(p => p.paths.some(r => g.paths.includes(r))));
    let changed = false;
    const apply = (bucket, threads) => {
      const key = this.orderKey(bucket), order = reconcileOrder(this.chatOrder[key], threads);
      if (JSON.stringify(order) !== JSON.stringify(this.chatOrder[key] || [])) { this.chatOrder = { ...this.chatOrder, [key]: order }; changed = true; }
      return orderedThreads(order, threads);
    };
    for (const g of this.tree.groups.filter(g => !secondaryGroup(g))) {
      g.threads = apply(g.id, g.threads);
      const pinsId = `${g.id}:pins`, pinsKey = this.orderKey(pinsId);
      if (!this.chatOrder[pinsKey]) { this.chatOrder = { ...this.chatOrder, [pinsKey]: g.threads.filter(t => t.pinned).map(threadKey) }; changed = true; }
      g.pinnedThreads = apply(pinsId, g.threads.filter(t => t.pinned));
      const split = categories.splitCategories(this.categorySettings(g), g.threads);
      g.directThreads = split.direct;
      g.categories = split.categories.map(c => ({ ...c, threads: apply(`${g.id}:category:${c.id}`, c.threads) }));
    }
    this.tree.looseThreads = apply('loose', this.tree.groups.filter(secondaryGroup).flatMap(g => g.threads));
    if (changed) this.saveOrder();
    this.tree.refresh(); this.updateViewMessage();
  }
  updateViewMessage() {
    const unknown = this.threads.filter(t => classifyThread(t, this.overrides).section === 'unknown').length;
    const count = this.visibleThreads().length;
    this.view.message = this.section === 'chatgpt'
      ? `${this.online.lastSync ? `Онлайн: проектов ${this.online.projects.size}, чатов ${this.online.chats.size} · ${this.online.scan.state==='loading'?'загрузка…':'часть истории'}` : 'Онлайн-история не загружена'}${count ? ` · локальных записей: ${count}` : ''}`
      : `${this.includeArchived ? 'Архив Codex' : LABELS[this.section]} · ${count} ${this.includeArchived ? 'архивных' : 'локальных'} чатов${unknown && this.section !== 'unknown' ? ` · источник не определён: ${unknown}` : ''}`;
  }
  async switchSection() {
    const items = ['codex','chatgpt','unknown'].map(section => ({ label: `${this.section === section ? '✓ ' : ''}${LABELS[section]}`, description: section === 'chatgpt' ? this.online.lastSync ? `Из браузера: ${this.online.chats.size} · часть истории` : 'Доступно подключение через браузер' : `${this.threads.filter(t => classifyThread(t, this.overrides).section === section).length} локальных чатов`, detail: section === 'unknown' ? 'Старые записи без признака приложения. Правой кнопкой можно выбрать раздел.' : section === 'chatgpt' ? 'Онлайн-снимки браузера и распознанные локальные записи показаны отдельно. Полнота аккаунта не подтверждена.' : 'Проекты и чаты из выбранного локального хранилища Codex', section }));
    if (this.includeArchived) for (const item of items) item.label = item.label.replace(/^✓ /, '');
    items.splice(1, 0, { label: `${this.includeArchived ? '✓ ' : ''}Архив Codex`, section: 'codex', archived: true, detail: 'Архивные чаты по проектам: просмотр, восстановление и удаление навсегда.' });
    const chosen = await vscode.window.showQuickPick(items, { placeHolder: 'Codex / ChatGPT — выбрать раздел' });
    if (!chosen) return;
    const reload = this.includeArchived !== !!chosen.archived;
    this.section = chosen.section; this.includeArchived = !!chosen.archived;
    await this.context.globalState.update('section', this.section); await this.context.globalState.update('includeArchived', this.includeArchived);
    if (reload) await this.refresh(); else this.rebuildTree();
  }
  async assignSection(thread) {
    if (!validId(thread?.id)) throw new Error('Выберите чат.');
    const chosen = await vscode.window.showQuickPick([{label:'Codex',value:'codex'},{label:'ChatGPT',value:'chatgpt'},{label:'Источник не определён',value:'unknown'},{label:'Определять автоматически',value:null}], { placeHolder: 'В каком разделе показывать этот локальный чат?' });
    if (!chosen) return; const next = { ...this.overrides }; if (chosen.value) next[threadKey(thread)] = chosen.value; else delete next[threadKey(thread)];
    await this.context.globalState.update('threadSections', next); this.overrides = next; this.rebuildTree();
  }
  async pinChat(thread, pinned) {
    if (!validId(thread?.id)) throw new Error('Выберите чат.');
    const next = { ...this.pins }; if (pinned) next[threadKey(thread)] = true; else delete next[threadKey(thread)];
    await this.context.globalState.update('pinnedThreads', next); this.pins = next;
    const bucket = this.bucketFor(thread); if (pinned && bucket) { const key = this.orderKey(bucket.id); this.chatOrder = { ...this.chatOrder, [key]: moveBefore(this.chatOrder[key] || [], threadKey(thread)) }; await this.saveOrder(); }
    this.rebuildTree();
  }
  async archiveChat(thread, archived) {
    if (thread?.provider === 'chatgpt-browser') throw new Error('Архивируйте онлайн-чат в ChatGPT. Изменение аккаунта из VS Code пока не подключено.');
    if (!validId(thread?.id)) throw new Error('Выберите чат.');
    if (this.sessions.get(thread.id)?.running) throw new Error('Сначала остановите ответ в этом чате.');
    await this.ensureBackend(); const rpc = await this.backend.connect();
    await rpc.request(archived ? 'thread/archive' : 'thread/unarchive', { threadId: thread.id });
    this.panels.get(thread.id)?.dispose(); await this.refresh();
  }
  async deleteArchivedChat(thread) {
    if (!validId(thread?.id) || !thread.archived || thread.provider === 'chatgpt-browser') throw new Error('Выберите архивный чат Codex.');
    if (this.sessions.get(thread.id)?.running || this.chatActivity(thread.id).running) throw new Error('Нельзя удалить работающий чат.');
    const choice = await vscode.window.showWarningMessage(`Удалить навсегда чат «${chatTitle(thread)}»?`, { modal: true,
      detail: 'История и связанные дочерние чаты будут удалены без возможности восстановления. Файлы проекта сохранятся.' }, 'Удалить навсегда');
    if (choice !== 'Удалить навсегда') return;
    if (this.sessions.get(thread.id)?.running || this.chatActivity(thread.id).running) throw new Error('Нельзя удалить работающий чат.');
    await this.ensureBackend(); while (this.refreshPromise) await this.refreshPromise;
    await this.sessions.get(thread.id)?.release();
    const result = await this.backend.deleteArchivedThread(thread);
    this.panels.get(thread.id)?.dispose(); this.threads = this.threads.filter(t => t.id !== thread.id);
    const clipboard = path.resolve(this.context.globalStorageUri.fsPath, 'clipboard'), directory = path.resolve(clipboard, thread.id);
    if (path.dirname(directory) !== clipboard) throw new Error('Неверный путь хранилища вложений.');
    try { await fsp.rm(directory, { recursive: true, force: true }); }
    catch { await vscode.window.showWarningMessage('Чат удалён, но копии вставленных вложений удалить не удалось.'); }
    if (result?.warning) await vscode.window.showWarningMessage(result.warning);
    await this.refresh();
  }
  async createProject() {
    if (this.section === 'chatgpt') throw new Error('Создание проектов в аккаунте ChatGPT не подключено. Для создания проекта Codex выберите раздел Codex.');
    const name = await vscode.window.showInputBox({ title: 'Создать проект', prompt: 'Название проекта и новой папки', validateInput: value => !value.trim() || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) || ['.','..'].includes(value) ? 'Введите допустимое имя новой папки.' : undefined });
    if (!name) return;
    const parents = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Создать проект здесь', title: `Где создать проект «${name}»?` });
    if (!parents?.[0]) return;
    await this.ensureBackend(); const rpc = await this.backend.connect();
    try { await rpc.request('project/list', { limit: 1 }); }
    catch (e) { if ([-32601,-32602].includes(e.code)) throw new Error('Эта версия Codex не поддерживает создание проектов. Обновите официальное расширение Codex.'); throw e; }
    const root = path.join(parents[0].fsPath, name.trim());
    try { await fsp.mkdir(root); } catch (e) { if (e.code === 'EEXIST') throw new Error('Такая папка уже существует. Выберите другое имя или добавьте существующую папку.'); throw e; }
    const section = this.section === 'chatgpt' ? 'chatgpt' : 'codex', idempotencyKey = crypto.randomUUID(); let result;
    try { result = await rpc.request('project/create', { idempotencyKey, name: name.trim(), roots: [{ path: root }], metadata: { 'codexProjects.section': section } }); }
    catch (e) {
      if (Number.isFinite(e.code)) await fsp.rmdir(root).catch(() => {});
      else { await this.context.globalState.update('pendingProject', { name: name.trim(), root, idempotencyKey }); throw new Error('Codex не подтвердил создание проекта. Папка сохранена; обновите список проектов перед повтором.'); }
      throw e;
    }
    if (!result.project?.id) throw new Error('Codex не вернул запись проекта. Папка сохранена; обновите список.');
    const project = { ...result.project, projectId: result.project.id, paths: result.project.roots.map(r => r.path), origin: 'canonical' };
    this.projectSources ||= { desktop: [], folders: [] }; this.projectSources.desktop = [...this.projectSources.desktop, project];
    this.section = section; await this.context.globalState.update('section', this.section); this.rebuildTree(); await this.openProject(project);
    vscode.window.showInformationMessage(`Проект «${project.name}» создан. В меню проекта выберите «Новый чат в проекте».`);
  }
  async newChat(group, categoryId = null) {
    if (this.section === 'chatgpt') throw new Error('Создание чатов в аккаунте ChatGPT не подключено. Для нового чата Codex выберите раздел Codex.');
    if (!group?.paths?.length) throw new Error('Выберите проект с рабочей папкой.');
    if (categoryId && !this.categorySettings(group).items.some(c => c.id === categoryId)) throw new Error('Категория больше не существует.');
    const cwd = group.paths.length === 1 ? group.paths[0] : await vscode.window.showQuickPick(group.paths, { placeHolder: 'Рабочая папка нового чата' });
    if (!cwd) return; if (!(await fsp.stat(cwd)).isDirectory()) throw new Error('Папка проекта недоступна.');
    await this.ensureBackend(); const rpc = await this.backend.connect();
    const result = await rpc.request('thread/start', { cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write', ...(group.projectId ? { projectId: group.projectId } : {}) });
    if (!validId(result.thread?.id)) throw new Error('Codex не вернул идентификатор нового чата.');
    const thread = { ...result.thread, cwd, home: this.backend.options.home };
    const section = this.section === 'chatgpt' ? 'chatgpt' : 'codex'; this.overrides = { ...this.overrides, [threadKey(thread)]: section };
    await this.context.globalState.update('threadSections', this.overrides);
    this.threads.push(thread);
    if (categoryId && this.categorySettings(group).items.some(c => c.id === categoryId)) await this.setThreadCategory(thread, group, categoryId);
    this.rebuildTree(); await this.openChat(thread);
  }
  async newChatMenu(){
    if(this.section==='chatgpt'){await vscode.env.openExternal(vscode.Uri.parse('https://chatgpt.com/'));return;}
    const groups=this.tree.groups.filter(g=>!secondaryGroup(g) && g.paths.length);
    const chosen=await vscode.window.showQuickPick([{label:'$(comment-add) Новый чат вне проекта',standalone:true,detail:'Без привязки к проекту'},...groups.map(group=>({label:'$(folder) '+group.name,detail:'Новый чат в этом проекте',group}))],{title:'Новый чат',placeHolder:'Вне проекта или выбрать проект'});
    if(!chosen)return;if(chosen.standalone)await this.newStandaloneChat();else await this.newChat(chosen.group);
  }
  async newStandaloneChat(){
    if(this.section==='chatgpt'){await vscode.env.openExternal(vscode.Uri.parse('https://chatgpt.com/'));return;}
    await this.ensureBackend();const cwd=path.join(this.backend.options.home,'projects-explorer','standalone');await fsp.mkdir(cwd,{recursive:true});
    const rpc=await this.backend.connect(),result=await rpc.request('thread/start',{cwd,projectId:null,approvalPolicy:'on-request',sandbox:'workspace-write'});
    if(!validId(result.thread?.id))throw new Error('Codex не вернул идентификатор чата');
    const thread={...result.thread,projectId:null,cwd,home:this.backend.options.home,standalone:true};
    this.standaloneThreads={...this.standaloneThreads,[threadKey(thread)]:true};await this.context.globalState.update('standaloneThreads',this.standaloneThreads);
    this.overrides={...this.overrides,[threadKey(thread)]:'codex'};await this.context.globalState.update('threadSections',this.overrides);
    this.section='codex';await this.context.globalState.update('section',this.section);this.threads.push(thread);this.rebuildTree();await this.openChat(thread);
  }
  orderKey(bucket, archived = this.includeArchived) { return `${this.backend?.options?.home || this.config().get('codexHome', '')}:${this.section}:${archived ? 'archive:' : ''}${bucket}`; }
  async projectSkills(group) {
    if (!group.paths.length) return [{ kind: 'skillNote', label: 'У проекта пока нет рабочей папки' }];
    await this.ensureBackend();
    const key = `${this.backend.options.home}:${group.id}`, cached = this.skillCache.get(key);
    if (cached && Date.now() - cached.time < 30000) return cached.promise;
    const promise = (async () => {
      try {
        const rpc = await this.backend.connect(), result = await rpc.request('skills/list', { cwds: group.paths, forceReload: true }, 15000);
        const unique = new Map(); let errors = 0;
        for (const entry of result.data || []) { for (const skill of entry.skills || []) unique.set(skill.path, skill); errors += entry.errors?.length || 0; }
        const all = [...unique.values()], local = all.filter(s => s.scope === 'repo' || s.scope === 'project'), shared = all.filter(s => !local.includes(s)), elements = [];
        if (local.length) elements.push({ kind: 'skillScope', id: `skills:${group.id}:repo`, label: 'В проекте', skills: local });
        else elements.push({ kind: 'skillNote', label: 'Проектные скиллы не найдены' });
        if (shared.length) elements.push({ kind: 'skillScope', id: `skills:${group.id}:shared`, label: 'Общие доступные', skills: shared });
        if (errors) elements.push({ kind: 'skillNote', label: `Не удалось прочитать скиллы: ${errors}` });
        return elements;
      } catch (e) { return [{ kind: 'skillNote', label: 'Не удалось получить скиллы Codex: ' + e.message }]; }
    })();
    this.skillCache.set(key, { time: Date.now(), promise }); return promise;
  }
  async openSkill(skill) {
    if (!skill || typeof skill.path !== 'string' || !path.isAbsolute(skill.path)) throw new Error('Этот скилл доступен через Codex, локального файла инструкций нет.');
    if (!(await fsp.stat(skill.path)).isFile()) throw new Error('Файл инструкций скилла недоступен.');
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(skill.path), { viewColumn: this.files?.editorColumn || vscode.ViewColumn.One, preview: true });
  }
  setChatRunning(id, running) {
    if (this.disposed) return;
    if (running) { this.ownedActive.add(id); this.localEnds.delete(id); }
    else if (this.ownedActive.delete(id)) { this.reportedActive.delete(id); this.runtimeStates.delete(id); this.localEnds.set(id, Date.now()); }
    this.rebuildTree();
  }
  async releaseSessionActivity(id) {
    this.ownedActive.delete(id); await this.refreshActivity();
    if (!this.disposed) this.rebuildTree();
  }
  async refreshActivity() {
    const backend = this.backend, rpc = backend?.rpc;
    if (this.disposed || this.activityPolling) return;
    this.activityPolling = true; let reading = true;
    try {
      this.attachActivityRpc(rpc);
      // Journal observation also works in localFiles mode and when RPC is down.
      const states = new Map(), candidates = this.threads.filter(t => t.file && !t.archived); let index = 0;
      await Promise.all(Array.from({length:Math.min(6,candidates.length)},async()=>{while(index<candidates.length){const t=candidates[index++];states.set(t.id,await this.activityReader.read(t.file));}}));
      if (this.disposed || backend !== this.backend) return;
      this.rolloutStates = states; this.activityReader.prune(candidates.map(t=>t.file));
      // Refresh journal indicators before waiting for a slow server request.
      this.rebuildTree();
      this.activityPolling = false;
      reading = false;
      if (!rpc || rpc.closed) { this.activityError = null; return; }
      if (this.runtimePolling || Date.now() - (this.lastActivityRpc || 0) < 6000) return;
      this.runtimePolling = true; this.lastActivityRpc = Date.now();
      const revision = this.activityRevision || 0;
      let threads;
      try { threads = await collectPages(rpc, 'thread/list', { limit: 100, sourceKinds: SOURCES, modelProviders: [], archived: false, useStateDbOnly: true }); }
      finally { this.runtimePolling = false; }
      if (this.disposed || backend !== this.backend) return;
      // Notifications received during the request are newer than its snapshot.
      if (revision !== (this.activityRevision || 0)) return;
      for (const row of threads) {
        const thread = this.threads.find(t => t.id === row.id);
        if (thread) this.updateChatTitle({ ...thread, name: row.name || thread.name, preview: row.preview });
      }
      this.runtimeStates = new Map(threads.map(t=>[t.id,runtimeActivity(t.status)]).filter(([,s])=>s));
      const active = new Set(threads.filter(t => t.status?.type === 'active').map(t => t.id));
      this.reportedActive = active; this.rebuildTree();
      this.activityError = null;
    } catch (e) { this.activityError = e.message; }
    finally { if(reading)this.activityPolling = false; }
  }
  chatActivity(id) {
    if (this.ownedActive.has(id)) return this.runtimeStates.get(id)?.running ? this.runtimeStates.get(id) : {running:true,label:'Работает…'};
    const log = this.rolloutStates.get(id), runtime = this.runtimeStates.get(id);
    if (runtime?.running) return runtime;
    if (log && log.eventAt > (this.localEnds.get(id) || 0)) return log;
    return runtime || {running:false,label:''};
  }
  attachActivityRpc(rpc) {
    if (this.activityRpc === rpc) return;
    this.activityRpc?.removeListener?.('notification',this.activityNotify); this.activityRpc?.removeListener?.('closed',this.activityClosed);
    this.activityRpc = rpc;
    this.activityNotify = ({method,params:p}) => {
      if (this.disposed || !p?.threadId) return;
      if (method === 'thread/name/updated') {
        const thread = this.threads.find(t => t.id === p.threadId) || this.sessions.get(p.threadId)?.thread;
        if (thread && (typeof p.threadName === 'string' || p.threadName === null)) {
          this.activityRevision = (this.activityRevision || 0) + 1;
          thread.name = p.threadName || ''; this.updateChatTitle(thread); this.rebuildTree();
        }
        return;
      }
      let state;
      if (method === 'thread/status/changed') state = runtimeActivity(p.status);
      else if (method === 'turn/started') { state = runtimeActivity({type:'active'}); this.localEnds.delete(p.threadId); }
      else if (method === 'turn/completed') { state = runtimeActivity({type:p.turn?.status === 'failed' ? 'systemError' : 'idle'}); this.localEnds.set(p.threadId,Date.now()); }
      else return;
      this.activityRevision = (this.activityRevision || 0) + 1;
      if (state) this.runtimeStates.set(p.threadId,state); else this.runtimeStates.delete(p.threadId);
      if (state?.running) this.reportedActive.add(p.threadId); else this.reportedActive.delete(p.threadId);
      this.rebuildTree();
    };
    this.activityClosed = () => { this.runtimeStates.clear(); this.reportedActive.clear(); this.rebuildTree(); };
    rpc?.on?.('notification',this.activityNotify); rpc?.on?.('closed',this.activityClosed);
  }
  saveOrder() {
    const snapshot = this.chatOrder;
    this.orderWrite = (this.orderWrite || Promise.resolve()).then(() => this.context.globalState.update('chatOrder', snapshot)).catch(e => vscode.window.showErrorMessage(`Не удалось сохранить порядок чатов: ${e.message}`));
    return this.orderWrite;
  }
  bucketFor(thread) {
    const group = this.tree.groups.find(g => g.threads.some(t => threadKey(t) === threadKey(thread)));
    if (!group) return null;
    if (secondaryGroup(group)) return { id: 'loose', projectId: 'loose', threads: this.tree.looseThreads };
    if (this.pins[threadKey(thread)]) return { id: `${group.id}:pins`, projectId: group.id, group, pinned: true, threads: group.pinnedThreads || group.threads.filter(t => t.pinned) };
    const category = group.categories?.find(c => c.threads.some(t => threadKey(t) === threadKey(thread)));
    return category ? { id: `${group.id}:category:${category.id}`, projectId: group.id, group, categoryId: category.id, threads: category.threads.filter(t => !t.pinned) }
      : { id: group.id, projectId: group.id, group, categoryId: null, threads: (group.directThreads || group.threads).filter(t => !t.pinned) };
  }
  async moveChat(thread, direction) {
    if (!validId(thread?.id)) throw new Error('Выберите чат.');
    const bucket = this.bucketFor(thread); if (!bucket) return;
    const index = bucket.threads.findIndex(t => threadKey(t) === threadKey(thread)), next = index + direction;
    if (next < 0 || next >= bucket.threads.length) return;
    const key = this.orderKey(bucket.id), order = [...(this.chatOrder[key] || [])], a = order.indexOf(threadKey(thread)), b = order.indexOf(threadKey(bucket.threads[next]));
    if (a < 0 || b < 0) return; [order[a],order[b]] = [order[b],order[a]];
    this.chatOrder = { ...this.chatOrder, [key]: order }; await this.saveOrder(); this.rebuildTree();
  }
  handleDrag(source, transfer) {
    const thread = source.find(item => item.kind === 'chat')?.thread, bucket = thread && this.bucketFor(thread);
    if (bucket) transfer.set(DRAG_MIME, new vscode.DataTransferItem(JSON.stringify({ section: this.section, project: bucket.projectId, bucket: bucket.id, key: threadKey(thread) })));
  }
  async handleDrop(target, transfer) {
    try {
      const item = transfer.get(DRAG_MIME); if (!item) return;
      const data = JSON.parse(await item.asString()), bucket = target?.kind === 'chat' ? this.bucketFor(target.thread)
        : target?.kind === 'category' ? { id: `${target.group.id}:category:${target.category.id}`, projectId: target.group.id, group: target.group, categoryId: target.category.id, threads: target.category.threads }
        : target?.kind === 'project' ? { id: target.group.id, projectId: target.group.id, group: target.group, categoryId: null, threads: target.group.directThreads || target.group.threads }
        : target?.kind === 'unassigned' ? { id: 'loose', projectId: 'loose', threads: this.tree.looseThreads } : null;
      const thread = this.threads.find(t => threadKey(t) === data.key), source = thread && this.bucketFor(thread);
      if (!bucket || !source || data.section !== this.section || data.project !== bucket.projectId || source.projectId !== bucket.projectId || source.id !== data.bucket) throw new Error('Перетаскивайте чаты между категориями внутри одного проекта.');
      if (source.id !== bucket.id) {
        if (bucket.pinned) await this.pinChat(thread, true);
        else await this.setThreadCategory(thread, bucket.group, bucket.categoryId);
      }
      const key = this.orderKey(bucket.id), targetKey = target.kind === 'chat' ? threadKey(target.thread) : null;
      if (targetKey === data.key) return;
      this.chatOrder = { ...this.chatOrder, [key]: moveBefore(this.chatOrder[key] || [], data.key, targetKey) }; await this.saveOrder(); this.rebuildTree();
    } catch (e) { vscode.window.showErrorMessage(e.message); }
  }
  categorySettings(group) { return categories.settingsFor(this.projectCategories, this.orderKey(group.id, false)); }
  async saveCategories(group, update) {
    const key = this.orderKey(group.id, false);
    this.categoryWrite = (this.categoryWrite || Promise.resolve()).catch(() => {}).then(async () => {
      const settings = update(categories.settingsFor(this.projectCategories, key)), next = { ...this.projectCategories, [key]: settings };
      await this.context.globalState.update('projectCategories', next); this.projectCategories = next; this.rebuildTree();
    }); return this.categoryWrite;
  }
  categoryProject(item) { return item?.group || (item?.threads ? item : item?.thread ? this.bucketFor(item.thread)?.group : null); }
  async createCategory(item) {
    let group = this.categoryProject(item);
    if (!group) { const chosen = await vscode.window.showQuickPick(this.tree.groups.filter(g => !secondaryGroup(g)).map(g => ({ label: g.name, group: g })), { placeHolder: 'Проект для новой категории' }); group = chosen?.group; }
    if (!group) return null;
    const name = await vscode.window.showInputBox({ title: `Новая категория · ${group.name}`, prompt: 'Название категории внутри проекта' }); if (name === undefined) return null;
    let result; await this.saveCategories(group, settings => { result = categories.addCategory(settings, name); return result.settings; }); return result.category;
  }
  async renameCategory(item) {
    if (!item?.group || !item?.category) throw new Error('Выберите категорию внутри проекта.');
    const name = await vscode.window.showInputBox({ title: 'Переименовать категорию', value: item.category.name }); if (name === undefined) return;
    await this.saveCategories(item.group, settings => categories.renameCategory(settings, item.category.id, name));
  }
  async deleteCategory(item) {
    if (!item?.group || !item?.category) throw new Error('Выберите категорию внутри проекта.');
    await this.saveCategories(item.group, settings => categories.removeCategory(settings, item.category.id));
    vscode.window.showInformationMessage('Категория удалена. Все чаты остались в проекте.');
  }
  async setThreadCategory(thread, group, categoryId) {
    if (!group) throw new Error('Выберите чат внутри проекта.');
    await this.saveCategories(group, settings => categories.assignCategory(settings, thread, categoryId));
    const bucket = this.bucketFor(thread); if (bucket) { const key = this.orderKey(bucket.id); this.chatOrder = { ...this.chatOrder, [key]: moveBefore(this.chatOrder[key] || [], threadKey(thread)) }; await this.saveOrder(); this.rebuildTree(); }
  }
  async moveToCategory(thread) {
    const group = this.bucketFor(thread)?.group; if (!group) throw new Error('Категории создаются внутри проекта.');
    const chosen = await vscode.window.showQuickPick([{ label: 'Без категории', id: null }, ...this.categorySettings(group).items.map(c => ({ label: c.name, id: c.id })), { label: '+ Новая категория…', create: true }], { placeHolder: `Категория чата · ${group.name}` });
    if (!chosen) return; const category = chosen.create ? await this.createCategory({ group }) : chosen;
    if (category) await this.setThreadCategory(thread, group, category.id);
  }
  projectScope(thread) {
    const group = groupThreads([thread], this.projectSources?.desktop || [], this.config().get('projects', []), this.projectSources?.folders || []).find(g => g.threads.length);
    return { key: projectAccessKey(thread, group, this.backend?.options?.home || ''), name: group?.name || baseName(thread.cwd || '') || 'Текущий проект' };
  }
  getProjectAccess(thread) { const access = this.projectAccess[this.projectScope(thread).key]; return ['project','read','full'].includes(access) ? access : 'project'; }
  async setProjectAccess(thread, access) {
    validateAccess(access); const scope = this.projectScope(thread);
    this.accessWrite = (this.accessWrite || Promise.resolve()).catch(() => {}).then(async () => {
      const next = { ...this.projectAccess, [scope.key]: access };
      await this.context.globalState.update('projectAccess', next); this.projectAccess = next;
      for (const [id, panel] of this.panels) {
        const target = this.sessions.get(id)?.thread || this.threads.find(t => t.id === id);
        if (target && this.projectScope(target).key === scope.key) panel.webview.postMessage({ type: 'projectAccess', access, projectName: scope.name });
      }
    }); return this.accessWrite;
  }
  async waitForProjectAccess() { await this.accessWrite?.catch(() => {}); }
  async chooseProjectAccess(group) {
    if (!group?.paths?.length && !group?.projectId) throw new Error('Выберите проект.');
    const chosen = await vscode.window.showQuickPick([{ label: 'В пределах проекта', access: 'project' }, { label: 'Только чтение', access: 'read' }, { label: 'Полный доступ', access: 'full' }], { placeHolder: `Доступ всех чатов · ${group.name}. Применяется к следующему сообщению.` });
    if (chosen) { await this.ensureBackend(); await this.setProjectAccess({ id: '', projectId: group.projectId, cwd: group.paths[0] || '', home: this.backend?.options?.home }, chosen.access); }
  }
  async addProject() {
    const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: true, openLabel: 'Папки проекта' });
    if (!folders?.length) return;
    const name = await vscode.window.showInputBox({ title: 'Название проекта', prompt: 'Если название уже есть, выбранные папки будут добавлены к нему.', value: baseName(folders[0].fsPath), validateInput: v => v.trim() ? undefined : 'Введите название.' });
    if (!name) return;
    const projects = [...this.config().get('projects', [])];
    const same = projects.find(p => p.name === name.trim());
    if (same) same.paths = [...new Set([...same.paths, ...folders.map(f => f.fsPath)])];
    else projects.push({ name: name.trim(), paths: folders.map(f => f.fsPath) });
    await this.config().update('projects', projects, vscode.ConfigurationTarget.Global);
  }
  async nameProject(group) {
    if (!group?.paths?.length) throw new Error('У этой группы нет рабочей папки.');
    const name = await vscode.window.showInputBox({ title: 'Название проекта', value: group.name,
      prompt: 'Папка появится в основном списке. Настройки приложения Codex не изменятся.',
      validateInput: value => value.trim() ? undefined : 'Введите название.' });
    if (!name) return;
    const projects = this.config().get('projects', []).map(p => ({ ...p, paths: [...p.paths] }));
    const same = projects.find(p => p.name === name.trim());
    if (same) same.paths = [...new Set([...same.paths, ...group.paths])];
    else projects.push({ name: name.trim(), paths: [...group.paths] });
    await this.config().update('projects', projects, vscode.ConfigurationTarget.Global);
  }
  async chooseHome() {
    const selection = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Выбрать данные Codex', title: 'Выберите .codex с папкой sessions или состоянием приложения' });
    if (!selection?.[0]) return;
    await this.config().update('codexHome', selection[0].fsPath, vscode.ConfigurationTarget.Global);
  }
  async showDiagnostics() {
    const notes = {
      ...this.diagnostics,
      historySources: this.sourceDiagnostics(),
      activeSection: this.section, sectionCounts: Object.fromEntries(Object.keys(LABELS).map(section => [section, this.threads.filter(t => classifyThread(t, this.overrides).section === section).length])),
      activityError: this.activityError || null, pendingProject: this.context.globalState.get('pendingProject', null),
      notes: [
        'Диагностика не содержит текстов сообщений, содержимого auth.json или токенов. Пути и названия проектов могут содержать личные сведения.',
        'desktop — распознанное состояние приложения; inferred — группировка по папке, не подтверждённый проект.',
        'Если чатов мало: проверьте CODEX_HOME приложения и расширения, архив и Windows/WSL. Это расширение работает на стороне локального окна VS Code.',
        'Для современных сессий нужен совместимый App Server. JSONL-дополнение помогает со старыми локальными чатами, но не заменяет доступ к облачному хранилищу.',
        'Неизвестный формат состояния проектов не изменяется. Можно указать файл состояния отдельно или задать названия/папки через меню расширения.'
      ]
    };
    const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(notes, null, 2) });
    await vscode.window.showTextDocument(doc);
  }
  sourceDiagnostics() {
    return { extensionVersion: require('../package.json').version, platform: process.platform,
      codexHome: this.backend?.options?.home || this.config().get('codexHome', ''),
      apiSucceeded: !!this.diagnostics.apiSucceeded, projectApiSucceeded: !!this.diagnostics.projectApiSucceeded,
      ...sourceReport(this.threads, this.overrides), chatgptAccountHistory: this.online.report(this.onlineBridge.connected) };
  }
  async copySourceDiagnostics() {
    await vscode.env.clipboard.writeText(JSON.stringify(this.sourceDiagnostics(), null, 2));
    vscode.window.showInformationMessage('Диагностика источников скопирована. Текстов сообщений, вложений и токенов в ней нет.');
  }
  async chatgptConnectionInfo() {
    await this.connectOnline();
  }
  async restoreOnline() {
    try { const saved=await this.context.secrets?.get('onlineBrowserPairing');if(!saved || this.disposed)return;
      await this.onlineBridge.restore(JSON.parse(saved));if(this.disposed){this.onlineBridge.dispose();return;}this.rebuildTree();
    } catch { this.onlineRestoreError='Автоподключение недоступно: проверьте, не открыто ли другое окно VS Code с этим подключением.'; }
  }
  async browserComponentFolder() {
    const source=path.join(this.context.extensionPath || path.resolve(__dirname,'..'),'browser-bridge');
    if(!this.context.globalStorageUri?.fsPath)return source;
    const dest=path.join(this.context.globalStorageUri.fsPath,'browser-bridge');await fsp.mkdir(dest,{recursive:true});await fsp.cp(source,dest,{recursive:true});return dest;
  }
  async connectOnline(openBrowser = false) {
    await this.onlineInit;
    if (!this.onlineBridge.server || (!this.onlineBridge.peer && (!this.onlineBridge.pending || this.onlineBridge.pending.expires<Date.now()))) this.onlineCode = await this.onlineBridge.start();
    this.rebuildTree();
    if (this.onlineSetup) { this.onlineSetup.reveal(); this.updateOnlineStatus(); if(openBrowser)await this.launchOnlineBrowser(); return; }
    const panel = vscode.window.createWebviewPanel('codexProjects.onlineSetup', 'Подключить онлайн ChatGPT', vscode.ViewColumn.One, { enableScripts: true });
    this.onlineSetup = panel; panel.webview.html = renderSetup();
    panel.webview.onDidReceiveMessage(async m => {
      try {
        if (m.action === 'ready') this.updateOnlineStatus();
        if (m.action === 'copy') { if(!this.onlineBridge.pending || this.onlineBridge.pending.expires<Date.now())throw new Error('Создайте новое подключение командой «Подключить онлайн ChatGPT»'); await vscode.env.clipboard.writeText(this.onlineCode); panel.webview.postMessage({type:'status',text:'Резервный код скопирован. Действует 5 минут.'}); }
        if (m.action === 'launch') await this.launchOnlineBrowser();
        if (m.action === 'scan') { const result=await this.onlineBridge.execute('scan');if(result.state==='failed')this.online.scanStatus({state:'failed',note:result.note});this.rebuildTree();this.updateOnlineStatus(); }
        if (m.action === 'folder') { const folder=await this.browserComponentFolder();await vscode.env.clipboard.writeText(folder);await vscode.commands.executeCommand('revealFileInOS',vscode.Uri.file(path.join(folder,'manifest.json')));panel.webview.postMessage({type:'status',text:'Путь к папке скопирован. В браузере нажмите «Загрузить распакованное расширение» и вставьте этот путь.'}); }
        if (m.action === 'disconnect') this.disconnectOnline();
      } catch(e) { vscode.window.showErrorMessage(e.message); }
    });
    panel.onDidDispose(() => { this.onlineSetup = null; });
    this.updateOnlineStatus();
    if(openBrowser)await this.launchOnlineBrowser();
  }
  async launchOnlineBrowser() {
    if(this.onlineBridge.connected) { await vscode.env.openExternal(vscode.Uri.parse('https://chatgpt.com/'));return; }
    if(!this.onlineBridge.pending || this.onlineBridge.pending.expires<Date.now()) {
      this.online.clear();for(const panel of this.onlinePanels.values())panel.dispose();this.onlinePanels.clear();
      this.onlineCode=await this.onlineBridge.start();this.rebuildTree();
    }
    await vscode.env.openExternal(vscode.Uri.parse(this.onlineBridge.launchUrl()));
  }
  disconnectOnline() {
    this.onlineBridge.dispose(); this.online.clear(); this.onlineCode = '';
    this.context.secrets?.delete('onlineBrowserPairing').catch(()=>{});
    for (const panel of this.onlinePanels.values()) panel.dispose(); this.onlinePanels.clear();
    this.rebuildTree(); this.updateOnlineStatus();
  }
  updateOnlineStatus() {
    this.onlineSetup?.webview.postMessage({type:'status',text: this.onlineBridge.connected ? `Браузер подключён. Проектов: ${this.online.projects.size}; чатов: ${this.online.chats.size}. ${this.online.scan.note}` : this.onlineBridge.pending ? 'Ожидаю браузер. Если компонент уже установлен, подключение произойдёт автоматически.' : 'Браузер недоступен. Если подключение сохранено, оно восстановится автоматически.'});
    for (const [id, panel] of this.onlinePanels) { const c = this.online.chats.get(id), history = this.online.conversations.get(id);
      const revision = `${!!history}:` + JSON.stringify(history?.messages || []); if(c && panel.onlineRevision !== revision) { panel.onlineRevision = revision; panel.title=c.title;panel.webview.postMessage({type:'history',history}); } }
  }
  async openOnlineInBrowser(value) {
    const {route} = require('../browser-bridge/reader'); const r = route(value?.url);
    if (!r) throw new Error('Некорректная ссылка онлайн-чата');
    await vscode.env.openExternal(vscode.Uri.parse(r.url));
  }
  openOnlineChat(thread) {
    const old = this.onlinePanels.get(thread.onlineId); if(old) { old.reveal(); return; }
    const panel = vscode.window.createWebviewPanel('codexProjects.onlineChat', thread.name, vscode.ViewColumn.One, {enableScripts:true});
    this.onlinePanels.set(thread.onlineId, panel); panel.onlineRevision = `${!!this.online.conversations.get(thread.onlineId)}:` + JSON.stringify(this.online.conversations.get(thread.onlineId)?.messages || []); panel.webview.html = renderOnline(thread, this.online.conversations.get(thread.onlineId));
    panel.webview.onDidReceiveMessage(async m => {
      try {
        if(m.action === 'open') await this.openOnlineInBrowser(thread);
        if(m.action === 'refresh') panel.webview.postMessage({type:'history',history:this.online.conversations.get(thread.onlineId)});
        if(m.action === 'reviewed' && this.onlineBridge.acknowledge(thread.url)) panel.webview.postMessage({type:'sendResult',state:'failed',note:'Проверка исходного чата подтверждена вами. Можно написать новое сообщение.'});
        if(m.action === 'send') {
          if(panel.onlineSending)return;
          panel.onlineSending=true;
          try { const result=await this.onlineBridge.execute('send',{url:thread.url,text:m.text});panel.webview.postMessage({type:'sendResult',...result,text:m.text}); }
          finally {panel.onlineSending=false;}
        }
      }catch(e){panel.webview.postMessage({type:'sendResult',state:'failed',note:e.message});}
    });
    panel.onDidDispose(() => this.onlinePanels.delete(thread.onlineId));
  }
  dispose() {
    this.attachActivityRpc(null); this.activityReader.clear();
    this.onlineBridge.dispose(); this.onlineSetup?.dispose(); for(const p of this.onlinePanels.values()) p.dispose(); this.onlinePanels.clear(); this.online.clear();
    this.disposed = true; clearInterval(this.activityTimer); this.backend?.dispose(); this.files?.dispose();this.changes?.dispose();
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}
function activate(context) { const controller = new Controller(context); controller.refresh(); return { controller }; }
function deactivate() {}
module.exports = { activate, deactivate, Controller, ProjectsTree };
