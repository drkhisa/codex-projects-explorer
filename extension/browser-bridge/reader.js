/* Reads rendered ChatGPT content only. No cookies, tokens or undocumented API calls. */
(function (root) {
  'use strict';
  function route(value, base = 'https://chatgpt.com/') {
    try {
      const u = new URL(value, base);
      if (u.origin !== 'https://chatgpt.com' || u.username || u.password) return null;
      const projectId = value => value.match(/^(g-p-[a-f0-9]{32})(?:-|$)/i)?.[1] || value;
      let m = u.pathname.match(/^\/g\/(g-p-[a-zA-Z0-9-]+)(?:(?:\/[^/]+)?\/project)?\/?$/);
      if (m) return { kind: 'project', id: projectId(m[1]), url: u.origin + u.pathname };
      m = u.pathname.match(/^(?:\/g\/(g-p-[a-zA-Z0-9-]+)(?:\/[^/]+)?)?\/c\/([a-zA-Z0-9-]+)\/?$/);
      return m ? { kind: 'chat', id: m[2], projectId: m[1] ? projectId(m[1]) : '', url: u.origin + u.pathname } : null;
    } catch { return null; }
  }
  function text(el) { return (el?.innerText || el?.textContent || '').trim(); }
  function inMessage(el) { return !!el.closest('[data-message-author-role], article[data-testid^="conversation-turn-"]'); }
  function visible(el) {
    return !!el && !el.hidden && !el.closest('[hidden], [aria-hidden="true"]') && el.getClientRects().length > 0;
  }
  function composer(doc) { return doc.querySelector('#prompt-textarea, textarea[data-id="root"], textarea[name="prompt-textarea"]'); }
  function draft(el) { return el?.tagName === 'TEXTAREA' ? el.value : (el?.innerText || el?.textContent || ''); }
  function generating(doc) {
    return [...doc.querySelectorAll('button')].some(b => !b.disabled && !b.hidden && !b.closest('[hidden], [aria-hidden="true"]') && b.style.display !== 'none' && (b.getAttribute('data-testid') === 'stop-button' || /^(?:Stop generating|Stop streaming|Stop response|Остановить ответ|Остановить генерацию)$/i.test(b.getAttribute('aria-label') || '')));
  }
  function collect(doc, href) {
    const projects = new Map(), chats = new Map(), current = route(href);
    // Links are accepted only when the rendered application actually supplies them.
    for (const a of doc.querySelectorAll('a[href]')) {
      if (inMessage(a)) continue;
      const r = route(a.getAttribute('href'), href), title = text(a);
      if (!r || !title) continue;
      if (r.kind === 'project') projects.set(r.id, { ...r, title });
      else chats.set(r.id, { ...r, title, projectId: r.projectId || chats.get(r.id)?.projectId || '' });
    }
    // Some sidebar versions render a project folder button rather than a link.
    for (const group of doc.querySelectorAll('[data-project-id]')) {
      if (inMessage(group)) continue;
      const id=group.getAttribute('data-project-id');
      if (!/^g-p-[a-zA-Z0-9-]{1,150}$/.test(id || '')) continue;
      const title=group.getAttribute('data-project-name') || text(group.querySelector('button, [role="button"]'));
      const r=route(`/g/${id}/project`,href);
      if (title && r && !projects.has(r.id)) projects.set(r.id,{...r,title});
    }
    // An explicitly grouped sidebar list also proves membership; neighbouring recents do not.
    for (const group of doc.querySelectorAll('[data-project-id], [role="group"][aria-labelledby]')) {
      if (inMessage(group)) continue;
      const links = [...group.querySelectorAll('a[href]')];
      const ids = new Set(links.map(a => route(a.getAttribute('href'), href)).filter(r => r?.kind === 'project').map(r => r.id));
      const label = doc.getElementById(group.getAttribute('aria-labelledby') || '');
      const projectLink = label?.matches('a[href]') ? label : label?.querySelector('a[href]');
      const labelId = route(projectLink?.getAttribute('href'), href)?.id;
      if (labelId && projects.has(labelId)) ids.add(labelId);
      const explicit = group.getAttribute('data-project-id');
      if (explicit && projects.has(explicit)) ids.add(explicit);
      if (ids.size !== 1) continue;
      const id = [...ids][0];
      if (!explicit && labelId !== id) continue;
      if (explicit && explicit !== id) continue;
      for (const a of links) {
        const r = route(a.getAttribute('href'), href);
        if (r?.kind === 'chat' && !r.projectId && chats.has(r.id)) chats.get(r.id).projectId = id;
      }
    }
    // A project-page chat link may omit projectId. Assign only links in its main list,
    // never the global sidebar's recent chats.
    if (current?.kind === 'project') {
      const heading = text(doc.querySelector('main h1, [role="main"] h1'));
      if (heading) projects.set(current.id, { ...current, title: heading });
      for (const a of doc.querySelectorAll('main a[href], [role="main"] a[href]')) {
        if (inMessage(a)) continue;
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
      // A plain /c/ URL must not erase the membership supplied by a project list.
      const breadcrumbs = [...doc.querySelectorAll('main a[href], [role="main"] a[href], header a[href]')]
        .filter(a => !inMessage(a) && !a.closest('nav, aside, [role="navigation"]'))
        .map(a => route(a.getAttribute('href'), href)).filter(r => r?.kind === 'project');
      const ids = new Set(breadcrumbs.map(r => r.id));
      chats.set(current.id, { ...current, title, projectId: current.projectId || chats.get(current.id)?.projectId || (ids.size === 1 ? breadcrumbs[0].id : '') });
      conversation = { id: current.id, title, url: current.url, messages, activity: generating(doc) ? 'active' : 'idle' };
    }
    const page = new URL(href);
    return { version: 1, pageUrl: page.origin + page.pathname, projects: [...projects.values()], chats: [...chats.values()], conversation,
      coverage: 'rendered-pages', complete: false };
  }
  const api = { route, collect, generating, text, visible, composer, draft, inMessage };
  if (typeof module !== 'undefined') module.exports = api;
  else root.CodexOnlineReader = api;
})(typeof self === 'undefined' ? this : self);
