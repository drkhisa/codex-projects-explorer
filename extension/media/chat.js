'use strict';
(() => {
  const api = acquireVsCodeApi(), $ = id => document.getElementById(id);
  const saved = api.getState() || {};
  const state = { models: [], running: false, attachments: [], messages: new Map(), tools: new Map(), requests: new Map(), prefs: saved.prefs || {}, pendingUser: null, assets: new Map(), catalog: [], catalogErrors: [], catalogLoaded: false, lastAssistant: '', lastAssistantId: null, follow: true };
  const history = $('history'), scroll = $('scroll'), input = $('input');
  input.value = saved.draft || '';
  const post = (action, data = {}) => api.postMessage({ action, ...data });
  const store = () => { state.prefs = { model: $('model').value, effort: $('effort').value }; api.setState({ draft: input.value, prefs: state.prefs }); };
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  function assetHtml(asset) {
    const disabled = asset.available ? '' : ' disabled';
    const image = asset.src ? '<img src="' + esc(asset.src) + '" alt="' + esc(asset.name) + '" loading="lazy">' : '<span class="asset-icon">' + (asset.kind === 'image' ? '▧' : '▤') + '</span>';
    return '<button class="asset-card ' + (asset.src ? 'asset-image' : '') + '" data-asset="' + esc(asset.id) + '" title="' + esc(asset.error || asset.path || asset.name) + '"' + disabled + '>' + image + '<span>' + esc(asset.name) + (asset.available ? '' : ' · файл недоступен') + '</span></button>';
  }
  function inline(text, assets = []) {
    // Raw HTML is escaped. Media uses host-registered assets; command: links stay inert.
    const parts = String(text).split(/(`[^`]+`)/g);
    return parts.map(part => part.startsWith('`') && part.endsWith('`') ? '<code>' + esc(part.slice(1, -1)) + '</code>'
      : esc(part).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/!?\[([^\]\n]*)\]\(\s*(&lt;[^\n]+?&gt;|[^)\n]+)\s*\)/g, (raw, label, value) => {
          const target = value.trim().replace(/^&lt;|&gt;$/g, ''), asset = assets.find(a => a.target && esc(a.target) === target);
          if (asset) return assetHtml(asset);
          return /^https?:\/\/[^\s<>]+$/.test(target) && !raw.startsWith('!') ? '<a href="' + target + '">' + label + '</a>' : raw;
        })).join('');
  }
  function markdown(text, assets = []) {
    const format = value => inline(value, assets);
    let html = '';
    // Fence parsing is line-based below so unclosed streaming code stays safe and readable.
    const lines = String(text).split('\n'); let code = null, paragraph = [], list = null;
    const flush = () => { if (paragraph.length) { html += '<p>' + paragraph.map(format).join('<br>') + '</p>'; paragraph = []; } if (list) { html += `</${list}>`; list = null; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) { if (code !== null) { html += '<pre><code>' + esc(code.join('\n')) + '</code></pre>'; code = null; } else { flush(); code = []; } continue; }
      if (code !== null) { code.push(line); continue; }
      if (!line.trim()) { flush(); continue; }
      const heading = /^(#{1,4})\s+(.+)$/.exec(line);
      if (heading) { flush(); const h = Math.min(4, heading[1].length + 1); html += `<h${h}>${format(heading[2])}</h${h}>`; continue; }
      if (line.includes('|') && /^\s*\|?\s*:?-+/.test(lines[i + 1] || '')) {
        flush(); const cells = s => s.replace(/^\s*\||\|\s*$/g, '').split('|');
        html += '<table><thead><tr>' + cells(line).map(c => '<th>' + format(c.trim()) + '</th>').join('') + '</tr></thead><tbody>'; i++;
        while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) { i++; html += '<tr>' + cells(lines[i]).map(c => '<td>' + format(c.trim()) + '</td>').join('') + '</tr>'; }
        html += '</tbody></table>'; continue;
      }
      const li = /^\s*(?:([-*•])|\d+[.)])\s+(.+)$/.exec(line);
      if (li) { if (paragraph.length) { html += '<p>' + paragraph.map(format).join('<br>') + '</p>'; paragraph = []; } const tag = li[1] ? 'ul' : 'ol'; if (list !== tag) { if (list) html += `</${list}>`; html += `<${tag}>`; list = tag; } html += '<li>' + format(li[2]) + '</li>'; continue; }
      if (/^>\s?/.test(line)) { flush(); html += '<blockquote>' + format(line.replace(/^>\s?/, '')) + '</blockquote>'; continue; }
      if (list) { html += `</${list}>`; list = null; } paragraph.push(line);
    }
    if (code !== null) html += '<pre><code>' + esc(code.join('\n')) + '</code></pre>';
    flush(); return html;
  }
  function updateJump() { $('jump-bottom').hidden = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100; }
  function bottom(force = false) { if (state.renderingHistory) return; if (force || state.follow) { scroll.scrollTop = scroll.scrollHeight; state.follow = true; } updateJump(); }
  scroll.addEventListener('scroll', () => { state.follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100; updateJump(); });
  $('jump-bottom').onclick = () => { bottom(true); input.focus(); };
  history.addEventListener('load', event => { if (event.target.tagName === 'IMG') bottom(); }, true);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => bottom()).observe(scroll);
  function notice(message, error = false) { const node = document.createElement('div'); node.className = error ? 'notice error' : 'notice'; node.textContent = message; history.append(node); bottom(true); }
  function message(role, text, id, attachments) {
    $('welcome')?.remove(); const key = id || 'm-' + Math.random(); let item = state.messages.get(key);
    if (!item) {
      const node = document.createElement('article'); node.className = 'message ' + (role === 'user' ? 'user' : 'assistant'); node.setAttribute('aria-label', role === 'user' ? 'Ваше сообщение' : 'Ответ Codex');
      const speaker = document.createElement('div'); speaker.className = 'speaker'; speaker.textContent = role === 'user' ? 'Вы' : 'Codex';
      const body = document.createElement('div'); body.className = 'body'; node.append(speaker, body); history.append(node);
      if (role === 'assistant') state.lastAssistantId = key;
      item = { node, body, text: '', assets: [] }; state.messages.set(key, item);
    }
    item.text = text; if (Array.isArray(attachments)) item.assets = attachments;
    for (const asset of item.assets) state.assets.set(asset.id, asset);
    const display = item.assets.some(a => a.kind === 'image') ? text.replace(/^\[Изображение\]$/gm, '') : text;
    item.body.innerHTML = markdown(display, item.assets);
    const extra = item.assets.filter(a => !a.target || !text.includes(a.target));
    if (extra.length) { const media = document.createElement('div'); media.className = 'message-assets'; media.innerHTML = extra.map(assetHtml).join(''); item.body.append(media); }
    if (role === 'assistant' && state.lastAssistantId === key) state.lastAssistant = text;
    updateSuggestion(); return item;
  }
  function setRunning(running) {
    state.running = running; updateSuggestion(); $('stop').hidden = !running; $('enqueue').hidden = !running;
    $('refresh').disabled = running || !!state.renderingHistory; $('attach').disabled = !!state.pasting;
    $('older-history').disabled = $('latest-history').disabled = running || !!state.renderingHistory;
    $('model').disabled = $('effort').disabled = !state.models.length || !!state.submitting;
    input.disabled = false;
    $('status').textContent = running ? 'Codex работает…' : 'Готов';
    $('busy').hidden = !running; $('send').disabled = $('enqueue').disabled = !state.models.length || !!state.pasting || !!state.submitting || !!state.renderingHistory;
    $('send').textContent = running ? 'Уточнить сейчас' : '↑'; $('send').title = running ? 'Уточнить сейчас (Ctrl+Enter)' : 'Отправить сообщение (Ctrl+Enter)'; $('send').setAttribute('aria-label', running ? 'Уточнить текущий запрос' : 'Отправить сообщение');
  }
  const effortLabels = { minimal:'Минимально', low:'Низкая', medium:'Средняя', high:'Высокая', xhigh:'Очень высокая', max:'Максимальная', ultra:'Ultra', none:'Без размышлений' };
  function setEfforts(preferred) {
    const model = state.models.find(m => (m.model || m.id) === $('model').value); $('effort').replaceChildren();
    for (const e of model?.supportedReasoningEfforts || []) { const option = new Option(effortLabels[e.reasoningEffort] || e.reasoningEffort, e.reasoningEffort); option.title = e.description || ''; $('effort').add(option); }
    if (!$('effort').options.length) $('effort').add(new Option('По умолчанию', ''));
    const allowed = [...$('effort').options].map(x => x.value);
    $('effort').value = allowed.includes(preferred) ? preferred : model?.defaultReasoningEffort || allowed[0];
  }
  function models(models, preferences) {
    state.models = models; const prefs = { ...(preferences || {}), ...state.prefs }; $('model').replaceChildren();
    for (const m of models) { const option = new Option(m.displayName || m.model || m.id, m.model || m.id); option.title = m.description || ''; $('model').add(option); }
    const selected = models.find(m => (m.model || m.id) === prefs.model) || models.find(m => m.isDefault) || models[0];
    if (!selected) { $('model').add(new Option('Модели недоступны', '')); setRunning(false); return; }
    $('model').value = selected.model || selected.id; setEfforts(prefs.effort);
    setAccess(preferences?.access || 'project', preferences?.projectName || ''); setRunning(state.running);
  }
  function setAccess(access, projectName) {
    $('access').value = ['project','read','full'].includes(access) ? access : 'project';
    $('access').title = 'Доступ всех чатов проекта. Новый режим применяется к следующему сообщению.';
    $('access').setAttribute('aria-label', 'Доступ всех чатов проекта');
    $('project-access-label').textContent = projectName ? 'Доступ проекта · ' + projectName : 'Доступ для всех чатов проекта';
  }
  function attachments(items) {
    state.attachments = items; $('attachments').replaceChildren();
    for (const item of items) { const chip = document.createElement('span'); chip.className = 'chip'; if (item.preview) {
        state.assets.set(item.preview.id, item.preview); const preview = document.createElement('button'); preview.className = 'chip-preview'; preview.title = 'Просмотреть';
        if (item.preview.src) { const image = document.createElement('img'); image.src = item.preview.src; image.alt = item.name; preview.append(image); }
        else preview.textContent = '▤'; preview.onclick = () => showAsset(item.preview); chip.append(preview);
      }
      chip.append(document.createTextNode(item.name)); const remove = document.createElement('button'); remove.textContent = '×'; remove.title = 'Убрать файл'; remove.onclick = () => post('removeAttachment', { id: item.id }); chip.append(remove); $('attachments').append(chip); }
  }
  function tool(item) {
    $('welcome')?.remove();
    let view = state.tools.get(item.id);
    if (!view) {
      let group = history.lastElementChild;
      if (!group?.classList.contains('activity-group') || group.dataset.turnId !== (item.turnId || '')) {
        group = document.createElement('details'); group.className = 'activity-group'; group.dataset.turnId = item.turnId || '';
        const summary = document.createElement('summary'), children = document.createElement('div'); children.className = 'activity-items'; group.append(summary, children); history.append(group);
      }
      const details = document.createElement('details'); details.className = 'tool'; const summary = document.createElement('summary'), body = document.createElement('pre'); body.className = 'tool-body'; details.append(summary, body); group.lastElementChild.append(details);
      group.firstElementChild.textContent = 'Действия Codex · ' + group.lastElementChild.childElementCount;
      view = { details, summary, body, group }; state.tools.set(item.id, view);
    }
    const names = { commandExecution:'Команда', fileChange:'Изменение файлов', mcpToolCall:'Инструмент', dynamicToolCall:'Инструмент', toolCall:'Инструмент', webSearch:'Поиск', contextCompaction:'Сжатие контекста', collabToolCall:'Работа агента', imageView:'Просмотр изображения', imageGeneration:'Генерация изображения' };
    const statuses = { recorded:'В истории', completed:'Завершено', inProgress:'Выполняется', failed:'Ошибка', declined:'Отклонено' };
    view.summary.textContent = (names[item.type] || 'Действие') + (item.status ? ' · ' + (statuses[item.status] || item.status) : '');
    if(item.type==='fileChange' && item.text){
      const lines=item.text.split('\n'),added=lines.filter(l=>l.startsWith('+')&&!l.startsWith('+++')).length,removed=lines.filter(l=>l.startsWith('-')&&!l.startsWith('---')).length;
      view.summary.textContent+=` · +${added} −${removed}`;
      if(!view.review){view.review=document.createElement('button');view.review.className='secondary';view.review.textContent='Посмотреть изменения';view.review.onclick=()=>api.postMessage({action:'reviewChange',itemId:item.id});view.details.insertBefore(view.review,view.body);}
    }
    view.body.textContent = item.text || ''; bottom();
  }
  function request(req) {
    const box = document.createElement('section'); box.className = 'request';
    const title = document.createElement('h3'); title.textContent = req.questions?.length ? 'Codex уточняет' : req.method.includes('elicitation') ? 'Запрос подключённого сервиса' : 'Требуется разрешение'; box.append(title);
    if (req.reason) { const reason = document.createElement('p'); reason.textContent = req.reason; box.append(reason); }
    let details = [req.command, req.cwd, ...(req.files || []).map(f => f.path + '\n' + f.diff), req.permissions ? JSON.stringify(req.permissions, null, 2) : '', req.network ? JSON.stringify(req.network, null, 2) : ''].filter(Boolean).join('\n');
    if (details) { const pre = document.createElement('pre'); pre.textContent = details; box.append(pre); }
    const fields = new Map();
    for (const q of req.questions || []) {
      const label = document.createElement('label'); label.textContent = q.question; let field;
      if (q.options?.length && !q.isOther) { field = document.createElement('select'); for (const option of q.options) { const o = new Option(option.label, option.label); o.title = option.description || ''; field.add(o); } }
      else { field = document.createElement('input'); field.type = q.isSecret ? 'password' : 'text'; if (q.options?.length) field.placeholder = q.options.map(o => o.label).join(' / '); }
      label.append(field); box.append(label); fields.set(q.id, field);
    }
    const action = (label, accept, secondary, decision) => { const button = document.createElement('button'); button.textContent = label; if (secondary) button.className = 'secondary'; button.onclick = () => {
      const answers = Object.fromEntries([...fields].map(([id, field]) => [id, field.value])); post('answer', { requestId: req.requestId, answer: { accept, answers, ...(decision ? {decision} : {}) } });
    }; box.append(button); };
    if (req.questions?.length) action('Ответить', true);
    else if (req.method.includes('elicitation')) { const p = document.createElement('p'); p.textContent = 'Форма этого сервиса пока не поддерживается. Можно отклонить запрос и продолжить чат в приложении.'; box.append(p); action('Отклонить', false, true); }
    else { if (!req.availableDecisions || req.availableDecisions.includes('accept')) action('Разрешить один раз', true); if (!req.availableDecisions || req.availableDecisions.includes('decline')) action('Отклонить', false, true); if (req.availableDecisions?.includes('cancel')) action('Отменить действие', false, true, 'cancel'); }
    state.requests.get(req.requestId)?.remove(); state.requests.set(req.requestId, box); history.append(box); bottom(true);
  }
  function send(action = state.running ? 'steer' : 'send') {
    if (state.submitting || state.pasting || !state.models.length || (!input.value.trim() && !state.attachments.length)) return;
    store(); state.submitting = { text: input.value };
    setRunning(state.running);
    post(action, { text: input.value, model: $('model').value, effort: $('effort').value, attachments: state.attachments.map(a => a.id) });
  }
  $('send').onclick = () => send(); $('enqueue').onclick = () => send('enqueue'); $('stop').onclick = () => post('stop');
  $('handoff').onclick = () => {
    if (state.pasting || state.submitting) return;
    post('handoff', { text: input.value, attachments: state.attachments.map(item => item.id) });
  };
  function accepted(display) {
    $('handoff').hidden = true;
    if (state.submitting && input.value === state.submitting.text) { input.value = ''; expandInput(false); }
    state.submitting = null; store(); setRunning(state.running); updateSuggestion();
  }
  function showQueue(update) {
    const list = $('queue'); list.replaceChildren(); list.hidden = !update.items.length;
    if (!update.items.length) return;
    const title = document.createElement('div'); title.textContent = update.paused ? 'Очередь приостановлена' : 'Очередь запросов'; list.append(title);
    if (update.paused) { const resume = document.createElement('button'); resume.textContent = 'Продолжить очередь'; resume.onclick = () => post('resumeQueue'); list.append(resume); }
    for (const item of update.items) {
      const row = document.createElement('div'), text = document.createElement('span'), remove = document.createElement('button');
      text.textContent = (item.uncertain ? 'Результат неизвестен · ' : '') + (item.text || item.names.join(', ')); text.title = text.textContent;
      remove.textContent = '×'; remove.title = 'Убрать запрос из очереди'; remove.setAttribute('aria-label', remove.title); remove.onclick = () => post('removeQueued', { id: item.id });
      row.append(text);
      if (item.writerConflict) { const owner = document.createElement('button'); owner.textContent = 'В Codex'; owner.title = 'Открыть исходный чат с этим запросом; запрос останется в очереди'; owner.onclick = () => post('handoffQueued', { id: item.id }); row.append(owner); }
      row.append(remove); list.append(row);
    }
  }
  function closeMenu() { $('add-menu').hidden = true; $('attach').setAttribute('aria-expanded', 'false'); }
  function renderCatalog() {
    const list = $('catalog-list'), query = $('add-search').value.toLowerCase(); list.replaceChildren();
    for (const [kind, title] of [['plugin','Плагины'],['skill','Скиллы']]) {
      const label = document.createElement('div'); label.className = 'menu-label'; label.textContent = title; list.append(label);
      const items = state.catalog.filter(item => item.kind === kind && (item.name + ' ' + item.description).toLowerCase().includes(query));
      for (const item of items) { const button = document.createElement('button'); const name = document.createElement('span'); name.textContent = item.name; const desc = document.createElement('small'); desc.textContent = item.description; button.append(name, desc); button.onclick = () => { post('selectCatalog', { id: item.id }); closeMenu(); input.focus(); }; list.append(button); }
      if (!items.length) { const empty = document.createElement('p'); empty.className = 'menu-empty'; empty.textContent = state.catalogLoaded ? 'Нет доступных элементов' : 'Загрузка…'; list.append(empty); }
    }
    for (const error of state.catalogErrors) { const note = document.createElement('p'); note.className = 'menu-empty'; note.textContent = error; list.append(note); }
  }
  $('attach').onclick = () => {
    if (!$('add-menu').hidden) { closeMenu(); return; }
    $('add-menu').hidden = false; $('attach').setAttribute('aria-expanded','true'); renderCatalog(); $('add-search').focus();
    if (!state.catalogLoaded) post('catalog');
  };
  $('add-search').oninput = renderCatalog;
  for (const button of document.querySelectorAll('[data-add]')) button.onclick = () => { closeMenu(); post(button.dataset.add); };
  document.addEventListener('click', event => { if (!$('add-menu').contains(event.target) && !$('attach').contains(event.target)) closeMenu(); });
  let viewerAsset, viewerFocus;
  function showAsset(asset) {
    if (asset.kind !== 'image' || !asset.src) { post('openAttachment', { id: asset.id }); return; }
    viewerAsset = asset; viewerFocus = document.activeElement; $('image-full').src = asset.src; $('image-full').alt = asset.name; $('image-title').textContent = asset.name;
    $('image-open').disabled = asset.canOpen === false;
    $('viewer-canvas').classList.remove('actual-size'); $('image-viewer').hidden = false; $('image-close').focus();
  }
  function closeImage() { $('image-viewer').hidden = true; $('image-full').removeAttribute('src'); viewerFocus?.focus(); }
  $('image-close').onclick = closeImage; $('image-zoom').onclick = () => $('viewer-canvas').classList.toggle('actual-size');
  $('image-open').onclick = () => { if (viewerAsset) post('openAttachment', { id: viewerAsset.id }); };
  $('viewer-canvas').onclick = event => { if (event.target === $('viewer-canvas')) closeImage(); };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { if (!$('image-viewer').hidden) closeImage(); else { closeMenu(); input.focus(); } }
    if (event.key === 'Tab' && !$('image-viewer').hidden) { const controls = [$('image-zoom'),$('image-open'),$('image-close')].filter(button => !button.disabled), index = controls.indexOf(document.activeElement); event.preventDefault(); controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length].focus(); }
  });
  function hintFor(text) {
    if (!text.trim()) return '';
    const next = /(?:Следующий шаг|Дальше|Предлагаю)[:—\s]+([^\n]{15,220})/i.exec(text);
    return next ? 'Сделай следующий шаг: ' + next[1].replace(/[*`#]/g, '').trim() + ' После проверь результат.' : 'Продолжи работу по последнему ответу и проверь результат. Если нужен мой выбор — сначала уточни.';
  }
  function updateSuggestion() {
    const hint = hintFor(state.lastAssistant); $('suggestion').hidden = !!input.value || state.running || !hint;
    input.placeholder = hint || 'Поручите что угодно…';
  }
  function acceptSuggestion() { const hint = hintFor(state.lastAssistant); if (!input.value && hint && !state.running) { input.value = hint; input.dispatchEvent(new Event('input')); input.focus(); } }
  $('suggestion').onclick = acceptSuggestion;
  $('refresh').onclick = () => post('refresh'); $('app').onclick = () => post('app'); $('changes').onclick = () => post('changes');
  $('older-history').onclick = () => post('olderHistory');
  $('latest-history').onclick = () => post('refresh');
  $('terminal').onclick = () => post('resume');
  function expandInput(expanded) {
    document.body.classList.toggle('composer-expanded', expanded);
    $('expand-input').setAttribute('aria-expanded', String(expanded));
    $('expand-input').textContent = expanded ? 'Свернуть' : 'Развернуть';
    $('expand-input').title = expanded ? 'Свернуть поле сообщения' : 'Развернуть поле сообщения';
  }
  $('expand-input').onclick = () => { expandInput($('expand-input').getAttribute('aria-expanded') !== 'true'); input.focus(); };
  input.addEventListener('input', () => { updateSuggestion(); store(); });
  input.addEventListener('paste', async event => {
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    if (state.pasting || state.submitting) { notice('Дождитесь добавления или отправки вложений.', true); return; }
    if (files.length + state.attachments.length > 10 || files.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024) { notice('Можно вставить до 10 файлов общим размером до 50 МБ.', true); return; }
    state.pasting = true; setRunning(state.running); $('status').textContent = 'Добавляю вложения…';
    try {
      const pasted = [];
      for (const file of files) {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(new Error('Не удалось прочитать файл из буфера обмена.')); reader.readAsDataURL(file);
        });
        pasted.push({ name: file.name || (file.type === 'image/png' ? 'image.png' : 'clipboard.bin'), data });
      }
      post('pasteFiles', { files: pasted });
    } catch (error) { state.pasting = false; setRunning(state.running); notice(error.message, true); }
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Tab' && !e.shiftKey && !input.value && hintFor(state.lastAssistant) && !state.running) { e.preventDefault(); acceptSuggestion(); return; }
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    if (e.repeat) return;
    // Fn is handled only when the keyboard exposes it to the webview.
    const immediate = e.ctrlKey || e.getModifierState?.('Fn');
    send(immediate ? (state.running ? 'steer' : 'send') : 'enqueue');
  });
  $('model').onchange = () => { setEfforts(); store(); }; $('effort').onchange = store; $('access').onchange = () => post('setProjectAccess', { access: $('access').value });
  history.addEventListener('click', e => { const asset = e.target.closest('[data-asset]'); if (asset) { const item = state.assets.get(asset.dataset.asset); if (item?.available) showAsset(item); return; } const link = e.target.closest('a'); if (link) { e.preventDefault(); post('openLink', { url: link.getAttribute('href') }); } });
  window.addEventListener('message', async event => {
    const m = event.data;
    if (m.type === 'title') { document.title = m.title; $('chat-title').textContent = m.title; }
    else if (m.type === 'history') { state.renderingHistory = true; setRunning(state.running); history.replaceChildren(); state.messages.clear(); state.tools.clear(); state.requests.clear(); state.assets.clear(); state.lastAssistant = ''; state.lastAssistantId = null;
      $('history-nav').hidden = !m.hasOlder && !m.older; $('older-history').hidden = !m.hasOlder; $('latest-history').hidden = !m.older;
      if (Array.isArray(m.history.timeline)) {
        let rendered = 0;
        for (const item of m.history.timeline) { if (item.kind === 'message') message(item.role, item.text, item.id, item.attachments); else if (item.kind === 'tool') tool(item); if (++rendered % 40 === 0) await new Promise(resolve => setTimeout(resolve, 0)); }
      } else {
        for (const item of m.history.messages || []) message(item.role, item.text, item.id, item.attachments);
        for (const [index, item] of (m.history.tools || []).entries()) tool({ ...item, id: item.id || 'old-tool-' + index, status: item.status || 'recorded' });
      }
      if (m.history.note) notice(m.history.note); state.renderingHistory = false; setRunning(state.running); bottom(true);
    } else if (m.type === 'catalog') { state.catalog = m.items || []; state.catalogErrors = m.errors || []; state.catalogLoaded = true; renderCatalog(); }
    else if (m.type === 'messageAssets') { const old = state.messages.get(m.itemId); if (old) { message('assistant', old.text, m.itemId, m.attachments); bottom(); } }
    else if (m.type === 'projectAccess') setAccess(m.access, m.projectName);
    else if (m.type === 'models') models(m.models, m.preferences);
    else if (m.type === 'attachments') attachments(m.items);
    else if (m.type === 'pasteDone') { state.pasting = false; setRunning(state.running); }
    else if (m.type === 'state') setRunning(m.running);
    else if (m.type === 'delta') { const old = state.messages.get(m.itemId); message('assistant', (old?.text || '') + m.delta, m.itemId); bottom(); }
    else if (m.type === 'message') { const old = state.messages.get(m.itemId); if (m.text || !old) message('assistant', m.text || '', m.itemId); bottom(); }
    else if (m.type === 'tool') tool(m.item);
    else if (m.type === 'toolDelta') { const old = state.tools.get(m.itemId); if (old) { old.body.textContent += m.delta; bottom(); } }
    else if (m.type === 'request') { request(m.request); $('status').textContent = 'Ожидается ваш ответ'; }
    else if (m.type === 'requestResolved') { state.requests.get(m.requestId)?.remove(); state.requests.delete(m.requestId); }
    else if (m.type === 'requestsCleared') { for (const item of state.requests.values()) item.remove(); state.requests.clear(); }
    else if (m.type === 'queued') accepted(m.display);
    else if (m.type === 'queue') showQueue(m);
    else if (m.type === 'sent') {
      if (m.display) message('user', [m.display.text, ...m.display.names.map(name => '[' + name + ']')].filter(Boolean).join('\n'), 'sent-' + Date.now() + '-' + Math.random(), m.display.assets);
      if (m.source !== 'queue') accepted(m.display);
      bottom(true);
    }
    else if (m.type === 'finished') { setRunning(false); if (m.error) notice(m.error, true); else if (m.status === 'interrupted') notice('Ответ остановлен.'); input.focus(); updateSuggestion(); }
    else if (m.type === 'notice') notice(m.message);
    else if (m.type === 'error') { state.submitting = null; if (m.writerConflict) $('handoff').hidden = false; notice(m.message, true); setRunning(m.retrying ? state.running : false); }
  });
  // Exposed only for deterministic browser QA, never to outside content.
  window.__codexChat = { markdown, hintFor };
  post('ready');
})();
