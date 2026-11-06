'use strict';
let timer, busy = false, again = false, scanning = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function capture() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    if (!(await chrome.runtime.sendMessage({type:'canCapture'}))?.allowed) return { ignored: true };
    return await chrome.runtime.sendMessage({ type: 'snapshot', snapshot: CodexOnlineReader.collect(document, location.href) });
  }
  catch { /* VS Code/browser may have closed; keep page interaction unaffected. */ }
  finally { busy = false; if (again) { again = false; schedule(); } }
}
function schedule() { clearTimeout(timer); timer = setTimeout(capture, 900); }
new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
setInterval(capture, 30000);
let wasGenerating = false;
setInterval(()=>{const active=CodexOnlineReader.generating(document);if(active || wasGenerating)capture();wasGenerating=active;},2000);
async function scan() {
  if (scanning) return { error: 'Сбор уже идёт' };
  scanning = true;
  const saved = new Map();
  const projects = new Map(), directories = new Set();
  const remember = () => {
    for (const p of CodexOnlineReader.collect(document, location.href).projects) projects.set(p.id, p);
    for (const a of document.querySelectorAll('nav a[href], aside a[href], [role="navigation"] a[href]')) {
      const u = new URL(a.getAttribute('href'), location.href);
      if (u.origin === 'https://chatgpt.com' && /^\/projects\/?$/.test(u.pathname)) directories.add(u.origin + u.pathname);
    }
  };
  try {
    // Expand only named navigation/list controls, never conversation menus.
    for (let n = 0; n < 20; n++) {
      const button = [...document.querySelectorAll('button')].find(b => {
        if (!CodexOnlineReader.visible(b) || b.disabled || CodexOnlineReader.inMessage(b)) return false;
        const label = (b.getAttribute('aria-label') || CodexOnlineReader.text(b)).trim();
        if (/^(Open sidebar|Открыть боковую панель)$/i.test(label)) return true;
        if (!b.closest('nav, aside, [role="navigation"], main, [role="main"]')) return false;
        return (/^(Projects|Проекты)$/i.test(label) && b.getAttribute('aria-expanded') === 'false') ||
          (b.getAttribute('aria-expanded') === 'false' && !!b.closest('[data-project-id], [data-testid="project-folder"]')) ||
          (/^(See (?:all|more) projects|Show (?:all|more) projects|Показать (?:все|ещё|еще) проекты|Все проекты)$/i.test(label)) ||
          ((!!b.closest('nav, aside, [role="navigation"]') || CodexOnlineReader.route(location.href)?.kind === 'project') && /^(Load more|Show more|See more|See all|Загрузить ещё|Загрузить еще|Показать ещё|Показать еще|Показать больше|Показать все)$/i.test(label));
      });
      if (!button) break;
      button.click(); await pause(450); remember(); await capture();
    }
    remember();
    const areas = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      if (CodexOnlineReader.inMessage(a) || !CodexOnlineReader.route(a.getAttribute('href'),location.href)) continue;
      for (let p = a.parentElement; p && p !== document.body; p = p.parentElement) {
        if (p.scrollHeight > p.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(p).overflowY)) { areas.add(p); break; }
      }
    }
    const main = document.querySelector('main, [role="main"]');
    if (CodexOnlineReader.route(location.href)?.kind === 'project' && main?.scrollHeight > main?.clientHeight + 20) areas.add(main);
    const deadline = Date.now() + 25000;
    for (const area of areas) {
      saved.set(area, area.scrollTop); area.scrollTop = 0;
      let stable = 0, previous = '';
      for (let n = 0; n < 80 && area.isConnected && Date.now() < deadline; n++) {
        await pause(450); remember();
        const result = await capture();
        if (result?.error) throw new Error(result.error);
        const mark = `${area.scrollTop}:${area.scrollHeight}`;
        stable = mark === previous ? stable + 1 : 0; previous = mark;
        if (stable >= 4) break;
        area.scrollTop += Math.max(200, area.clientHeight * .8);
      }
    }
    await capture();
    return { ok: true, projects: [...projects.values()], directories: [...directories], note: 'Собраны доступные списки страницы; полнота аккаунта не подтверждена.' };
  } finally { for (const [area, top] of saved) if (area.isConnected) area.scrollTop = top; scanning = false; }
}
let sending = false;
const sent = new Map();
async function send(command) {
  if (sent.has(command.id)) return sent.get(command.id);
  if (sending) return { state: 'failed', note: 'В этой вкладке уже идёт отправка.' };
  const target = CodexOnlineReader.route(command.url), current = CodexOnlineReader.route(location.href);
  if (target?.kind !== 'chat' || current?.kind !== 'chat' || target.id !== current.id || typeof command.text !== 'string' || !command.text.trim() || command.text.length > 32000 || !Number.isFinite(command.expiresAt) || command.expiresAt<=Date.now())
    return { state: 'failed', note: 'Вкладка или сообщение не совпадает с выбранным онлайн-чатом.' };
  sending = true;
  let clicked = false;
  // Claim before touching the composer; this request is never submitted twice.
  sent.set(command.id, { state: 'unknown', note: 'Исход отправки не определён. Проверьте исходный ChatGPT.' });
  try {
    const input = CodexOnlineReader.composer(document);
    if (!CodexOnlineReader.visible(input) || input.disabled || input.getAttribute('contenteditable') === 'false') throw new Error('Форма ChatGPT недоступна. Откройте исходный чат.');
    if (CodexOnlineReader.generating(document)) throw new Error('В ChatGPT ещё формируется ответ. Дождитесь завершения.');
    const form = input.closest('form') || input.parentElement;
    if (CodexOnlineReader.draft(input).trim() || form?.querySelector('[data-testid*="attachment"], [data-testid*="file"], [data-state="uploading"], img, input[type="file"]:disabled'))
      throw new Error('В исходной форме уже есть текст или вложение. Сначала завершите его в браузере.');
    const userText = el => CodexOnlineReader.text(el.querySelector('.whitespace-pre-wrap') || el);
    const before = new Set([...document.querySelectorAll('[data-message-author-role="user"]')]);
    const matchingBefore = [...before].filter(el=>userText(el)===command.text.trim()).length;
    input.focus();
    if (input.tagName === 'TEXTAREA') {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, command.text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const selection = getSelection(), range = document.createRange(); range.selectNodeContents(input); selection.removeAllRanges(); selection.addRange(range);
      if (!document.execCommand('insertText', false, command.text)) throw new Error('Браузер не смог заполнить форму ChatGPT.');
    }
    await pause(250);
    if (CodexOnlineReader.route(location.href)?.id !== target.id || CodexOnlineReader.draft(input).replace(/\r\n/g, '\n').trim() !== command.text.replace(/\r\n/g, '\n').trim())
      throw new Error('Текст формы изменился. Проверьте его в исходном ChatGPT; автоматическая отправка отменена.');
    const button = document.querySelector('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Отправить запрос"], button[aria-label="Send message"], button[aria-label="Отправить сообщение"]');
    if (command.expiresAt<=Date.now()) throw new Error('Срок отправки истёк. Текст оставлен в браузере; нажатие отправки отменено.');
    if (!CodexOnlineReader.visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true' || CodexOnlineReader.generating(document)) throw new Error('Кнопка отправки ChatGPT недоступна. Текст оставлен в браузере.');
    clicked = true; button.click();
    for (let n = 0; n < 40; n++) {
      await pause(500);
      if (CodexOnlineReader.route(location.href)?.id !== target.id) break;
      const matching = [...document.querySelectorAll('[data-message-author-role="user"]')].filter(el=>userText(el)===command.text.trim());
      const added = matching.length > matchingBefore && matching.some(el=>!before.has(el));
      if (added && !CodexOnlineReader.draft(input).trim()) {
        const result = { state: 'sent', note: 'Сообщение появилось в исходном ChatGPT. Ответ обновляется снимками; сохранение на сервере отдельно не проверялось.' };
        sent.set(command.id, result); await capture(); return result;
      }
    }
    return sent.get(command.id);
  } catch (e) {
    const result = { state: clicked ? 'unknown' : 'failed', note: clicked ? 'После нажатия отправки результат не подтверждён. Проверьте исходный ChatGPT перед повтором.' : e.message };
    sent.set(command.id, result); return result;
  } finally { sending = false; }
}
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (_sender.id !== chrome.runtime.id || _sender.tab || !['capture','scan','send','probe'].includes(message.type)) return;
  const action = message.type === 'probe' ? Promise.resolve({ url: location.href, ready: !!document.querySelector('main, [role="main"]') }) : message.type === 'send' ? send(message) : message.type === 'scan' ? scan() : capture();
  action.then(respond, e => respond({ error: e.message })); return true;
});
// Also notice SPA navigation without a DOM mutation, and poll authenticated commands.
let previousUrl = location.href;
setInterval(() => { if (location.href !== previousUrl) { previousUrl = location.href; schedule(); } chrome.runtime.sendMessage({type:'tick'}).catch(()=>{}); }, 2000);
capture();
