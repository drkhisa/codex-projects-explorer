'use strict';
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
    c={...c,token:result.token};await storage.set({bridge:c});return c;
  })();try{return await reconnecting;}finally{reconnecting=null;}
}
async function request(c,path,body) {
  try{return await raw(c,path,body);}catch(e){if(e.status!==401 || !c.key)throw e;return raw(await reconnect(c),path,body);}
}
async function savePair(c, result, mode, tabId) {
  await storage.set({bridge:{port:c.port,token:result.token,key:result.key,mode,tabId},connection:{state:'connected',lastSeen:Date.now(),note:result.remembered===false?'VS Code не сохранил подключение; после перезапуска потребуется сопряжение.':''}});
}
async function health() {
  const c=await config();if(!c)return;
  try{await request(c,'/ping',{});await storage.set({connection:{state:'connected',lastSeen:Date.now()}});}
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
  if(['snapshot','canCapture'].includes(message.type)) {
    const c=await config();
    if(!c || !sender.tab || new URL(sender.url).origin!=='https://chatgpt.com' || (c.mode!=='profile' && sender.tab.id!==c.tabId))return {ignored:true};
    if(message.type==='canCapture')return {allowed:true};
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
  if(message.type==='scan'){const [tab]=await chrome.tabs.query({url:'https://chatgpt.com/*',active:true});if(!tab)throw new Error('Откройте проект ChatGPT');return chrome.tabs.sendMessage(tab.id,{type:'scan'});}
  throw new Error('Неизвестная команда');
 })().then(respond,e=>respond({error:e.message}));return true;
});
