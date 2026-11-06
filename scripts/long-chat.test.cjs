'use strict';
const assert=require('node:assert/strict');const {test,mock}=require('node:test');const fs=require('node:fs/promises');const path=require('node:path');
const {RolloutActivity}=require('../extension/src/activity');const {Backend}=require('../extension/src/backend');
const local=path.resolve(__dirname,'../.local/tmp');
const row=(type,at,payload={})=>JSON.stringify({type:'event_msg',timestamp:new Date(at).toISOString(),payload:{type,...payload}})+'\n';
async function fixture(run){await fs.mkdir(local,{recursive:true});const root=await fs.mkdtemp(path.join(local,'long-chat-'));try{await run(path.join(root,'synthetic.jsonl'));}finally{assert.ok(root.startsWith(local+path.sep));await fs.rm(root,{recursive:true,force:true});}}
test('active lifecycle before a large tool output is recovered and later completion clears it',async()=>fixture(async file=>{
 const now=Date.now(), reader=new RolloutActivity();
 await fs.writeFile(file,row('task_started',now,{turn_id:'turn-рус'})+JSON.stringify({type:'response_item',timestamp:new Date(now).toISOString(),payload:{type:'message',text:'x'.repeat(1500000)}})+'\n'+row('token_count',now));
 const active=await reader.read(file,now);assert.equal(active.running,true);assert.equal(active.turnId,'turn-рус');
 await fs.appendFile(file,row('task_complete',now+1,{turn_id:'turn-рус'}));assert.equal((await reader.read(file,now+2)).state,'idle');
}));
test('newest lifecycle wins across a long tail and old activity stays unconfirmed',async()=>fixture(async file=>{
 const now=Date.now(),reader=new RolloutActivity();
 await fs.writeFile(file,row('task_started',now-5000,{turn_id:'old'})+row('task_complete',now-4000,{turn_id:'old'})+(' '.repeat(2048)+'\n').repeat(600)+row('token_count',now));
 assert.equal((await reader.read(file,now)).state,'idle');
 await fs.writeFile(file,row('task_started',now-300000,{turn_id:'stale'})+(' '.repeat(2048)+'\n').repeat(600)+row('token_count',now-300000));
 const stale=await new RolloutActivity().read(file,now);assert.equal(stale.running,false);assert.equal(stale.state,'unknown');
}));
test('an incomplete trailing lifecycle does not override a complete terminal record',async()=>fixture(async file=>{
 const now=Date.now();await fs.writeFile(file,row('task_complete',now,{turn_id:'closed'})+(' '.repeat(2048)+'\n').repeat(600)+row('task_started',now,{turn_id:'partial'}).slice(0,-3));
 assert.equal((await new RolloutActivity().read(file,now)).state,'idle');
}));
test('an oversized lifecycle is unknown rather than incorrectly reviving an earlier active turn',async()=>fixture(async file=>{
 const now=Date.now();await fs.writeFile(file,row('task_started',now,{turn_id:'closed'})+row('task_complete',now,{turn_id:'closed',last_agent_message:'x'.repeat(1500000)})+row('token_count',now));
 const result=await new RolloutActivity().read(file,now);assert.equal(result.running,false);assert.equal(result.state,'unknown');
}));
test('unchanged unknown logs do not rescan their full contents on every activity poll',async()=>fixture(async file=>{
 const now=Date.now(),reader=new RolloutActivity();await fs.writeFile(file,(' '.repeat(2048)+'\n').repeat(600)+row('token_count',now));
 const open=fs.open;let bytes=0;
 mock.method(fs,'open',async(...args)=>{const handle=await open(...args);return{stat:()=>handle.stat(),close:()=>handle.close(),read:async(...readArgs)=>{bytes+=readArgs[2];return handle.read(...readArgs);}};});
 try {
   await reader.read(file,now);const first=bytes;await reader.read(file,now);assert.ok(bytes-first<=512,'An unchanged poll must only check the fingerprint');
   await fs.appendFile(file,row('task_started',now,{turn_id:'new'}));assert.equal((await reader.read(file,now)).running,true);
 } finally {mock.restoreAll();}
}));
test('history loads one recent page in chronological order and passes older cursor explicitly',async()=>{
 const calls=[];const rpc={start:async()=>{},request:async(method,params)=>{calls.push({method,params});return params.cursor?{data:[{id:'old',items:[{id:'old-m',type:'agentMessage',text:'Old'}]}],nextCursor:null}:{data:[{id:'new',items:[{id:'new-m',type:'agentMessage',text:'New'}]},{id:'middle',items:[{id:'mid-m',type:'agentMessage',text:'Middle'}]}],nextCursor:'older'};}};
 const backend=new Backend({dataSource:'appServer',executable:'synthetic',home:local,rpcFactory:()=>rpc});
 const recent=await backend.history({id:'synthetic'});assert.deepEqual(recent.messages.map(item=>item.text),['Middle','New']);assert.equal(recent.olderCursor,'older');assert.equal(calls.length,1);assert.equal(calls[0].params.sortDirection,'desc');assert.equal(calls[0].params.limit,20);
 const older=await backend.history({id:'synthetic'},{cursor:recent.olderCursor});assert.equal(older.messages[0].text,'Old');assert.equal(calls[1].params.cursor,'older');
});
