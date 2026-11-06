'use strict';
(() => {
  const api = acquireVsCodeApi(), tree = document.getElementById('tree'), error = document.getElementById('error');
  let generation, sequence = 0; const nodes = new Map(), opened = new Set();
  let changedFiles = new Map();
  const review=document.createElement('details'),reviewTitle=document.createElement('summary'),reviewList=document.createElement('ul'),reviewNote=document.createElement('p');
  review.open=true;review.className='changes';reviewTitle.textContent='Изменения проекта · Git';reviewNote.className='empty';review.append(reviewTitle,reviewNote,reviewList);tree.before(review);
  const key=p=>/^[a-z]:/i.test(p)?p.replace(/\\/g,'/').toLowerCase():p.replace(/\\/g,'/');
  function decorate(view){const exact=changedFiles.get(key(view.data.path)),nested=view.data.directory&&[...changedFiles.keys()].some(p=>p.startsWith(key(view.data.path)+'/'));view.badge.textContent=exact?.status || (nested?'●':'');view.button.classList.toggle('modified',!!exact||!!nested);}
  function changes(files,notes){changedFiles=new Map(files.map(f=>[key(f.path),f]));reviewTitle.textContent=`Изменения проекта · Git (${files.length})`;reviewList.replaceChildren();reviewNote.textContent=notes?.join(' ') || (files.length?'Все незакоммиченные изменения, включая ваши. Клик — сравнение с HEAD.':'Нет незакоммиченных изменений.');
    const folders=new Map();
    for(const f of files){const parts=f.relative.replace(/\\/g,'/').split('/');if(new Set(files.map(x=>x.rootName)).size>1)parts.unshift(f.rootName);let parent=reviewList,prefix='';for(const name of parts.slice(0,-1)){prefix+='/'+name;if(!folders.has(prefix)){const li=document.createElement('li'),d=document.createElement('details'),s=document.createElement('summary'),ul=document.createElement('ul');d.open=true;s.textContent=name;d.append(s,ul);li.append(d);parent.append(li);folders.set(prefix,ul);}parent=folders.get(prefix);}const li=document.createElement('li'),b=document.createElement('button');b.className='row modified';b.textContent=f.status+'  '+parts.at(-1);b.title=f.path+' · '+f.code;b.onclick=()=>post('diff',{id:f.id});li.append(b);parent.append(li);}
    for(const view of nodes.values())decorate(view);
  }
  const post = (action, data = {}) => api.postMessage({ action, generation, ...data });
  function load(view) {
    view.request = ++sequence; view.loading = true;
    post('children', { id: view.data.id, request: view.request });
  }
  function expanded(view, open) {
    if (open) opened.add(view.data.path); else opened.delete(view.data.path);
    view.open = open; view.li.setAttribute('aria-expanded', String(open)); view.list.hidden = !open; view.chevron.textContent = open ? '⌄' : '›';
    if (open && !view.loaded && !view.loading) load(view);
  }
  function row(data) {
    const li = document.createElement('li'); li.setAttribute('role', 'treeitem'); li.dataset.nodeId = data.id;
    const button = document.createElement('button'); button.className = 'row' + (data.directory ? ' folder' : ''); button.disabled = data.disabled; button.title = data.path + (data.error ? '\n' + data.error : '');
    const chevron = document.createElement('span'); chevron.className = 'chevron'; chevron.textContent = data.directory ? '›' : '';
    const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = data.directory ? '▱' : '≡'; icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.className = 'label'; label.textContent = data.name + (data.symlink ? ' ↗' : '');const badge=document.createElement('span');badge.className='change-badge';button.append(chevron, icon, label,badge); li.append(button);
    const view = { li, button, chevron, badge, data, open: false, loaded: false, loading: false };decorate(view);
    if (data.directory) { const list = document.createElement('ul'); list.setAttribute('role', 'group'); list.hidden = true; li.append(list); view.list = list; li.setAttribute('aria-expanded', 'false'); }
    nodes.set(data.id, view);
    button.onclick = () => {
      for (const selected of tree.querySelectorAll('.selected')) selected.classList.remove('selected'); button.classList.add('selected');
      if (data.directory) expanded(view, !view.open); else {const change=changedFiles.get(key(data.path));if(change)post('diff',{id:change.id});else post('open', { id: data.id, preview: true });}
    };
    button.ondblclick = () => { if (!data.directory) post('open', { id: data.id, preview: false }); };
    button.onkeydown = event => {
      if (event.key === 'ArrowRight' && data.directory) { event.preventDefault(); if (!view.open) expanded(view, true); else view.list.querySelector('button:not(:disabled)')?.focus(); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); if (data.directory && view.open) expanded(view, false); else li.parentElement.closest('li')?.querySelector('button')?.focus(); }
      else if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        event.preventDefault(); const buttons = [...tree.querySelectorAll('button:not(:disabled)')].filter(b => !b.closest('[hidden]')), i = buttons.indexOf(button);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1))); buttons[index]?.focus();
      }
    };
    return li;
  }
  function dropDescendants(view) {
    for (const child of view.list.querySelectorAll('li[role="treeitem"]')) nodes.delete(child.dataset.nodeId);
    view.list.replaceChildren();
  }
  document.getElementById('refresh').onclick = () => post('refresh');
  window.addEventListener('message', event => {
    const m = event.data;
    if (m.type === 'roots') {
      generation = m.generation; nodes.clear(); opened.clear();changedFiles.clear();reviewList.replaceChildren();reviewNote.textContent='Проверяю Git…'; tree.replaceChildren(); error.hidden = true; document.getElementById('title').textContent = m.name;
      for (const data of m.roots) tree.append(row(data));
      if (m.roots.length === 1 && !m.roots[0].disabled) expanded(nodes.get(m.roots[0].id), true);
    } else if (m.generation !== generation) return;
    else if(m.type==='changes')changes(m.files||[],m.notes||[]);
    else if (m.type === 'children' || (m.type === 'error' && m.id)) {
      const view = nodes.get(m.id); if (!view || view.request !== m.request) return;
      view.loading = false; view.loaded = m.type === 'children'; dropDescendants(view);
      if (m.type === 'error' || !m.children.length) { const note = document.createElement('li'); note.className = m.type === 'error' ? 'failure' : 'empty'; note.textContent = m.message || 'Папка пуста'; view.list.append(note); }
      else for (const data of m.children) { view.list.append(row(data)); if (data.directory && !data.disabled && opened.has(data.path)) expanded(nodes.get(data.id), true); }
    } else if (m.type === 'error') { error.textContent = m.message; error.hidden = false; }
    else if (m.type === 'changed') { for (const data of [...tree.children]) { const view = nodes.get(data.dataset.nodeId); if (view) { view.loaded = false; if (view.open) load(view); } } }
  });
  post('ready');
})();
