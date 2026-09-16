import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {createTaskService,migrateTaskPlanning} from "../lib/task-service.ts";

function setup(t) {
  const dir=mkdtempSync(path.join(tmpdir(),"google-task-plans-")), file=path.join(dir,"test.db");
  let db=new DatabaseSync(file);
  db.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,notes TEXT DEFAULT '',due_at TEXT,
      duration_minutes INTEGER DEFAULT 30,completed INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      project TEXT DEFAULT 'Asmeniniai',priority TEXT DEFAULT 'normal',energy TEXT DEFAULT 'medium',tags TEXT DEFAULT '');`);
  migrateTaskPlanning(db);
  const calls=[], lists=new Map([["list-a",new Map([["1",{id:"1",title:"Google užduotis",due:"2026-10-25T00:00:00.000Z",status:"needsAction",webViewLink:"https://tasks.google.com/task/1"}]])]]);
  const state={account:"account-a",connected:true,offline:false,failedList:null};
  const google={connected:()=>state.connected,cachedAccountId:()=>state.account,accountId:async()=>state.account,
    async request(raw,init={}) {
      const url=new URL(raw,"https://fixture.invalid"),method=init.method||"GET",body=init.body?JSON.parse(init.body):undefined;
      calls.push({path:raw,method,body});
      if(state.offline)throw Error("offline");
      if(url.pathname==="/users/@me/lists")return {items:[...lists.keys()].map(id=>({id,title:id}))};
      const [, ,listId, ,taskId]=url.pathname.split("/").map(decodeURIComponent),list=lists.get(listId);
      if(!list || state.failedList===listId)throw Error("list unavailable");
      if(method==="GET")return {items:structuredClone([...list.values()])};
      if(method==="POST") {const task={id:String(list.size+1),status:"needsAction",...body};list.set(task.id,task);return structuredClone(task);}
      if(method==="PATCH") {Object.assign(list.get(taskId),body);return structuredClone(list.get(taskId));}
      if(method==="DELETE") {list.delete(taskId);return null;}
      throw Error("unexpected method");
    }};
  const microsoft={connected:()=>false,cachedAccountId:()=>null,accountId:async()=>{throw Error("disconnected");},request:async()=>{throw Error("unexpected Microsoft call");}};
  let service=createTaskService(db,microsoft,google);
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  return {get service(){return service;},google,state,lists,calls,
    restart(){db.close();db=new DatabaseSync(file);migrateTaskPlanning(db);service=createTaskService(db,microsoft,google);return service;}};
}
const ref=t=>({source:t.source,account_id:t.account_id,list_id:t.list_id,id:t.id,schedule_version:t.schedule_version});
const start="2026-10-25T08:00:00.000Z";

test("Google date-only day stays distinct through planning, moving, resizing, restart and unscheduling",async t=>{
  const f=setup(t);let task=(await f.service.list()).items[0];
  assert.equal(task.due_date,"2026-10-25");assert.equal(task.due_at,null);assert.equal(task.scheduled_at,null);
  f.calls.length=0;
  task=await f.service.update({...ref(task),scheduled_at:start});
  task=await f.service.update({...ref(task),scheduled_at:"2026-10-26T10:00:00+02:00",duration_minutes:75,priority:"high",project:"Darbas",tags:"svarbu"});
  assert.equal(f.calls.length,0);
  f.restart();task=(await f.service.list()).items[0];
  assert.equal(task.scheduled_at,"2026-10-26T08:00:00.000Z");assert.equal(task.duration_minutes,75);
  assert.equal(task.due_date,"2026-10-25");assert.equal(task.priority,"high");assert.equal(task.tags,"svarbu");assert.equal(task.project,"Darbas");
  task=await f.service.update({...ref(task),scheduled_at:null});
  assert.equal(task.scheduled_at,null);assert.equal(task.due_date,"2026-10-25");assert.ok(f.calls.every(c=>c.method==="GET"));
});

test("Google explicit list CRUD only writes supported fields and restores as unplanned",async t=>{
  const f=setup(t);let task=await f.service.create({source:"google",account_id:"account-a",list_id:"list-a",title:"Nauja",notes:"Pastaba",due_date:"2026-10-26",duration_minutes:60,priority:"high",tags:"tik čia"});
  assert.deepEqual(f.calls.find(c=>c.method==="POST").body,{title:"Nauja",notes:"Pastaba",due:"2026-10-26T00:00:00.000Z"});
  assert.equal(task.due_at,null);assert.equal(task.scheduled_at,null);assert.equal(task.priority,"high");
  task=await f.service.update({...ref(task),scheduled_at:start});
  task=await f.service.update({...ref(task),completed:true});assert.equal(task.scheduled_at,null);
  task=await f.service.update({...ref(task),completed:false,due_date:null,notes:"Kita"});
  assert.equal(task.completed,0);assert.equal(task.scheduled_at,null);assert.equal(task.due_date,null);
  assert.deepEqual(f.calls.filter(c=>c.method==="PATCH").map(c=>c.body),[{status:"completed"},{notes:"Kita",status:"needsAction",due:null}]);
  await f.service.remove(ref(task));assert.equal(f.lists.get("list-a").has(task.id),false);
});

test("Google rejects invalid date-only values, exact due times, stale plans and mismatched destinations before writes",async t=>{
  const f=setup(t);let task=(await f.service.list()).items[0];f.calls.length=0;
  for(const patch of [{due_date:"2026-02-30"},{due_date:"2026-10-25T10:00:00Z"},{due_at:start}])await assert.rejects(f.service.update({...ref(task),...patch}),e=>e.status===400);
  for(const input of [{due_at:start},{due_date:"2026-02-30"},{list_id:undefined},{account_id:"account-b"}])await assert.rejects(f.service.create({source:"google",account_id:"account-a",list_id:"list-a",title:"X",...input}));
  const stale=ref(task);task=await f.service.update({...ref(task),scheduled_at:start});
  await assert.rejects(f.service.update({...stale,duration_minutes:90}),e=>e.status===409);assert.equal(f.calls.length,0);
});

test("Google multi-list identities, partial failures and removed lists preserve only applicable snapshots",async t=>{
  const f=setup(t);f.lists.set("list-b",new Map([["1",{id:"1",title:"Kitas sąrašas"}]]));
  let result=await f.service.list();assert.equal(result.lists.length,2);assert.equal(new Set(result.items.map(t=>t.key)).size,2);
  let task=result.items.find(t=>t.list_id==="list-b");task=await f.service.update({...ref(task),scheduled_at:start});
  f.state.failedList="list-b";f.lists.get("list-a").get("1").title="Atnaujinta";
  result=await f.service.list();assert.equal(result.items.find(t=>t.list_id==="list-a").title,"Atnaujinta");assert.equal(result.items.find(t=>t.list_id==="list-b").stale,true);assert.equal(result.items.find(t=>t.list_id==="list-b").scheduled_at,start);assert.equal(result.warnings.length,1);
  f.state.failedList=null;f.lists.delete("list-b");result=await f.service.list();assert.equal(result.items.length,1);assert.equal(result.lists.length,1);
});

test("Google source completion clears the persisted plan and does not resurrect it on restore",async t=>{
  const f=setup(t);
  let task=(await f.service.list()).items[0];task=await f.service.update({...ref(task),scheduled_at:start});const stale=ref(task);
  f.lists.get("list-a").get("1").status="completed";
  task=(await f.service.list()).items[0];assert.equal(task.completed,1);assert.equal(task.scheduled_at,null);
  await assert.rejects(f.service.update({...stale,scheduled_at:start}),e=>e.status===409);
  f.lists.get("list-a").get("1").status="needsAction";f.restart();task=(await f.service.list()).items[0];
  assert.equal(task.scheduled_at,null);assert.equal(task.completed,0);assert.ok(f.calls.every(c=>c.method==="GET"));
});

test("Google offline snapshots support local planning and never leak into another account",async t=>{
  const f=setup(t);let task=(await f.service.list()).items[0];await f.service.create({title:"Vietinė"});
  f.state.offline=true;task=await f.service.update({...ref(task),scheduled_at:start});
  let result=await f.service.list();assert.equal(result.items.length,2);assert.equal(result.items.find(t=>t.source==="google").scheduled_at,start);
  f.state.account="account-b";result=await f.service.list();assert.equal(result.items.length,1);assert.equal(result.items[0].source,"local");
  await assert.rejects(f.service.update({...ref(task),scheduled_at:null}),e=>e.status===409);
});

test("Google task and list pagination follows encoded tokens; repeated tokens retain last good cache",async t=>{
  const f=setup(t);const original=f.google.request;let calls=[];
  f.google.request=async raw=>{calls.push(raw);const u=new URL(raw,"https://fixture.invalid");if(u.pathname==="/users/@me/lists")return u.searchParams.has("pageToken")?{items:[{id:"b",title:"B"}]}:{items:[{id:"a",title:"A"}],nextPageToken:"a&b"};
    if(u.pathname==="/lists/b/tasks")return {};
    return u.searchParams.has("pageToken")?{items:[{id:"2",title:"Antra"}]}:{items:[{id:"1",title:"Pirma"}],nextPageToken:"c&d"};};
  let result=await f.service.list();assert.equal(result.lists.length,2);assert.equal(result.items.length,2);assert.ok(calls.some(u=>u.endsWith("pageToken=a%26b")));assert.ok(calls.some(u=>u.endsWith("pageToken=c%26d")));
  f.google.request=async raw=>raw.startsWith("/users/")?{items:[{id:"a"}]}:{items:[{id:"bad"}],nextPageToken:"loop"};
  result=await f.service.list();assert.equal(result.items.length,2);assert.ok(result.items.every(t=>t.stale));assert.ok(result.warnings.length);
  f.google.request=original;
});

test("Google source links are restricted and subtask metadata survives planning",async t=>{
  const f=setup(t);f.lists.get("list-a").get("1").parent="parent";
  let task=(await f.service.list()).items[0];assert.equal(task.source_url,"https://tasks.google.com/task/1");assert.equal(task.parent_id,"parent");
  for(const link of ["javascript:alert(1)","https://tasks.google.com.evil.example/task","https://user:pass@tasks.google.com/task"]){f.lists.get("list-a").get("1").webViewLink=link;task=(await f.service.list()).items[0];assert.equal(task.source_url,"https://tasks.google.com/");}
  task=await f.service.update({...ref(task),scheduled_at:start});assert.equal(task.parent_id,"parent");
});
