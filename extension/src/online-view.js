'use strict';
const crypto = require('node:crypto');
const { escapeHtml: e } = require('./view');
function page(title, body, script = '') {
  const nonce = crypto.randomBytes(18).toString('hex');
  return `<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><title>${e(title)}</title><style nonce="${nonce}">
  body{color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font:14px/1.6 var(--vscode-font-family);margin:0}main{max-width:960px;padding:24px;margin:auto}h1{font-size:20px}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:6px;padding:10px 16px;margin:4px 8px 4px 0;cursor:pointer}.note{color:var(--vscode-descriptionForeground)}.notice{border:1px solid var(--vscode-panel-border);padding:12px 16px;border-radius:9px}article{padding:16px 20px;white-space:pre-wrap;overflow-wrap:anywhere;margin:20px 0}article.user{margin-left:20%;background:var(--vscode-textBlockQuote-background);border-radius:18px}code{overflow-wrap:anywhere;user-select:all}footer{position:sticky;bottom:0;background:var(--vscode-editor-background);padding:16px 0}li{margin:14px 0}
  </style></head><body><main>${body}</main><script nonce="${nonce}">const vscode=acquireVsCodeApi();${script}</script></body></html>`;
}
function renderSetup() {
  return page('Подключить ChatGPT', `<h1>ChatGPT в VS Code</h1><p>Установите браузерное расширение один раз. После подключения оно само передаёт загруженные проекты и чаты и восстанавливает соединение после перезапуска.</p>
  <button data-action="launch">Подключить браузер</button><p id="state" role="status">Нажмите кнопку — браузер подключится без копирования кодов.</p>
  <p>Браузерное расширение находится в общем установочном архиве: папка <b>browser-bridge</b> и файл <b>Codex-Projects-Browser-0.5.2.zip</b>.</p>
  <p class="note">Установка в браузер двойным кликом пока недоступна: расширение ещё не опубликовано в магазине. После публикации установщик сможет предложить установленный браузер и открыть страницу установки. ZIP не устанавливается двойным кликом.</p>
  <p class="notice">Передаётся содержимое загруженных страниц ChatGPT из этого профиля браузера. Полнота аккаунта пока не подтверждена. Отправка, модели и вложения онлайн-чатов остаются в исходном ChatGPT.</p>
  <details><summary>Резервное подключение и управление</summary><button data-action="copy">Скопировать резервный код</button><button data-action="disconnect">Отключить и забыть браузер</button></details>`, `document.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',()=>vscode.postMessage({action:b.dataset.action})));window.addEventListener('message',ev=>{if(ev.data?.type==='status')document.getElementById('state').textContent=ev.data.text;});`);
}
function renderOnline(thread, history) {
  return page(thread.name, `<h1>${e(thread.name)}</h1><p class="note">Онлайн ChatGPT · снимок из подключённой вкладки</p><div class="notice">${history ? 'Показан текст, отображённый в браузере на момент снимка. Это может быть часть переписки.' : 'Текст этого чата ещё не получен. Откройте его в подключённой вкладке ChatGPT.'} Полная история, изображения и документы доступны в исходном ChatGPT.</div>
  ${(history?.messages || []).map(m => `<article class="${m.role === 'user' ? 'user' : 'assistant'}" aria-label="${m.role === 'user' ? 'Вы' : 'ChatGPT'}">${e(m.text)}</article>`).join('')}
  <footer><button data-action="open">Продолжить в ChatGPT</button><button data-action="refresh">Обновить снимок</button><button data-action="bottom" title="К последнему сообщению">↓</button><p class="note">Отправка из VS Code для онлайн-чатов пока не подключена.${history ? ' Снимок: ' + e(new Date(history.capturedAt).toLocaleString()) : ''}</p></footer>`, `document.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',()=>{if(b.dataset.action==='bottom')window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'});else vscode.postMessage({action:b.dataset.action});}));`);
}
module.exports = { renderSetup, renderOnline };
