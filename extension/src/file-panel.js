'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { FileTree } = require('./file-tree');
const { ChangesReview } = require('./changes');

function renderFileTree() {
  const nonce = crypto.randomBytes(18).toString('hex');
  const css = fs.readFileSync(path.join(__dirname, '..', 'media', 'files.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'media', 'files.js'), 'utf8');
  return `<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><title>Файлы проекта</title><style nonce="${nonce}">${css}</style></head><body><header><strong id="title">Файлы проекта</strong><button id="refresh" title="Обновить дерево" aria-label="Обновить дерево">↻</button></header><div id="hint">Нажмите на папку, чтобы раскрыть её. Файл откроется в редакторе.</div><div id="error" role="status" hidden></div><ul id="tree" role="tree" aria-label="Файлы проекта"></ul><script nonce="${nonce}">${js}</script></body></html>`;
}

class ProjectFiles {
  constructor(vscode) { this.vscode = vscode; this.generation = 0; this.watchers = []; this.closed = false; this.changes = new ChangesReview(vscode); }
  post(data) { this.panel?.webview.postMessage({ ...data, generation: this.generation }); }
  disposeWatchers() { clearTimeout(this.timer);clearInterval(this.changeTimer); for (const watcher of this.watchers) watcher.dispose(); this.watchers = []; }
  async show(group) {
    this.closed = false; const generation = ++this.generation; this.disposeWatchers(); this.model = null;
    const model = await FileTree.create(group.paths);
    if (this.closed || generation !== this.generation) return;
    this.model = model; this.group = group;
    const v = this.vscode;
    if (!this.panel) {
      this.editorColumn = v.window.activeTextEditor?.viewColumn || v.ViewColumn.One;
      this.panel = v.window.createWebviewPanel('codexProjects.files', 'Файлы · ' + group.name, { viewColumn: v.ViewColumn.Beside, preserveFocus: false },
        { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
      this.listener = this.panel.webview.onDidReceiveMessage(message => this.receive(message));
      this.panel.onDidDispose(() => { this.closed = true; this.generation++; this.disposeWatchers(); this.listener.dispose(); this.panel = null; this.model = null; });
      this.panel.webview.html = renderFileTree();
    } else { this.panel.title = 'Файлы · ' + group.name; this.panel.reveal(undefined, false); }
    this.post({ type: 'roots', name: group.name, roots: model.roots });
    await this.refreshChanges();
    if(this.closed || generation!==this.generation)return;
    this.changeTimer=setInterval(()=>{if(this.panel?.visible!==false)this.refreshChanges();},4000);this.changeTimer.unref?.();
    if (v.workspace.createFileSystemWatcher && v.RelativePattern) {
      for (const root of model.roots.filter(r => !r.disabled)) {
        const watcher = v.workspace.createFileSystemWatcher(new v.RelativePattern(v.Uri.file(root.path), '**/*'), false, false, false);
        const changed = () => { clearTimeout(this.timer); this.timer = setTimeout(() => { this.post({ type: 'changed' });this.refreshChanges(); }, 500); };
        watcher.onDidCreate(changed); watcher.onDidDelete(changed); watcher.onDidChange(changed); this.watchers.push(watcher);
      }
    }
  }
  async receive(message) {
    if (!message || !this.model || this.closed) return;
    if (message.action === 'ready') { this.post({ type: 'roots', name: this.group.name, roots: this.model.roots }); await this.refreshChanges();return; }
    if (message.generation !== this.generation) return;
    const generation = this.generation, model = this.model;
    try {
      if (message.action === 'children') {
        const children = await model.children(message.id);
        if (generation === this.generation) this.post({ type: 'children', id: message.id, children, request: message.request });
      } else if (message.action === 'diff') { await this.changes.open(message.id,this.editorColumn);
      } else if (message.action === 'open') {
        const file = await model.file(message.id);
        if (generation !== this.generation) return;
        await this.vscode.commands.executeCommand('vscode.open', this.vscode.Uri.file(file), { viewColumn: this.editorColumn, preview: message.preview !== false, preserveFocus: true });
      } else if (message.action === 'refresh') await this.show(this.group);
    } catch (error) { if (generation === this.generation) this.post({ type: 'error', id: message.action === 'children' ? message.id : null, message: error.message, request: message.request }); }
  }
  async refreshChanges() { if(!this.model || this.closed)return;if(this.changePoll){this.changeAgain=true;return;}this.changePoll=true;const gen=this.generation;
    try{const result=await this.changes.list(this.group.paths);if(gen===this.generation && !this.closed)this.post({type:'changes',...result});}
    catch{if(gen===this.generation)this.post({type:'changes',files:[],notes:['Не удалось прочитать изменения Git.']});}
    finally{this.changePoll=false;if(this.changeAgain){this.changeAgain=false;this.refreshChanges();}}
  }
  dispose() { this.closed = true; this.generation++; this.disposeWatchers(); this.changes.dispose();this.panel?.dispose(); }
}
module.exports = { ProjectFiles, renderFileTree };
