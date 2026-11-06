'use strict';
importScripts('reader.js');
// Remember the user's explicit pairing in this browser profile. Never read account
// credentials. The remembered key proves possession; it is not sent on reconnect.
const storage = chrome.storage.local || chrome.storage.session;
async function config() { return (await storage.get('bridge')).bridge; }
async function raw(c, path, body) {
  const response = await fetch(`http://127.0.0.1:${c.port}${path}`, { method: 'POST', credentials: 'omit', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const value = await response.json();
  if (!response.ok) { const e=new Error(value.error || `VS Code: ${response.status}`);e.status=response.status;throw e; }
  return value;
}
let reconnecting;
async function reconnect(c) {
  if(reconnecting) return reconnecting;
  reconnecting=(async()=>{
    const hello=await raw({port:c.port},'/hello',{});
    const bytes=Uint8Array.from(c.key.match(/../g),x=>parseInt(x,16));
    const key=await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const signature=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('codex-bridge:'+hello.challenge));
    const proof=[...new Uint8Array(signature)].map(x=>x.toString(16).padStart(2,'0')).join('');
    const result=await raw({port:c.port},'/restore',{proof});
    c={...c,token:result.token};await storage.set({bridge:c});discoveryStarted=false;return c;
  })();try{return await reconnecting;}finally{reconnecting=null;}
}
async function request(c,path,body) {
  try{return await raw(c,path,body);}catch(e){if(e.status!==401 || !c.key)throw e;Object.assign(c,await reconnect(c));return raw(c,path,body);}
}
let polling = false, discovering = false, discoveryStarted = false, outgoing = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ready(tabId, expected) {
  for (let n=0;n<40;n++) {
    try {
      const tab=await chrome.tabs.get(tabId);
      if(!tab.url?.startsWith('https://chatgpt.com/'))throw new Error('Вкладка покинула ChatGPT');
      if(tab.status && tab.status!=='complete'){await pause(250);continue;}
      const p=await chrome.tabs.sendMessage(tabId,{type:'probe'}), r=CodexOnlineReader.route(p?.url);
      if(p?.ready && (expected==='projects' ? /^https:\/\/chatgpt\.com\/projects\/?$/.test(p.url) : expected ? r?.id===expected || r?.projectId===expected : true)) {await pause(600);return;}
    } catch { /* Wait for the newly navigated content script, never resend a submission. */ }
    await pause(250);
  }
  throw new Error('Страница ChatGPT не загрузилась. Откройте её в браузере и повторите сбор.');
}
async function scanTab(tabId, expected) {
  await ready(tabId,expected);
  const before=(await chrome.tabs.get(tabId)).url;
  try {return await chrome.tabs.sendMessage(tabId,{type:'scan'});}
  catch(e) {
    const after=(await chrome.tabs.get(tabId)).url;
    if(after===before || !after?.startsWith('https://chatgpt.com/'))throw e;
    // A list control may navigate; retry only this read on the resulting page.
    await ready(tabId);return chrome.tabs.sendMessage(tabId,{type:'scan'});
  }
}
async function scanProjects(c) {
  if(discovering)return {state:'failed',note:'Сбор проектов уже идёт.'};
  discovering=true;discoveryStarted=true;
  let temporary;
  const status=(state,note)=>request(c,'/scan-status',{state,note});
  try {
    await status('loading','Раскрываю список проектов ChatGPT…');
    const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'});
    let tab=c.mode==='profile' ? tabs.sort((a,b)=>(b.active-a.active)||(b.lastAccessed||0)-(a.lastAccessed||0))[0] : tabs.find(t=>t.id===c.tabId);
    if(!tab)throw new Error('Откройте подключённую вкладку ChatGPT.');
    const first=await scanTab(tab.id);
    if(first?.error || !first?.ok)throw new Error(first?.error || 'Не удалось прочитать список проектов.');
    const queue=[], seen=new Set(), projects=new Set();
    const add=result=>{
      for(const value of [...(result.projects||[]),...(result.directories||[]).map(url=>({url}))]) {
        const r=CodexOnlineReader.route(value.url);
        const directory=value.url==='https://chatgpt.com/projects' || value.url==='https://chatgpt.com/projects/';
        if(!directory && r?.kind!=='project')continue;
        const key=directory?'directory':r.id;
        if(r)projects.add(r.id);
        if(!seen.has(key)){seen.add(key);queue.push({url:value.url,id:r?.id});}
      }
    };
    add(first);
    if(c.mode!=='profile') {
      const note=`В подключённой вкладке найдено проектов: ${projects.size}. Для просмотра остальных откройте каждый проект или подключите весь профиль кнопкой VS Code. Полнота аккаунта не подтверждена.`;
      await status('done',note);return {state:'done',note};
    }
    const deadline=Date.now()+100000;let visited=0;
    for(let n=0;n<queue.length && n<100 && Date.now()<deadline;n++) {
      const target=queue[n];
      await status('loading',`Найдено проектов: ${projects.size}; просмотрено страниц: ${visited}. Загружаю следующий список…`);
      if(!temporary)temporary=await chrome.tabs.create({url:target.url,active:false});
      else {
        const current=await chrome.tabs.get(temporary.id);
        if(current.active)throw new Error('Сбор остановлен: вы переключились на служебную вкладку. Снимки сохранены; повторите сбор для продолжения.');
        await chrome.tabs.update(temporary.id,{url:target.url});
      }
      const result=await scanTab(temporary.id,target.id || 'projects');
      if(result?.error || !result?.ok)throw new Error(result?.error || 'Проект не удалось прочитать.');
      add(result);visited++;
    }
    const note=`Найдено проектов: ${projects.size}; просмотрено страниц: ${visited} из ${queue.length}.${!projects.size?' Проекты не обнаружены: откройте раздел «Проекты» в ChatGPT и повторите сбор.':''}${visited<queue.length?' Достигнут предел одного прохода; откройте оставшиеся проекты вручную или повторите сбор из нужного проекта.':''} Полнота аккаунта не подтверждена; доступны только списки, которые загрузил ChatGPT.`;
    await status('done',note);return {state:'done',note};
  } catch(e) {try{await status('failed',e.message);}catch{}return {state:'failed',note:e.message};}
  finally {
    if(temporary)try{if(!(await chrome.tabs.get(temporary.id)).active)await chrome.tabs.remove(temporary.id);}catch{}
    discovering=false;
  }
}
async function sendOnline(c, command) {
  if(outgoing)return {state:'failed',note:'В браузере уже выполняется другая отправка. Дождитесь результата.'};
  outgoing=true;let dispatched=false;
  try {
    if(!/^[a-f0-9-]{36}$/.test(command.id) || typeof command.text!=='string' || !command.text.trim() || command.text.length>32000 || !Number.isFinite(command.expiresAt) || command.expiresAt<=Date.now())throw new Error('Команда отправки неверна или срок её действия истёк.');
    const target=CodexOnlineReader.route(command.url);if(target?.kind!=='chat')throw new Error('Неверная ссылка чата');
    const claims=(await storage.get('outboundClaims')).outboundClaims || [];
    if(claims.includes(command.id))return {state:'unknown',note:'Эта отправка уже передавалась браузеру. Повтор отключён; проверьте исходный чат.'};
    // The server leases each ID once. Keep recent claims across worker restarts too.
    await storage.set({outboundClaims:[...claims.slice(-199),command.id]});
    const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'});
    let tab=tabs.find(t=>(c.mode==='profile' || t.id===c.tabId) && CodexOnlineReader.route(t.url)?.kind==='chat' && CodexOnlineReader.route(t.url)?.id===target.id);
    if(!tab) {
      if(c.mode!=='profile')throw new Error('Откройте выбранный чат в подключённой вкладке ChatGPT.');
      tab=await chrome.tabs.create({url:target.url,active:false});
    }
    await ready(tab.id,target.id);
    dispatched=true;
    const result=await chrome.tabs.sendMessage(tab.id,{type:'send',id:command.id,url:target.url,text:command.text,expiresAt:command.expiresAt});
    if(!['sent','failed','unknown'].includes(result?.state))throw new Error('Вкладка не подтвердила результат');
    return result;
  }catch(e){return {state:dispatched?'unknown':'failed',note:dispatched?'После передачи формы результат не определён. Проверьте исходный ChatGPT перед повтором.':e.message};}
  finally{outgoing=false;}
}
async function poll(c) {
  if(polling)return;
  polling=true;
  let command;
  try {command=(await request(c,'/commands',{protocol:2})).command;}
  finally {polling=false;}
  if(!command)return;
  const result=command.type==='scan'?await scanProjects(c):command.type==='send'?await sendOnline(c,command):{state:'failed',note:'Неизвестная команда'};
  // No retry of the action, even if returning its result fails.
  await request(c,'/result',{id:command.id,...result});
}
async function savePair(c, result, mode, tabId) {
  discoveryStarted=false;
  await storage.set({bridge:{port:c.port,token:result.token,key:result.key,mode,tabId},connection:{state:'connected',lastSeen:Date.now(),note:result.remembered===false?'VS Code не сохранил подключение; после перезапуска потребуется сопряжение.':''}});
}
async function health() {
  const c=await config();if(!c)return;
  try{await request(c,'/ping',{});await poll(c);await storage.set({connection:{state:'connected',lastSeen:Date.now()}});}
  catch {await storage.set({connection:{state:'offline',lastSeen:Date.now()}});}
}
chrome.alarms?.create('codex-online-reconnect',{periodInMinutes:0.5});
chrome.alarms?.onAlarm.addListener(a=>{if(a.name==='codex-online-reconnect')health();});
chrome.runtime.onStartup?.addListener(health);
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 (async()=>{
  if(message.type==='autoPair') {
    const u=new URL(sender.url || '');const c=message.pair;
    if(!sender.tab || u.origin!==`http://127.0.0.1:${c?.port}` || !/^\/connect\/[a-f0-9]{48}$/.test(u.pathname) || c.v!==1 || !/^[a-f0-9]{64}$/.test(c.token))throw new Error('Неверная страница подключения');
    const result=await raw({port:c.port},'/pair',{token:c.token});
    await savePair(c,result,'profile');
    // Host permission is restricted to chatgpt.com; no global browsing access.
    const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'});
    const tab=tabs.sort((a,b)=>(b.lastAccessed||0)-(a.lastAccessed||0))[0];
    if(tab){await chrome.tabs.update(tab.id,{active:true});try{await chrome.tabs.sendMessage(tab.id,{type:'capture'});}catch{await chrome.tabs.reload(tab.id);}}
    else await chrome.tabs.create({url:'https://chatgpt.com/'});
    return {ok:true};
  }
  if(['snapshot','canCapture','tick'].includes(message.type)) {
    const c=await config();
    if(!c || !sender.tab || new URL(sender.url).origin!=='https://chatgpt.com' || (c.mode!=='profile' && sender.tab.id!==c.tabId))return {ignored:true};
    if(message.type==='canCapture')return {allowed:true};
    if(message.type==='tick') {await poll(c);if(!discoveryStarted)await scanProjects(c);return {ok:true};}
    await request(c,'/snapshot',message.snapshot);
    await storage.set({connection:{state:'connected',lastSeen:Date.now()},counts:{projects:message.snapshot.projects?.length||0,chats:message.snapshot.chats?.length||0}});return {ok:true};
  }
  if(sender.tab)throw new Error('Управление доступно только из окна расширения');
  if(message.type==='pair') {
    let c;try{c=JSON.parse(atob(message.code.trim().replace(/-/g,'+').replace(/_/g,'/')));}catch{throw new Error('Неверный код подключения');}
    if(c.v!==1 || !Number.isInteger(c.port) || c.port<1024 || c.port>65535 || !/^[a-f0-9]{64}$/.test(c.token))throw new Error('Неверный код подключения');
    const tab=await chrome.tabs.get(message.tabId);if(!tab.url?.startsWith('https://chatgpt.com/'))throw new Error('Откройте ChatGPT');
    const result=await raw({port:c.port},'/pair',{token:c.token});await savePair(c,result,'tab',tab.id);await chrome.tabs.sendMessage(tab.id,{type:'capture'});return {ok:true};
  }
  if(message.type==='disconnect'){await storage.remove('bridge');await storage.set({connection:{state:'disconnected'}});return {ok:true};}
  const c=await config();
  if(message.type==='status'){if(c)await health();return {paired:!!c,...await storage.get(['connection','counts'])};}
  if(!c)throw new Error('Нажмите «Подключить VS Code» — браузер свяжется автоматически');
  if(message.type==='scan')return scanProjects(c);
  throw new Error('Неизвестная команда');
 })().then(respond,e=>respond({error:e.message}));return true;
});
