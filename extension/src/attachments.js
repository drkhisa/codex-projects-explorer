'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { inside } = require('./file-tree');
const IMAGE = new Set(['.png','.jpg','.jpeg','.webp','.gif','.bmp','.avif']);
const DOCUMENT = new Set(['.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.odt','.ods','.odp','.rtf']);
const TEXT_FILE = new Set(['.txt','.md','.csv','.json','.yaml','.yml','.html','.xml','.log','.lrc','.js','.ts','.py','.gd','.cs','.toml']);
function contentAttachments(content) {
  if (!Array.isArray(content)) return [];
  return content.flatMap(c => {
    if (!c || !['localImage','local_image','image','input_image','localAudio','file','input_file','output_file'].includes(c.type)) return [];
    const location = c.path || c.url || (typeof c.image_url === 'string' ? c.image_url : c.image_url?.url) || c.file_url;
    return [{ kind: /image/i.test(c.type) ? 'image' : 'document', location: typeof location === 'string' ? location : '', fileId: c.fileId || c.file_id || '', name: c.name || c.filename || '', explicit: true }];
  });
}
function generatedImageAttachment(item) {
  let location = item.savedPath || item.saved_path || '';
  if (!location && typeof item.result === 'string' && item.result) location = /^(?:data:|https:\/\/)/i.test(item.result) ? item.result : /^[a-z0-9+/=\s]+$/i.test(item.result) ? 'data:image/png;base64,' + item.result : '';
  return { kind: 'image', location, fileId: item.fileId || item.file_id || '', name: 'Созданное изображение', explicit: true };
}
function markdownAttachments(text) {
  const out = [];
  for (const m of String(text || '').replace(/```[\s\S]*?(?:```|$)/g,'').replace(/`[^`]*`/g,'').matchAll(/(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\n]+)\s*\)/g)) {
    const location = m[3].trim().replace(/^<|>$/g, ''), extension = path.extname(location.split(/[?#]/)[0]).toLowerCase();
    if (m[1] || IMAGE.has(extension) || DOCUMENT.has(extension) || TEXT_FILE.has(extension) || /^(?:sandbox:|file:|[a-z]:[\\/]|\.{0,2}\/)/i.test(location)) out.push({ kind: m[1] || IMAGE.has(extension) ? 'image' : 'document', location, target: location, name: m[2] });
  }
  return out;
}
class AttachmentRegistry {
  constructor(vscode, panel, thread) { this.vscode = vscode; this.panel = panel; this.thread = thread; this.assets = new Map(); this.byLocation = new Map(); this.roots = new Set(); }
  async register(ref, role) {
    const key = (ref.location || ref.fileId || ref.name) + '\0' + ref.kind;
    if (this.byLocation.has(key)) return { ...this.assets.get(this.byLocation.get(key)).view, ...(ref.target ? { target: ref.target } : {}) };
    const id = crypto.randomUUID(), location = ref.location || '';
    const view = { id, kind: ref.kind, name: ref.name || (location ? (/^data:/i.test(location) ? 'Изображение' : path.basename(location.replace(/\\/g,'/').split('?')[0]).slice(0,300)) : 'Вложение'), target: ref.target || '', available: false, canOpen: false };
    const record = { view, location }; this.assets.set(id, record); this.byLocation.set(key, id);
    try {
      if (/^https:\/\//i.test(location)) { record.url = location; view.available = true; view.canOpen = true; if (ref.kind === 'image') view.src = location; return view; }
      if (/^data:image\/(?:png|jpeg|webp|gif|bmp|avif);base64,[a-z0-9+/=\s]+$/i.test(location) && location.length <= 15 * 1024 * 1024) { view.src = location; view.available = true; return view; }
      if (!location) throw new Error('В истории сохранился только идентификатор, без доступного файла.');
      let file = location.replace(/^sandbox:/i, '');
      if (/^file:/i.test(file)) file = fileURLToPath(file);
      if (!path.isAbsolute(file)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(file) || !this.thread.cwd) throw new Error('Путь недоступен на этом компьютере.');
        file = path.resolve(this.thread.cwd, file);
      }
      file = await fs.realpath(file); const stat = await fs.stat(file);
      if (!stat.isFile()) throw new Error('Это не обычный файл.');
      record.file = file; view.available = true; view.canOpen = true; view.path = file; view.size = stat.size;
      // Only explicitly attached images and project images are loaded automatically.
      if (ref.kind === 'image' && IMAGE.has(path.extname(file).toLowerCase()) && (ref.explicit || role === 'user' || (this.thread.cwd && inside(await fs.realpath(this.thread.cwd), file)))) {
        this.roots.add(path.dirname(file));
        if (this.panel.webview.asWebviewUri) {
          this.panel.webview.options = { ...this.panel.webview.options, localResourceRoots: [...this.roots].map(p => this.vscode.Uri.file(p)) };
          view.src = this.panel.webview.asWebviewUri(this.vscode.Uri.file(file)).toString();
        }
      }
    } catch (e) { view.error = e.code === 'ENOENT' ? 'Файл больше не найден на этом компьютере' : e.message; }
    return view;
  }
  async decorate(item) {
    const refs = [...(item.attachments || []), ...markdownAttachments(item.text)];
    const attachments = []; const seen = new Set();
    for (const ref of refs) {
      const asset = await this.register(ref, item.role); if (!seen.has(asset.id)) { seen.add(asset.id); attachments.push(asset); }
    }
    return { ...item, attachments };
  }
  async history(history) {
    if (Array.isArray(history.timeline)) {
      const timeline = []; for (const item of history.timeline) timeline.push(item.kind === 'message' ? await this.decorate(item) : item);
      return { ...history, timeline, messages: timeline.filter(x => x.kind === 'message') };
    }
    const messages = []; for (const item of history.messages || []) messages.push(await this.decorate(item));
    return { ...history, messages };
  }
  async open(id) {
    const record = this.assets.get(id); if (!record?.view.available) throw new Error(record?.view.error || 'Вложение недоступно.');
    if (record.url) { await this.vscode.env.openExternal(this.vscode.Uri.parse(record.url)); return; }
    if (!record.file) return;
    if (DOCUMENT.has(path.extname(record.file).toLowerCase())) await this.vscode.env.openExternal(this.vscode.Uri.file(record.file));
    else await this.vscode.commands.executeCommand('vscode.open', this.vscode.Uri.file(record.file), { viewColumn: this.panel.viewColumn, preview: true });
  }
}
module.exports = { contentAttachments, markdownAttachments, generatedImageAttachment, AttachmentRegistry, IMAGE, DOCUMENT };
