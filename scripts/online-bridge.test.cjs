'use strict';
const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const http = require('node:http');
const Module = require('node:module');
const { OnlineStore } = require('../extension/src/online-store');
const { OnlineBridge } = require('../extension/src/online-bridge');
const reader = require('../extension/browser-bridge/reader');
const { renderOnline } = require('../extension/src/online-view');
const root = path.resolve(__dirname, '..');
const fixtureDir = path.join(root, '.local', 'online-fixtures');
fs.mkdirSync(fixtureDir, { recursive: true });
const fixture = { projectId: 'g-p-0123456789abcdef0123456789abcdef', chatId: 'synthetic-chat', text: 'Синтетический текст\n<script>не выполнять</script>' };
fs.writeFileSync(path.join(fixtureDir, 'case.json'), JSON.stringify(fixture));
const { projectId, chatId } = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'case.json')));
const projectUrl = `https://chatgpt.com/g/${projectId}-synthetic/project`, chatUrl = `https://chatgpt.com/c/${chatId}`;
const origin = 'chrome-extension://' + 'a'.repeat(32);

// Minimal synthetic DOM: the tests exercise selectors and event flow, not a real account.
class Element {
  constructor(tag, attrs = {}, text = '') { this.tagName = tag.toUpperCase(); this.attrs = attrs; this.textContent = text; this.children = []; this.parentElement = null; this.style = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.isConnected = true; this.scrollTop = 0; this.scrollHeight = this.clientHeight = 100; }
  get innerText() { return this.textContent + this.children.map(c=>c.innerText).join(''); }
  get id() { return this.attrs.id || ''; }
  get dataset() { return { action: this.attrs['data-action'] }; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  setAttribute(k,v) { this.attrs[k] = v; }
  append(...els) { for (const el of els) { el.parentElement = this; this.children.push(el); } }
  replaceChildren(...els) { this.children = []; this.append(...els); }
  matches(selector) {
    return selector.split(',').some(part => {
      const s = part.trim(); const tag = s.match(/^[\w-]+/);
      if (tag && this.tagName !== tag[0].toUpperCase()) return false;
      const id = s.match(/#([\w-]+)/); if (id && this.id !== id[1]) return false;
      for (const [, k, op, v] of s.matchAll(/\[([\w-]+)(?:(\*=|\^=|=)"([^"]*)")?\]/g)) {
        const actual = this.getAttribute(k); if (actual === null || (op === '=' && actual !== v) || (op === '*=' && !actual.includes(v)) || (op==='^=' && !actual.startsWith(v))) return false;
      }
      const cls = s.match(/\.([\w-]+)/); if (cls && !(this.attrs.class || '').split(' ').includes(cls[1])) return false;
      if (s.includes(':disabled') && !this.disabled) return false;
      return true;
    });
  }
  closest(s) { for (let p=this;p;p=p.parentElement) if (p.matches(s)) return p; return null; }
  querySelectorAll(selector) {
    const all = []; const walk = el => { for (const c of el.children) { all.push(c); walk(c); } }; walk(this);
    return all.filter(el => selector.split(',').some(part => {
      const pieces = part.trim().match(/(?:[^\s"]|"[^"]*")+/g); if (!el.matches(pieces.at(-1))) return false;
      let p=el.parentElement;
      for (let n=pieces.length-2;n>=0;n--) { while (p && !p.matches(pieces[n])) p=p.parentElement; if (!p) return false; p=p.parentElement; }
      return true;
    }));
  }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  getClientRects() { return this.hidden ? [] : [{}]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatchEvent(ev) { for (const f of this.listeners[ev.type] || []) f(ev); return true; }
  click() { if (!this.disabled) this.dispatchEvent({ type:'click' }); }
  focus() { this.doc.activeElement = this; }
}
class TextArea extends Element {
  constructor(attrs = {}) { super('textarea', attrs); this._value = ''; }
  get value() { return this._value; }
  set value(value) { this._value = value; }
}
class Document extends Element {
  constructor() { super('html'); this.documentElement=this; this.body=this; this.title='Синтетический чат — ChatGPT'; }
  getElementById(id) { return this.querySelector('#'+id); }
  createElement(tag) { return new Element(tag); }
  createRange() { return { selectNodeContents() {} }; }
  execCommand(_name, _ui, value) { this.activeElement.textContent=value; return true; }
}
const el=(tag,attrs,text)=>new Element(tag,attrs,text);
function page(href=chatUrl) {
  const doc=new Document(), nav=el('nav'), main=el('main'), form=el('form'), input=new TextArea({id:'prompt-textarea'}), button=el('button',{'data-testid':'send-button'});
  doc.append(nav,main);main.append(form);form.append(input,button);input.doc=doc;
  return {doc,nav,main,form,input,button,href,clicks:0};
}
function projectPage() {
  const p=page(projectUrl);p.main.append(el('h1',{},'Синтетический проект'),el('a',{href:chatUrl},'Синтетический чат'));
  p.nav.append(el('a',{href:'https://chatgpt.com/c/loose'},'Другой недавний чат'));return p;
}
function content(p, runtimeSend = async m => m.type==='canCapture'?{allowed:false}:{ok:true}) {
  let listener;
  const ctx=vm.createContext({ CodexOnlineReader:reader, document:p.doc, location:{href:p.href}, URL,
    Event:class { constructor(type,options){this.type=type;Object.assign(this,options);} }, HTMLTextAreaElement:TextArea,
    chrome:{runtime:{id:'synthetic-extension',sendMessage:runtimeSend,onMessage:{addListener(fn){listener=fn;}}}},
    MutationObserver:class {observe(){}}, setInterval(){},clearTimeout,
    setTimeout(fn){return setTimeout(fn,0);}, getComputedStyle(){return {overflowY:'auto'};}, getSelection(){return {removeAllRanges(){},addRange(){}}} });
  vm.runInContext(fs.readFileSync(path.join(root,'extension/browser-bridge/content.js'),'utf8'),ctx);
  return {ctx,dispatch(message,sender={id:'synthetic-extension'}) {return new Promise(resolve=>{if(!listener(message,sender,resolve))resolve(undefined);});}};
}

test('project URL variants share identity and foreign origins are rejected',()=>{
  assert.equal(reader.route(projectUrl).id,projectId);
  assert.equal(reader.route(projectUrl.replace('/project','')).id,projectId);
  assert.equal(reader.route(`https://chatgpt.com/g/${projectId}-renamed/c/${chatId}`).projectId,projectId);
  for(const bad of ['https://evil.test/c/a','https://chatgpt.com.evil.test/c/a','https://a@chatgpt.com/c/a','javascript:alert(1)'])assert.equal(reader.route(bad),null);
});
test('project main list, breadcrumbs, and repeated plain URLs retain membership without taking global recents',()=>{
  const store=new OnlineStore();store.ingest(reader.collect(projectPage().doc,projectUrl));
  const p=page();p.main.append(el('header'));p.main.children.at(-1).append(el('a',{href:projectUrl},'Проект'));p.nav.append(el('a',{href:chatUrl},'Чат'));
  store.ingest(reader.collect(p.doc,chatUrl));
  assert.equal(store.chats.get(chatId).projectId,projectId);
  assert.equal(store.chats.get('loose').projectId,'');
  assert.equal(store.projects.size,1);assert.equal(store.groups().find(g=>g.projectId===projectId).threads.length,1);
  const fresh=new OnlineStore();fresh.ingest(reader.collect(p.doc,chatUrl));assert.equal(fresh.chats.get(chatId).projectId,projectId);
  const generic=page();const section=el('section');generic.nav.append(section);section.append(el('a',{href:projectUrl},'Проект'),el('a',{href:'https://chatgpt.com/c/general'},'Общий чат'));
  assert.equal(reader.collect(generic.doc,chatUrl).chats.find(c=>c.id==='general').projectId,'');
});
test('only an explicitly labelled project group assigns nested sidebar links',()=>{
  const p=page(), heading=el('a',{href:projectUrl,id:'group-heading'},'Проект'),group=el('div',{role:'group','aria-labelledby':'group-heading'});
  p.nav.append(heading,group);group.append(el('a',{href:chatUrl},'Чат'));
  assert.equal(reader.collect(p.doc,chatUrl).chats.find(c=>c.id===chatId).projectId,projectId);
});
test('button project folders and article cards are collected while message links are excluded',()=>{
  const p=projectPage(),folder=el('div',{'data-project-id':projectId,'data-project-name':'Проект'}),card=el('article'),message=el('article',{'data-testid':'conversation-turn-4'});
  folder.append(el('a',{href:chatUrl},'Чат'));p.nav.append(folder);
  card.append(el('a',{href:'https://chatgpt.com/c/card-chat'},'Карточка чата'));p.main.append(card);
  message.append(el('a',{href:'https://chatgpt.com/c/untrusted-link'},'Ссылка в сообщении'));p.main.append(message);
  const snapshot=reader.collect(p.doc,projectUrl);assert.equal(snapshot.chats.find(c=>c.id==='card-chat').projectId,projectId);assert.ok(!snapshot.chats.some(c=>c.id==='untrusted-link'));
  const buttonOnly=page();const group=el('div',{'data-project-id':projectId,'data-project-name':'Кнопка проекта'});buttonOnly.nav.append(group);
  assert.equal(reader.collect(buttonOnly.doc,chatUrl).projects[0].id,projectId);
});
test('content scan expands only project list controls and captures newly rendered projects',async()=>{
  const p=page(), toggle=el('button',{'aria-expanded':'false'},'Проекты'),other=el('button',{},'Удалить чат');let unrelated=0;
  p.nav.append(toggle,other);toggle.addEventListener('click',()=>{toggle.setAttribute('aria-expanded','true');p.nav.append(el('a',{href:projectUrl},'Проект'));});other.addEventListener('click',()=>unrelated++);
  const c=content(p);const result=await c.dispatch({type:'scan'});assert.equal(result.ok,true);assert.equal(result.projects[0].id,projectId);assert.equal(unrelated,0);
  assert.equal(await c.dispatch({type:'scan'},{id:'foreign-extension'}),undefined);
});
test('lazy sidebar scrolling collects new project links and restores scroll position',async()=>{
  const p=page();p.nav.append(el('a',{href:projectUrl},'Первый проект'));p.nav.scrollHeight=1000;p.nav.clientHeight=200;let top=37;
  Object.defineProperty(p.nav,'scrollTop',{get:()=>top,set:value=>{top=Math.min(800,value);if(top>=200&&!p.nav.querySelector('[data-lazy]'))p.nav.append(el('a',{href:'https://chatgpt.com/g/g-p-second/project','data-lazy':'true'},'Второй проект'));}});
  const result=await content(p).dispatch({type:'scan'});assert.equal(result.projects.length,2);assert.equal(p.nav.scrollTop,37);
});
test('content sends exactly the explicit text once and reports rendered acknowledgement',async()=>{
  const p=page();p.button.addEventListener('click',()=>{p.clicks++;p.main.append(el('div',{'data-message-author-role':'user'},p.input.value.trim()));p.input.value='';});
  const c=content(p);const command={type:'send',id:crypto.randomUUID(),url:chatUrl,text:fixture.text,expiresAt:Date.now()+30000};
  assert.equal((await c.dispatch(command)).state,'sent');assert.equal((await c.dispatch(command)).state,'sent');assert.equal(p.clicks,1);
});
test('drafts, attachments, generation, wrong chat and disabled submit prevent any click',async()=>{
  for(const mode of ['draft','attachment','generation','wrong-chat','disabled']) {
    const p=page();p.button.addEventListener('click',()=>p.clicks++);
    if(mode==='draft')p.input.value='Не отправлять мой черновик';
    if(mode==='attachment')p.form.append(el('div',{'data-testid':'attachment'}));
    if(mode==='generation')p.main.append(el('button',{'data-testid':'stop-button'}));
    if(mode==='disabled')p.button.disabled=true;
    const c=content(p);const result=await c.dispatch({type:'send',id:crypto.randomUUID(),url:mode==='wrong-chat'?'https://chatgpt.com/c/another':chatUrl,text:'Явный текст',expiresAt:Date.now()+30000});
    assert.equal(result.state,'failed',mode);assert.equal(p.clicks,0,mode);
    if(mode==='draft')assert.equal(p.input.value,'Не отправлять мой черновик');
  }
});
test('unconfirmed click becomes unknown and the same command cannot click again',async()=>{
  const p=page();p.button.addEventListener('click',()=>{p.clicks++;p.input.value='';});const c=content(p);
  const command={type:'send',id:crypto.randomUUID(),url:chatUrl,text:'Явный текст',expiresAt:Date.now()+30000};
  assert.equal((await c.dispatch(command)).state,'unknown');assert.equal((await c.dispatch(command)).state,'unknown');assert.equal(p.clicks,1);
});
test('a command expiring while the form is filled never clicks later',async()=>{
  const p=page();p.button.addEventListener('click',()=>p.clicks++);const c=content(p);const start=Date.now();let checks=0;
  c.ctx.Date={now:()=>++checks<=1?start:start+1000};
  const result=await c.dispatch({type:'send',id:crypto.randomUUID(),url:chatUrl,text:'Текст с истёкшим сроком',expiresAt:start+500});
  assert.equal(result.state,'failed');assert.equal(p.clicks,0);assert.equal(p.input.value,'Текст с истёкшим сроком');
});
test('contenteditable composer submits the supplied text and a reused old message does not confirm a new send',async()=>{
  const p=page();const input=el('div',{id:'prompt-textarea',contenteditable:'true'});input.doc=p.doc;p.form.replaceChildren(input,p.button);
  p.button.addEventListener('click',()=>{p.clicks++;p.main.append(el('div',{'data-message-author-role':'user'},input.textContent));input.textContent='';});
  assert.equal((await content(p).dispatch({type:'send',id:crypto.randomUUID(),url:chatUrl,text:'Через contenteditable',expiresAt:Date.now()+30000})).state,'sent');assert.equal(p.clicks,1);
  const old=page();old.main.append(el('div',{'data-message-author-role':'user'},'Тот же текст'));
  old.button.addEventListener('click',()=>{old.main.children=old.main.children.filter(c=>c.getAttribute('data-message-author-role')!=='user');old.main.append(el('div',{'data-message-author-role':'user'},'Тот же текст'));old.input.value='';});
  assert.equal((await content(old).dispatch({type:'send',id:crypto.randomUUID(),url:chatUrl,text:'Тот же текст',expiresAt:Date.now()+30000})).state,'unknown');
});

async function paired(t,store=new OnlineStore()) {
  const bridge=new OnlineBridge(s=>store.ingest(s),{onScanStatus:s=>store.scanStatus(s)});await bridge.start();t.after(()=>bridge.dispose());
  const base=`http://127.0.0.1:${bridge.server.address().port}`;
  const call=(route,body={},headers={})=>new Promise((resolve,reject)=>{const req=http.request(base+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.end(JSON.stringify(body));});
  const {value:credentials}=await call('/pair',{token:bridge.pending.token});const auth={Authorization:`Bearer ${credentials.token}`};
  await call('/commands',{protocol:2},auth);
  return {bridge,base,store,call,auth,c:{port:bridge.server.address().port,...credentials,mode:'profile'}};
}
test('loopback validates Host, Origin, auth, size, one-time pairing and HMAC restoration',async t=>{
  const f=await paired(t);
  assert.equal((await f.call('/commands',{protocol:2},{...f.auth,Origin:'https://chatgpt.com'})).status,403);
  assert.equal((await f.call('/commands',{protocol:2},{...f.auth,Host:'evil.test'})).status,403);
  assert.equal((await f.call('/commands',{protocol:2})).status,401);
  assert.equal((await f.call('/commands',[],f.auth)).status,400);
  assert.equal((await f.call('/commands',{protocol:1},f.auth)).status,400);
  assert.equal((await f.call('/pair',{token:'0'.repeat(64)})).status,401);
  assert.equal((await f.call('/snapshot',{padding:'x'.repeat(2*1024*1024)},f.auth)).status,413);
  const hello=await f.call('/hello',{});const proof=crypto.createHmac('sha256',Buffer.from(f.c.key,'hex')).update('codex-bridge:'+hello.value.challenge).digest('hex');
  assert.equal((await f.call('/restore',{proof})).status,200);assert.equal((await f.call('/restore',{proof})).status,401);
});
test('command is leased once; unknown outcome blocks another send until explicit acknowledgement',async t=>{
  const f=await paired(t);const pending=f.bridge.execute('send',{url:chatUrl,text:'Явный текст'},150);
  const first=await f.call('/commands',{protocol:2},f.auth),second=await f.call('/commands',{protocol:2},f.auth);
  assert.equal(first.value.command.text,'Явный текст');assert.equal(second.value.command,null);
  const result=await pending;assert.equal(result.state,'unknown');
  assert.equal((await f.bridge.execute('send',{url:chatUrl,text:'Повтор'})).state,'unknown');
  assert.equal(f.bridge.acknowledge(chatUrl),true);
  const retry=f.bridge.execute('send',{url:chatUrl,text:'Новая отправка'},200);const {value:{command}}=await f.call('/commands',{protocol:2},f.auth);
  assert.equal(f.bridge.acknowledge(chatUrl),false);
  await f.call('/result',{id:command.id,state:'failed',note:'Форма занята'},f.auth);assert.equal((await retry).state,'failed');
});
test('undispatched timeout is a safe failure and never delivered later',async t=>{
  const f=await paired(t);assert.equal((await f.bridge.execute('send',{url:chatUrl,text:'Текст'},15)).state,'failed');
  assert.equal((await f.call('/commands',{protocol:2},f.auth)).value.command,null);
});

function worker(f, tabsById) {
  let listener, nextId=100;const data={bridge:f.c}, removed=[];const snapshots=[];
  const chrome={runtime:{id:'synthetic-extension',onMessage:{addListener(fn){listener=fn;}},onStartup:{addListener(){}}},alarms:{create(){},onAlarm:{addListener(){}}},storage:{local:{async get(keys){if(typeof keys==='string')return {[keys]:data[keys]};return Object.fromEntries(keys.map(k=>[k,data[k]]));},async set(value){Object.assign(data,value);},async remove(key){delete data[key];}}},tabs:{
    async query(){return [...tabsById.values()].map(p=>p.tab);},async get(id){if(!tabsById.has(id))throw new Error('closed');return tabsById.get(id).tab;},
    async create(options){const id=nextId++;const p=options.url===projectUrl?projectPage():page(options.url);attach(p,id,options.active);return p.tab;},
    async update(id,options){const p=options.url===projectUrl?projectPage():page(options.url);attach(p,id,options.active);return p.tab;},
    async remove(id){removed.push(id);tabsById.delete(id);},
    async sendMessage(id,message){return tabsById.get(id).content.dispatch(message);}
  }};
  const ctx=vm.createContext({chrome,URL,AbortSignal,TextEncoder,Uint8Array,crypto:crypto.webcrypto,Date,
    fetch:(url,options)=>fetch(url,{...options,headers:{Origin:origin,...options.headers}}),
    importScripts(){ctx.CodexOnlineReader=reader;},atob,setTimeout(fn){return setTimeout(fn,0);}});
  function attach(p,id,active=false){p.tab={id,url:p.href,active,status:'complete'};tabsById.set(id,p);p.content=content(p,message=>new Promise(resolve=>listener(message,{id:chrome.runtime.id,tab:p.tab,url:p.href},value=>{if(message.type==='snapshot')snapshots.push(message.snapshot);resolve(value);})));}
  vm.runInContext(fs.readFileSync(path.join(root,'extension/browser-bridge/worker.js'),'utf8'),ctx);
  for(const [id,p] of [...tabsById])attach(p,id,p.tab?.active);
  return {ctx,data,removed,snapshots,chrome};
}
test('both protocol sides send through the synthetic browser form without real ChatGPT requests',async t=>{
  const f=await paired(t);const p=page();p.button.addEventListener('click',()=>{p.clicks++;p.main.append(el('div',{'data-message-author-role':'user'},p.input.value));p.input.value='';});
  const w=worker(f,new Map([[1,p]]));const resultPromise=f.bridge.execute('send',{url:chatUrl,text:'Только синтетический текст'});
  await w.ctx.poll(f.c);assert.equal((await resultPromise).state,'sent');assert.equal(p.clicks,1);assert.ok(w.data.outboundClaims.length);
  const replay=await w.ctx.sendOnline(f.c,{id:w.data.outboundClaims[0],url:chatUrl,text:'Не дублировать',expiresAt:Date.now()+30000});assert.equal(replay.state,'unknown');assert.equal(p.clicks,1);
});
test('project discovery visits app-supplied pages, preserves the original tab and exposes honest status',async t=>{
  const f=await paired(t);const p=page();p.nav.append(el('a',{href:projectUrl},'Проект'));
  const tabs=new Map([[1,p]]);const w=worker(f,tabs);const scan=f.bridge.execute('scan');await w.ctx.poll(f.c);assert.equal((await scan).state,'done');
  assert.equal(f.store.projects.size,1);assert.equal(f.store.chats.get(chatId).projectId,projectId);assert.equal(f.store.chats.get('loose').projectId,'');
  assert.equal(f.store.scan.state,'done');assert.match(f.store.scan.note,/не подтверждена/);assert.equal(tabs.size,1);assert.equal(tabs.get(1).href,chatUrl);assert.equal(w.removed.length,1);
});
test('project discovery follows navigation caused by a list control without retrying any send',async t=>{
  const f=await paired(t),p=page(),tabs=new Map([[1,p]]);const w=worker(f,tabs);const original=w.chrome.tabs.sendMessage;let navigated=false;
  w.chrome.tabs.sendMessage=async(id,message)=>{if(id===1&&message.type==='scan'&&!navigated){navigated=true;await w.chrome.tabs.update(1,{url:projectUrl});throw new Error('content script navigated');}return original(id,message);};
  assert.equal((await w.ctx.scanProjects(f.c)).state,'done');assert.equal(f.store.projects.size,1);assert.equal(f.store.chats.get(chatId).projectId,projectId);
});
test('one-tab pairing scans only that tab and does not navigate or create background tabs',async t=>{
  const f=await paired(t);f.c.mode='tab';f.c.tabId=1;const p=page();p.nav.append(el('a',{href:projectUrl},'Проект'));const tabs=new Map([[1,p]]),w=worker(f,tabs);
  const result=await w.ctx.scanProjects(f.c);assert.equal(result.state,'done');assert.match(result.note,/подключённой вкладке/);assert.equal(tabs.size,1);assert.equal(w.removed.length,0);assert.equal(p.href,chatUrl);
});
test('discovery stops and retains its temporary tab when the user activates it',async t=>{
  const f=await paired(t),p=page();p.nav.append(el('a',{href:projectUrl},'Первый'),el('a',{href:'https://chatgpt.com/g/g-p-second/project'},'Второй'));
  const tabs=new Map([[1,p]]),w=worker(f,tabs),original=w.chrome.tabs.sendMessage;
  w.chrome.tabs.sendMessage=async(id,message)=>{const result=await original(id,message);if(id>=100&&message.type==='scan')tabs.get(id).tab.active=true;return result;};
  assert.equal((await w.ctx.scanProjects(f.c)).state,'failed');assert.equal(tabs.size,2);assert.equal(w.removed.length,0);assert.equal(f.store.scan.state,'failed');
});
test('online webview preserves draft on history updates and sends only on explicit submit',()=>{
  const html=renderOnline({name:'<проверка>'},{capturedAt:Date.now(),messages:[{role:'user',text:'<script>unsafe</script>'}]});
  assert.ok(html.includes('&lt;script&gt;unsafe&lt;/script&gt;'));assert.ok(!html.includes('<script>unsafe</script>'));
  const doc=new Document();for(const id of ['prompt','send','send-state','reviewed','compose','messages','captured','coverage'])doc.append(id==='prompt'?new TextArea({id}):el('div',{id}));
  const posts=[];let saved={draft:'Сохранённый черновик'},receive;
  const ctx=vm.createContext({document:doc,Date,acquireVsCodeApi:()=>({getState:()=>saved,setState:s=>{saved=s;},postMessage:m=>posts.push(m)}),window:{addEventListener(_type,fn){receive=fn;},scrollTo(){}}});
  vm.runInContext(html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1],ctx);
  receive({data:{type:'history',history:{capturedAt:Date.now(),messages:[{role:'assistant',text:'Новый ответ'}]}}});assert.equal(doc.getElementById('prompt').value,'Сохранённый черновик');assert.equal(posts.length,0);
  const submit=()=>doc.getElementById('compose').dispatchEvent({type:'submit',preventDefault(){}});submit();submit();assert.equal(posts.length,1);assert.equal(posts[0].text,'Сохранённый черновик');
  receive({data:{type:'sendResult',state:'unknown',note:'Проверить'}});submit();assert.equal(posts.length,1);assert.equal(doc.getElementById('send').disabled,true);
  receive({data:{type:'sendResult',state:'failed',note:'Проверено вручную'}});submit();assert.equal(posts.length,2);
  receive({data:{type:'sendResult',state:'sent',text:'Сохранённый черновик',note:'Появилось'}});assert.equal(doc.getElementById('prompt').value,'');
});
test('VS Code host keeps a single send in flight and updates history without recreating the webview',async()=>{
  let receive,html='',renders=0,resolveSend;const posts=[],calls=[];
  const panel={title:'Чат',webview:{get html(){return html;},set html(value){html=value;renders++;},postMessage:m=>posts.push(m),onDidReceiveMessage:fn=>{receive=fn;}},onDidDispose(){}};
  const vscode={window:{createWebviewPanel:()=>panel},ViewColumn:{One:1}};
  const originalLoad=Module._load;delete require.cache[require.resolve('../extension/src/extension')];mock.method(Module,'_load',function(id,...args){return id==='vscode'?vscode:originalLoad.call(this,id,...args);});
  const {Controller}=require('../extension/src/extension');mock.restoreAll();
  const store=new OnlineStore();store.ingest(reader.collect(page().doc,chatUrl));
  const controller=Object.assign(Object.create(Controller.prototype),{onlinePanels:new Map(),online:store,onlineBridge:{connected:true,execute:(...args)=>{calls.push(args);return new Promise(r=>{resolveSend=r;});},acknowledge:()=>true}});
  controller.openOnlineChat({onlineId:chatId,name:'Чат',url:chatUrl});
  const send=receive({action:'send',text:'Один явный текст'});await receive({action:'send',text:'Дубликат'});assert.equal(calls.length,1);assert.equal(calls[0][1].url,chatUrl);
  store.conversations.set(chatId,{messages:[{role:'assistant',text:'Обновление'}]});controller.updateOnlineStatus();assert.equal(renders,1);assert.equal(posts.at(-1).type,'history');
  resolveSend({state:'unknown',note:'Нужна проверка'});await send;assert.equal(posts.at(-1).state,'unknown');assert.equal(panel.onlineSending,false);
  await receive({action:'reviewed'});assert.equal(posts.at(-1).state,'failed');
});
test('activity indicator reaches categories, projects and loose-chat parent and clears on idle',()=>{
  const vscode={TreeItem:class {constructor(label){this.label=label;}},ThemeIcon:class {constructor(id){this.id=id;}},TreeItemCollapsibleState:{Collapsed:1,Expanded:2},EventEmitter:class {event(){} fire(){} dispose(){}}};
  const originalLoad=Module._load;delete require.cache[require.resolve('../extension/src/extension')];mock.method(Module,'_load',function(id,...args){return id==='vscode'?vscode:originalLoad.call(this,id,...args);});
  const {ProjectsTree}=require('../extension/src/extension');mock.restoreAll();
  const tree=new ProjectsTree(),thread={id:'active',running:true},group={id:'p',name:'Папка',origin:'configured',paths:[],threads:[thread]},category={id:'c',name:'Категория',threads:[thread]};
  for(const running of [true,false]) {
    thread.running=running;
    assert.equal(tree.getTreeItem({kind:'category',group,category}).iconPath.id,running?'loading~spin':'folder');
    assert.equal(tree.getTreeItem({kind:'project',group}).iconPath.id,running?'loading~spin':'project');
    assert.equal(tree.getTreeItem({kind:'chat',thread}).iconPath.id,running?'loading~spin':'comment-discussion');
    tree.groups=[{...group,origin:'inferred'}];assert.equal(tree.getTreeItem({kind:'unassigned'}).iconPath.id,running?'loading~spin':'folder-library');
    assert.equal(tree.getTreeItem({kind:'category',group,category:{...category,threads:[]}}).iconPath.id,'folder');
    tree.onlineGroups=[group];assert.equal(tree.getTreeItem({kind:'onlineRoot'}).iconPath.id,running?'loading~spin':'globe');
  }
});
