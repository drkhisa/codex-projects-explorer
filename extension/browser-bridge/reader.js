/* Reads rendered ChatGPT content only. No cookies, tokens or undocumented API calls. */
(function (root) {
  'use strict';
  function route(value, base = 'https://chatgpt.com/') {
    try {
      const u = new URL(value, base);
      if (u.origin !== 'https://chatgpt.com' || u.username || u.password) return null;
      let m = u.pathname.match(/^\/g\/(g-p-[a-zA-Z0-9-]+)(?:\/[^/]+)?\/project\/?$/);
      if (m) return { kind: 'project', id: m[1], url: u.origin + u.pathname };
      m = u.pathname.match(/^(?:\/g\/(g-p-[a-zA-Z0-9-]+)(?:\/[^/]+)?)?\/c\/([a-zA-Z0-9-]+)\/?$/);
      return m ? { kind: 'chat', id: m[2], projectId: m[1] || '', url: u.origin + u.pathname } : null;
    } catch { return null; }
  }
  function text(el) { return (el?.innerText || el?.textContent || '').trim(); }
  function generating(doc) {
    return [...doc.querySelectorAll('button')].some(b => !b.disabled && !b.hidden && !b.closest('[hidden], [aria-hidden="true"]') && b.style.display !== 'none' && (b.getAttribute('data-testid') === 'stop-button' || /^(?:Stop generating|Stop streaming|Stop response|Остановить ответ|Остановить генерацию)$/i.test(b.getAttribute('aria-label') || '')));
  }
  function collect(doc, href) {
    const projects = new Map(), chats = new Map(), current = route(href);
    // Links are accepted only when the rendered application actually supplies them.
    for (const a of doc.querySelectorAll('a[href]')) {
      if (a.closest('[data-message-author-role], article')) continue;
      const r = route(a.getAttribute('href'), href), title = text(a);
      if (!r || !title) continue;
      if (r.kind === 'project') projects.set(r.id, { ...r, title });
      else chats.set(r.id, { ...r, title });
    }
    // A project-page chat link may omit projectId. Assign only links in its main list,
    // never the global sidebar's recent chats.
    if (current?.kind === 'project') {
      const heading = text(doc.querySelector('main h1, [role="main"] h1'));
      if (heading) projects.set(current.id, { ...current, title: heading });
      for (const a of doc.querySelectorAll('main a[href], [role="main"] a[href]')) {
        const r = route(a.getAttribute('href'), href);
        if (r?.kind === 'chat' && chats.has(r.id)) chats.get(r.id).projectId = current.id;
      }
    }
    const messages = [];
    for (const el of doc.querySelectorAll('[data-message-author-role]')) {
      const role = el.getAttribute('data-message-author-role');
      if (!['user', 'assistant'].includes(role)) continue;
      const body = el.querySelector('.markdown, .whitespace-pre-wrap') || el;
      const turn = el.closest('[data-message-id], [data-turn-id], article');
      const id = el.getAttribute('data-message-id') || turn?.getAttribute('data-turn-id') || turn?.id || '';
      // Keep text, not arbitrary page HTML or scripts. Remote media remains in ChatGPT.
      messages.push({ id, role, text: text(body) });
    }
    let conversation = null;
    if (current?.kind === 'chat') {
      const title = chats.get(current.id)?.title || doc.title.replace(/\s*[-–—|]\s*ChatGPT$/, '').trim() || 'Чат ChatGPT';
      chats.set(current.id, { ...current, title });
      conversation = { id: current.id, title, url: current.url, messages, activity: generating(doc) ? 'active' : 'idle' };
    }
    const page = new URL(href);
    return { version: 1, pageUrl: page.origin + page.pathname, projects: [...projects.values()], chats: [...chats.values()], conversation,
      coverage: 'rendered-pages', complete: false };
  }
  const api = { route, collect, generating };
  if (typeof module !== 'undefined') module.exports = api;
  else root.CodexOnlineReader = api;
})(typeof self === 'undefined' ? this : self);
