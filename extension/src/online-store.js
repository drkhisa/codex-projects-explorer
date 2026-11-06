'use strict';
const { route } = require('../browser-bridge/reader');
const text = (s, max = 500) => typeof s === 'string' ? s.trim().slice(0, max) : '';
class OnlineStore {
  constructor() { this.clear(); }
  clear() { this.projects = new Map(); this.chats = new Map(); this.conversations = new Map(); this.lastSync = null; }
  ingest(snapshot) {
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.projects) || !Array.isArray(snapshot.chats)) throw new Error('Неподдерживаемый снимок браузера');
    const page = new URL(snapshot.pageUrl);
    if (page.origin !== 'https://chatgpt.com') throw new Error('Ожидалась страница chatgpt.com');
    const projects = new Map(this.projects), chats = new Map(this.chats), conversations = new Map(this.conversations);
    const add = (rows, target, kind) => {
      if (rows.length > 10000) throw new Error('Слишком много записей');
      for (const row of rows) {
        const r = route(row.url);
        if (!r || r.kind !== kind || r.id !== row.id || !text(row.title)) continue;
        const old = target.get(r.id), projectId = kind === 'chat' ? text(row.projectId, 100) || r.projectId || old?.projectId || '' : undefined;
        target.set(r.id, { id: r.id, title: text(row.title), url: r.url, ...(kind === 'chat' ? { projectId, ...(old?.activity ? {activity:old.activity,activityAt:old.activityAt} : {}) } : {}) });
      }
    };
    add(snapshot.projects, projects, 'project'); add(snapshot.chats, chats, 'chat');
    if (projects.size > 2000 || chats.size > 20000) throw new Error('Достигнут предел снимков этого сеанса');
    const c = snapshot.conversation, r = c && route(c.url);
    if (r?.kind === 'chat' && r.id === c.id && Array.isArray(c.messages)) {
      if (c.messages.length > 20000) throw new Error('Слишком много сообщений');
      const messages = c.messages.filter(m => ['user','assistant'].includes(m?.role) && typeof m.text === 'string')
        .map(m => ({ id: text(m.id, 200), role: m.role, text: m.text.slice(0, 100000) }));
      // Rendered/virtualized transcripts may be incomplete. Replace this snapshot rather
      // than inventing ordering when a message has no stable identity.
      conversations.delete(r.id);
      conversations.set(r.id, { id: r.id, url: r.url, title: text(c.title), messages, capturedAt: Date.now(), complete: false });
      if(chats.has(r.id) && ['active','idle'].includes(c.activity))chats.set(r.id,{...chats.get(r.id),activity:c.activity,activityAt:Date.now()});
    }
    const weight = c => c.messages.reduce((n, m) => n + m.text.length * 2, 0);
    let total = [...conversations.values()].reduce((n,c) => n + weight(c), 0);
    for (const [id,c] of conversations) { if (total <= 16 * 1024 * 1024) break; total -= weight(c); conversations.delete(id); }
    this.projects = projects; this.chats = chats; this.conversations = conversations;
    this.lastSync = Date.now();
  }
  report(connected = false) { return { state: connected ? 'browserConnected' : this.lastSync ? 'browserCache' : 'notConnected',
    threadCount: this.lastSync ? this.chats.size : null, projectCount: this.lastSync ? this.projects.size : null,
    accountThreadCount: null, accountProjectCount: null, complete: false, coverage: 'rendered-pages', lastSync: this.lastSync }; }
  groups() {
    const groups = [...this.projects.values()].map(p => ({ id: `online-project:${p.id}`, projectId: p.id, name: p.title, origin: 'online', paths: [], url: p.url, threads: [] }));
    const loose = { id: 'online-loose', name: 'Онлайн-чаты без загруженной привязки', origin: 'online', paths: [], threads: [] };
    for (const c of this.chats.values()) {
      const g = groups.find(g => g.projectId === c.projectId) || loose;
      g.threads.push({ ...c, running:c.activity==='active' && Date.now()-(c.activityAt||0)<90000, id: `online-${c.id}`, onlineId: c.id, provider: 'chatgpt-browser', name: c.title, sectionReason: 'Онлайн ChatGPT: данные отображённых страниц браузера' });
    }
    if (loose.threads.length) groups.push(loose);
    return groups;
  }
}
module.exports = { OnlineStore };
