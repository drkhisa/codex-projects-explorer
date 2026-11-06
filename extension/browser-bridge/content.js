'use strict';
let timer, busy = false, again = false, scanning = false;
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
  try {
    // Scroll only scrollable lists containing actual app-supplied conversation or
    // project links. No private API paths, navigation, message submission or menus.
    const areas = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      if (a.closest('[data-message-author-role], article') || !CodexOnlineReader.route(a.href)) continue;
      for (let p = a.parentElement; p && p !== document.body; p = p.parentElement) {
        if (p.scrollHeight > p.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(p).overflowY)) { areas.add(p); break; }
      }
    }
    for (const area of areas) {
      saved.set(area, area.scrollTop); area.scrollTop = 0;
      let stable = 0, previous = '';
      for (let n = 0; n < 160 && area.isConnected; n++) {
        await new Promise(resolve => setTimeout(resolve, 450));
        const result = await capture();
        if (result?.error) throw new Error(result.error);
        const mark = `${area.scrollTop}:${area.scrollHeight}`;
        stable = mark === previous ? stable + 1 : 0; previous = mark;
        if (stable >= 4) break;
        area.scrollTop += Math.max(200, area.clientHeight * .8);
      }
    }
    await capture();
    return { ok: true, note: 'Собраны отображённые списки этой страницы. Откройте остальные проекты и повторите сбор. Полнота аккаунта не подтверждена.' };
  } finally { for (const [area, top] of saved) if (area.isConnected) area.scrollTop = top; scanning = false; }
}
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!['capture','scan'].includes(message.type)) return;
  (message.type === 'scan' ? scan() : capture()).then(respond, e => respond({ error: e.message })); return true;
});
capture();
