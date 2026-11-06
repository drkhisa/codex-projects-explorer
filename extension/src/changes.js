'use strict';
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {inside}=require('./file-tree');
const run=promisify(execFile);
const providers=new WeakMap();
async function git(root,args){return (await run('git',['--no-optional-locks','-c','core.fsmonitor=false','-C',root,...args],{encoding:'utf8',timeout:10000,maxBuffer:8*1024*1024,windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'}})).stdout;}
function porcelain(value){const parts=value.split('\0'),out=[];for(let i=0;i<parts.length;i++){const s=parts[i];if(s.length<4)continue;const code=s.slice(0,2),file=s.slice(3);let original='';if(/[RC]/.test(code))original=parts[++i]||'';out.push({code,file,original,status:code==='??'?'A':code.includes('U')||code==='AA'||code==='DD'?'!':code.includes('R')?'R':code.includes('D')?'D':code.includes('A')?'A':'M'});}return out;}
class ChangesReview {
 constructor(vscode){this.v=vscode;this.records=new Map();let shared=providers.get(vscode);if(!shared){shared={documents:new Map(),count:0};shared.registration=vscode.workspace.registerTextDocumentContentProvider?.('codex-projects-review',{provideTextDocumentContent:uri=>shared.documents.get(uri.toString())||''});providers.set(vscode,shared);}this.shared=shared;shared.count++;this.documents=shared.documents;this.provider=shared.registration;}
 async list(roots){const records=new Map(),notes=[],seen=new Set();
  for(const input of roots){try{const root=await fs.realpath(input);const repo=(await git(root,['rev-parse','--show-toplevel'])).trim();let revision='';try{revision=(await git(repo,['rev-parse','--verify','HEAD'])).trim();}catch{}
   const rows=porcelain(await git(root,['status','--porcelain=v1','-z','--untracked-files=all','--','.']));
   if(rows.length>10000)throw new Error('Слишком много изменённых файлов; используйте встроенный Source Control');
   for(const row of rows){const absolute=path.resolve(repo,row.file);if(!inside(root,absolute)||seen.has(absolute))continue;seen.add(absolute);const id=crypto.randomUUID();records.set(id,{...row,id,root,repo,revision,absolute,relative:path.relative(root,absolute),rootName:path.basename(root)});}
  }catch(e){notes.push(e.code==='ENOENT'?'Git не найден. Установите Git для сравнения с коммитом.':`Нет доступного Git-репозитория: ${path.basename(input)}. ${e.code==='ETIMEDOUT'?'Git не ответил вовремя.':''}`);}}
  this.records=records;return {files:[...records.values()].map(({id,absolute,relative,status,code,rootName})=>({id,path:absolute,relative,status,code,rootName})),notes};
 }
 async document(content,title){if(!this.provider)throw new Error('VS Code не предоставил просмотр изменений');const uri=this.v.Uri.parse(`codex-projects-review:/${crypto.randomUUID()}/${encodeURIComponent(title)}`);this.documents.set(uri.toString(),content);return uri;}
 async open(id,column){const r=this.records.get(id);if(!r)throw new Error('Список изменений обновился. Выберите файл ещё раз.');
  let before='';const old=r.original||r.file;if(r.revision && !r.code.includes('?')){try{before=await git(r.repo,['show','--no-ext-diff','--no-textconv',`${r.revision}:${old}`]);}catch(e){if(r.status!=='A')throw new Error('Исходная версия файла недоступна');}}
  if(before.includes('\0'))throw new Error('Это двоичный файл. Откройте его обычным просмотрщиком.');
  const left=await this.document(before,path.basename(old)+' · HEAD');let right;
  if(r.status==='D')right=await this.document('',path.basename(r.file)+' · удалён');
  else if((await fs.lstat(r.absolute)).isSymbolicLink())right=await this.document(await fs.readlink(r.absolute),path.basename(r.file)+' · ссылка');
  else{const real=await fs.realpath(r.absolute);if(!inside(r.root,real))throw new Error('Ссылка ведёт за пределы проекта');if(!(await fs.stat(real)).isFile())throw new Error('Для этой записи нельзя открыть текстовое сравнение');right=this.v.Uri.file(real);}
  await this.v.commands.executeCommand('vscode.diff',left,right,`${r.relative} · HEAD ↔ рабочая версия`,{viewColumn:column,preview:true});
 }
 async patch(content,title='Изменения ответа'){const uri=await this.document(content,title+'.diff');const doc=await this.v.workspace.openTextDocument(uri);if(this.v.languages?.setTextDocumentLanguage)await this.v.languages.setTextDocumentLanguage(doc,'diff');await this.v.window.showTextDocument(doc,{preview:true});}
 dispose(){if(this.closed)return;this.closed=true;this.records.clear();if(--this.shared.count===0){this.provider?.dispose();this.documents.clear();providers.delete(this.v);}}
}
module.exports={ChangesReview,porcelain};
