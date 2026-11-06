'use strict';
(async()=>{
 if(location.hostname!=='127.0.0.1' || !/^\/connect\/[a-f0-9]{48}$/.test(location.pathname))return;
 const data=document.getElementById('codex-bridge-pair');if(!data)return;
 const state=document.getElementById('state'),details=document.getElementById('details');
 try{const result=await chrome.runtime.sendMessage({type:'autoPair',pair:JSON.parse(data.textContent)});if(result?.error)throw new Error(result.error);state.textContent='Подключено. ChatGPT открыт.';details.textContent='Дальше всё автоматически: проекты и текст открытых чатов передаются в VS Code. При перезапусках соединение восстановится само.';}
 catch(e){state.textContent='Не удалось подключиться';details.textContent=e.message+' Нажмите «Подключить браузер» в VS Code ещё раз.';}
})();
