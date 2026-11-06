'use strict';
const status=document.getElementById('status');
async function update(){const r=await chrome.runtime.sendMessage({type:'status'});status.textContent=r?.connection?.state==='connected'?'● Подключено к VS Code. Автоматическое обновление включено.':r?.paired?'○ VS Code закрыт или недоступен. Подключусь автоматически, когда он откроется.':'Подключите VS Code один раз. Дальше соединение запоминается.';}
document.getElementById('connect').onclick=()=>chrome.tabs.create({url:'vscode://damir-tools.codex-projects-explorer/online'});
document.getElementById('open').onclick=()=>chrome.tabs.create({url:'https://chatgpt.com/'});
for(const type of ['pair','scan','disconnect'])document.getElementById(type).onclick=async()=>{
 try{status.textContent='Выполняю…';const [tab]=await chrome.tabs.query({active:true,currentWindow:true});const r=await chrome.runtime.sendMessage({type,code:document.getElementById('code').value,tabId:tab?.id});if(r?.error)throw new Error(r.error);status.textContent=r?.note || 'Готово';if(type==='pair')document.getElementById('code').value='';}
 catch(e){status.textContent=e.message;}
};update().catch(()=>{status.textContent='Откройте VS Code для подключения';});
