import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";
import {createServer} from "node:net";
import {setTimeout as delay} from "node:timers/promises";
import path from "node:path";
import {encrypt} from "../lib/secrets.ts";

const preview=process.argv.includes("--preview"),temp=mkdtempSync(path.join(tmpdir(),"planner-tasks-http-"));
const reservation=createServer();await new Promise((r,j)=>reservation.once("error",j).listen(preview?3102:0,"127.0.0.1",r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const origin=`http://127.0.0.1:${port}`,database=path.join(temp,"test.db");
process.env.TOKEN_ENCRYPTION_KEY="ac".repeat(32);
const db=new DatabaseSync(database);db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");
const insert=db.prepare("INSERT INTO settings(key,value) VALUES (?,?)");
for(const provider of ["google","microsoft"]){insert.run(`${provider}_refresh_token`,encrypt("synthetic-refresh"));insert.run(`${provider}_account_id`,`${provider}-account`);insert.run(`${provider}_account`,"Testinė paskyra");insert.run(`${provider}_connection_generation`,`${provider}-fixture`);}
insert.run("google_granted_scopes","https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/calendar");db.close();
const env={...process.env,DATABASE_PATH:database,APP_ORIGIN:origin,PORT:String(port),HOSTNAME:"127.0.0.1",TASKS_TEST_FIXTURE:"isolated"};
for(const provider of ["GOOGLE","MICROSOFT"]){env[`${provider}_CLIENT_ID`]="synthetic-client";env[`${provider}_CLIENT_SECRET`]="synthetic-secret";env[`${provider}_REDIRECT_URI`]=`${origin}/api/${provider.toLowerCase()}/callback`;}
const child=spawn(process.execPath,["--import",path.resolve("tests/fixtures/tasks-upstream.mjs"),"scripts/start.mjs"],{env,stdio:"ignore"});
const stopped=new Promise(r=>child.once("exit",r));
try {
  let ready=false;for(let i=0;i<80;i++){if(child.exitCode!==null)throw new Error("Fixture server failed");try{ready=(await fetch(origin)).ok;}catch{}if(ready)break;await delay(150);}assert.ok(ready);
  const headers={Origin:origin,"Content-Type":"application/json"},api=`${origin}/api/tasks`;
  const result=await (await fetch(api+"?envelope=1")).json();assert.equal(result.lists.length,2);assert.equal(result.items.length,2);assert.deepEqual(result.warnings,[]);
  for(const source of ["local","google","microsoft"]){
    const remote=source!=="local", due=source==="google"?{due_date:"2026-10-25"}:{due_at:"2026-10-25T08:00:00.000Z"};
    const response=await fetch(api,{method:"POST",headers,body:JSON.stringify({source,title:`HTTP ${source}`,...due,...(remote?{account_id:`${source}-account`,list_id:`${source}-list`}:{})})});assert.equal(response.status,201);let task=await response.json();
    const patch=async changes=>{const r=await fetch(api,{method:"PATCH",headers,body:JSON.stringify({id:task.id,source,account_id:task.account_id,list_id:task.list_id,schedule_version:task.schedule_version,...changes})});assert.equal(r.status,200);task=await r.json();};
    await patch({scheduled_at:"2026-10-26T10:00:00.000Z",duration_minutes:60});
    await patch({scheduled_at:"2026-10-27T12:00:00.000Z",duration_minutes:90});
    assert.equal(task.due_date||task.due_at,due.due_date||due.due_at);
    await patch({completed:true});assert.equal(task.scheduled_at,null);
    await patch({completed:false});assert.equal(task.scheduled_at,null);
    const query=new URLSearchParams({id:String(task.id),source,...(remote?{account_id:task.account_id,list_id:task.list_id}:{})});
    assert.equal((await fetch(api+"?"+query,{method:"DELETE",headers})).status,200);
  }
  const listsApi=`${origin}/api/task-lists`;
  const catalog=await (await fetch(listsApi)).json();assert.equal(catalog.lists.length,2);assert.equal(catalog.accounts.length,2);assert.deepEqual(catalog.warnings,[]);
  const microsoftDefault=catalog.lists.find(list=>list.source==="microsoft"),googleDefault=catalog.lists.find(list=>list.source==="google");
  assert.equal(microsoftDefault.can_delete,false);assert.equal(googleDefault.can_delete,true);
  assert.equal((await fetch(listsApi,{method:"POST",headers:{...headers,Origin:"https://attacker.example"},body:JSON.stringify({source:"google",account_id:"google-account",name:"Užblokuota"})})).status,403);
  for(const source of ["google","microsoft"]){
    const account_id=`${source}-account`;
    const createdResponse=await fetch(listsApi,{method:"POST",headers,body:JSON.stringify({source,account_id,name:`HTTP ${source} sąrašas`})});assert.equal(createdResponse.status,201);const created=await createdResponse.json();
    const renamedResponse=await fetch(listsApi,{method:"PATCH",headers,body:JSON.stringify({source,account_id,list_id:created.list_id,version:created.version,name:`HTTP ${source} pervadintas`})});assert.equal(renamedResponse.status,200);const renamed=await renamedResponse.json();
    assert.equal((await fetch(listsApi,{method:"PATCH",headers,body:JSON.stringify({source,account_id,list_id:created.list_id,version:created.version,name:"Pasenęs"})})).status,409);
    const deletion=await (await fetch(`${listsApi}?${new URLSearchParams({source,account_id,list_id:renamed.list_id})}`)).json();assert.equal(deletion.task_count,0);assert.equal(typeof deletion.confirmation,"string");
    const deleted=await fetch(listsApi,{method:"DELETE",headers,body:JSON.stringify({source,account_id,list_id:renamed.list_id,version:renamed.version,confirmation:deletion.confirmation,confirm_name:renamed.name})});assert.equal(deleted.status,200);
  }
  const afterLists=await (await fetch(listsApi)).json();assert.ok(afterLists.lists.some(list=>list.list_id===microsoftDefault.list_id));assert.ok(afterLists.lists.some(list=>list.list_id===googleDefault.list_id));
  assert.equal((await (await fetch(origin+"/api/google/status")).json()).tasksConnected,true);
  console.log(`OK: vietinių, Google ir Microsoft užduočių bei sąrašų HTTP kūrimas, planavimas, pervadinimas, peržiūra ir trynimas. ${origin}`);
  if(preview)await new Promise(resolve=>{process.once("SIGINT",resolve);process.once("SIGTERM",resolve);});
} finally {child.kill("SIGTERM");await stopped;rmSync(temp,{recursive:true,force:true});}
