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
  const state={account:"account-a",connected:true,offline:false,failedList:null,failMove:false,loseMoveResponse:false,failConfirmation:false,moveResultId:null};
  const google={connected:()=>state.connected,cachedAccountId:()=>state.account,accountId:async()=>state.account,
    async request(raw,init={}) {
      const url=new URL(raw,"https://fixture.invalid"),method=init.method||"GET",body=init.body?JSON.parse(init.body):undefined;
      calls.push({path:raw,method,body});
      if(state.offline)throw Error("offline");
      if(url.pathname==="/users/@me/lists")return {items:[...lists.keys()].map(id=>({id,title:id}))};
      const [, ,listId, ,taskId]=url.pathname.split("/").map(decodeURIComponent),list=lists.get(listId);
      if(!list || state.failedList===listId)throw Error("list unavailable");
      if(method==="GET") {
        if(taskId && state.failConfirmation){state.failConfirmation=false;throw Error("confirmation failed");}
        return taskId ? structuredClone(list.get(taskId)) : {items:structuredClone([...list.values()])};
      }
      if(method==="POST" && url.pathname.endsWith("/move")) {
        if(state.failMove)throw Error("move failed");
        const id=decodeURIComponent(url.pathname.split("/").at(-2)),destinationId=url.searchParams.get("destinationTasklist"),destination=destinationId?lists.get(destinationId):list;
        const task=list.get(id);if(!task||!destination)throw Error("move unavailable");
        const movedId=state.moveResultId||id,moved={...task,id:movedId};
        if(destinationId){list.delete(id);destination.set(movedId,moved);}
        else {
          const parent=url.searchParams.get("parent"),previous=url.searchParams.get("previous");
          if(parent)moved.parent=parent;else delete moved.parent;
          const entries=[...list.entries()].filter(([key])=>key!==id),insertAfter=previous?entries.findIndex(([key])=>key===previous):-1;
          const target=insertAfter>=0?insertAfter+1:entries.findIndex(([,value])=>(value.parent||null)===(parent||null));
          entries.splice(target<0?entries.length:target,0,[movedId,moved]);list.clear();for(const entry of entries)list.set(...entry);
        }
        if(state.loseMoveResponse)throw Error("move response lost");
        return structuredClone(moved);
      }
      if(method==="POST") {const task={id:String(list.size+1),status:"needsAction",...body};list.set(task.id,task);return structuredClone(task);}
      if(method==="PATCH") {Object.assign(list.get(taskId),body);return structuredClone(list.get(taskId));}
      if(method==="DELETE") {list.delete(taskId);return null;}
      throw Error("unexpected method");
    }};
  const microsoft={connected:()=>false,cachedAccountId:()=>null,accountId:async()=>{throw Error("disconnected");},request:async()=>{throw Error("unexpected Microsoft call");}};
  let service=createTaskService(db,microsoft,google);
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  return {get service(){return service;},get db(){return db;},google,state,lists,calls,
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

test("Google hierarchy snapshot moves a task under a parent and after a sibling",async t=>{
  const f=setup(t),list=f.lists.get("list-a");
  list.clear();list.set("parent",{id:"parent",title:"Projektas",status:"needsAction"});list.set("first",{id:"first",title:"Pirma",parent:"parent",status:"needsAction"});list.set("1",{id:"1",title:"Perkeliama",status:"needsAction"});
  const task=(await f.service.list()).items.find(item=>item.id==="1"),snapshot=await f.service.readGoogleOrder(ref(task));
  assert.equal(snapshot.parent_id,null);assert.equal(snapshot.previous_id,"parent");assert.deepEqual(snapshot.items.map(item=>item.id),["parent","first","1"]);
  f.calls.length=0;const next=await f.service.updateGoogleOrder({...ref(task),version:snapshot.version,parent_id:"parent",previous_id:"first"});
  assert.equal(next.parent_id,"parent");assert.equal(next.previous_id,"first");
  assert.deepEqual(f.calls.filter(call=>call.method==="POST").map(call=>call.path),["/lists/list-a/tasks/1/move?parent=parent&previous=first"]);
  assert.equal((await f.service.list()).items.find(item=>item.id==="1").parent_id,"parent");
});

test("Google hierarchy rejects stale versions, cycles and cross-level previous tasks before writes",async t=>{
  const f=setup(t),list=f.lists.get("list-a");
  list.set("child",{id:"child",title:"Vaikas",parent:"1",status:"needsAction"});list.set("top",{id:"top",title:"Viršuje",status:"needsAction"});
  const task=(await f.service.list()).items.find(item=>item.id==="1"),snapshot=await f.service.readGoogleOrder(ref(task));f.calls.length=0;
  await assert.rejects(f.service.updateGoogleOrder({...ref(task),version:"stale",parent_id:null,previous_id:null}),error=>error.status===409);
  await assert.rejects(f.service.updateGoogleOrder({...ref(task),version:snapshot.version,parent_id:"child",previous_id:null}),/ciklą/);
  await assert.rejects(f.service.updateGoogleOrder({...ref(task),version:snapshot.version,parent_id:null,previous_id:"child"}),/tame pačiame hierarchijos lygyje/);
  assert.equal(f.calls.some(call=>call.method==="POST"),false);
});

test("Google hierarchy excludes forbidden parents and enforces hidden completed restrictions",async t=>{
  const f=setup(t),list=f.lists.get("list-a");
  list.set("assigned",{id:"assigned",title:"Priskirta",assignmentInfo:{surfaceType:"DOCUMENT"}});list.set("recurring",{id:"recurring",title:"Kartojama",recurrence:["RRULE:FREQ=DAILY"]});
  let task=(await f.service.list()).items.find(item=>item.id==="1"),snapshot=await f.service.readGoogleOrder(ref(task));
  assert.equal(snapshot.items.find(item=>item.id==="assigned").can_be_parent,false);assert.equal(snapshot.items.find(item=>item.id==="recurring").can_be_parent,false);
  await assert.rejects(f.service.updateGoogleOrder({...ref(task),version:snapshot.version,parent_id:"assigned",previous_id:null}),error=>error.status===409);
  list.get("1").status="completed";list.get("1").hidden=true;snapshot=await f.service.readGoogleOrder(ref(task));
  await assert.rejects(f.service.updateGoogleOrder({...ref(task),version:snapshot.version,parent_id:null,previous_id:"assigned"}),error=>error.status===409);
});

test("Google list move atomically rekeys the complete local plan after provider confirmation",async t=>{
  const f=setup(t);f.lists.set("list-b",new Map());f.state.moveResultId="moved-1";let task=(await f.service.list()).items[0];
  task=await f.service.update({...ref(task),scheduled_at:start,duration_minutes:75,priority:"high",project:"Darbas",tags:"svarbu",energy:"high"});
  f.db.prepare(`UPDATE task_plans SET mirror_requested=1,mirror_event_id='event-1',mirror_account_id='microsoft-a',
    mirror_transaction_id='transaction-1',mirror_error='retry',mirror_create_payload='{"transactionId":"transaction-1"}' WHERE task_key=?`).run(task.key);
  const oldKey=task.key,oldPlan=f.db.prepare("SELECT * FROM task_plans WHERE task_key=?").get(oldKey);f.calls.length=0;
  const moved=await f.service.moveGoogle({...ref(task),destination_list_id:"list-b"});
  assert.equal(moved.id,"moved-1");assert.equal(moved.list_id,"list-b");assert.notEqual(moved.key,oldKey);assert.equal(moved.schedule_version,task.schedule_version+1);
  assert.equal(moved.scheduled_at,start);assert.equal(moved.duration_minutes,75);assert.equal(moved.priority,"high");assert.equal(moved.project,"Darbas");
  const newPlan=f.db.prepare("SELECT * FROM task_plans WHERE task_key=?").get(moved.key);
  for(const field of ["scheduled_at","duration_minutes","legacy_schedule","mirror_requested","mirror_event_id","mirror_account_id","mirror_transaction_id","mirror_error","project","tags","energy","mirror_create_payload","local_priority"]) assert.equal(newPlan[field],oldPlan[field],field);
  assert.equal(newPlan.schedule_version,oldPlan.schedule_version+1);assert.equal(f.db.prepare("SELECT 1 FROM task_plans WHERE task_key=?").get(oldKey),undefined);
  assert.equal(f.db.prepare("SELECT list_id FROM remote_tasks WHERE task_key=?").get(moved.key).list_id,"list-b");
  assert.equal(f.lists.get("list-a").has("1"),false);assert.equal(f.lists.get("list-b").has("moved-1"),true);
  assert.deepEqual(f.calls.filter(call=>call.method!=="GET").map(call=>call.path),["/lists/list-a/tasks/1/move?destinationTasklist=list-b"]);
});

test("Google list move rejects stale, conflicting and failed moves without changing local identity",async t=>{
  const f=setup(t);f.lists.set("list-b",new Map());let task=(await f.service.list()).items[0];
  task=await f.service.update({...ref(task),scheduled_at:start});const oldKey=task.key;
  f.calls.length=0;
  await assert.rejects(f.service.moveGoogle({...ref(task),schedule_version:task.schedule_version-1,destination_list_id:"list-b"}),error=>error.status===409);
  assert.equal(f.calls.length,0);
  const destinationKey=JSON.stringify(["google","account-a","list-b","1"]);
  f.db.prepare("INSERT INTO task_plans(task_key) VALUES (?)").run(destinationKey);
  await assert.rejects(f.service.moveGoogle({...ref(task),destination_list_id:"list-b"}),error=>error.status===409);
  f.db.prepare("DELETE FROM task_plans WHERE task_key=?").run(destinationKey);f.state.failMove=true;
  await assert.rejects(f.service.moveGoogle({...ref(task),destination_list_id:"list-b"}),/move failed/);
  assert.ok(f.db.prepare("SELECT 1 FROM task_plans WHERE task_key=?").get(oldKey));assert.equal(f.lists.get("list-a").has("1"),true);assert.equal(f.lists.get("list-b").has("1"),false);
});

test("Google list move refuses parent and child tasks before the provider write",async t=>{
  const f=setup(t);f.lists.set("list-b",new Map());let task=(await f.service.list()).items[0];f.calls.length=0;
  f.lists.get("list-a").get("1").parent="parent-1";
  await assert.rejects(f.service.moveGoogle({...ref(task),destination_list_id:"list-b"}),error=>error.status===409);
  f.lists.get("list-a").get("1").parent=undefined;f.lists.get("list-a").set("child",{id:"child",title:"Vaikas",parent:"1"});
  await assert.rejects(f.service.moveGoogle({...ref(task),destination_list_id:"list-b"}),error=>error.status===409);
  assert.equal(f.calls.some(call=>call.path.includes("/move?")),false);assert.equal(f.lists.get("list-a").has("1"),true);
});

test("Google list refresh reconciles a provider move whose confirmation request failed",async t=>{
  const f=setup(t);f.lists.set("list-b",new Map());let task=(await f.service.list()).items[0];
  task=await f.service.update({...ref(task),scheduled_at:start,project:"Atkuriama",tags:"mirror"});
  f.db.prepare("UPDATE task_plans SET mirror_requested=1,mirror_event_id='event-recover',mirror_transaction_id='tx-recover' WHERE task_key=?").run(task.key);
  f.state.failConfirmation=true;
  await assert.rejects(f.service.moveGoogle({...ref(task),destination_list_id:"list-b"}),/confirmation failed/);
  assert.ok(f.db.prepare("SELECT 1 FROM task_plans WHERE task_key=?").get(task.key));
  assert.equal(f.db.prepare("SELECT count(*) AS count FROM settings WHERE key LIKE 'task_move_pending:%'").get().count,1);
  f.restart();
  const result=await f.service.list(),moved=result.items.find(item=>item.list_id==="list-b");
  assert.ok(moved);assert.equal(moved.scheduled_at,start);assert.equal(moved.project,"Atkuriama");assert.equal(moved.mirror_event_id,"event-recover");
  assert.equal(f.db.prepare("SELECT 1 FROM task_plans WHERE task_key=?").get(task.key),undefined);
  assert.equal(f.db.prepare("SELECT count(*) AS count FROM settings WHERE key LIKE 'task_move_pending:%'").get().count,0);
  assert.ok(result.warnings.some(warning=>warning.includes("užbaigtas anksčiau nutrūkęs")));
});

test("Google move without a returned ID never attaches a plan by matching task content",async t=>{
  const f=setup(t);f.lists.set("list-b",new Map());let task=(await f.service.list()).items[0];
  task=await f.service.update({...ref(task),scheduled_at:start});f.state.moveResultId="unknown-new-id";f.state.loseMoveResponse=true;
  await assert.rejects(f.service.moveGoogle({...ref(task),destination_list_id:"list-b"}),/move response lost/);
  f.restart();const result=await f.service.list(),destination=result.items.find(item=>item.id==="unknown-new-id");
  assert.ok(destination);assert.equal(destination.scheduled_at,null);
  assert.ok(f.db.prepare("SELECT 1 FROM task_plans WHERE task_key=?").get(task.key));
  assert.equal(f.db.prepare("SELECT count(*) AS count FROM settings WHERE key LIKE 'task_move_pending:%'").get().count,1);
  assert.ok(result.warnings.some(warning=>warning.includes("nepavyko automatiškai suderinti")));
});

test("Google recovery with a known new ID never falls back to a foreign task using the old ID",async t=>{
  const f=setup(t);f.lists.set("list-b",new Map());let task=(await f.service.list()).items[0];
  task=await f.service.update({...ref(task),scheduled_at:start});f.state.moveResultId="known-new-id";f.state.failConfirmation=true;
  await assert.rejects(f.service.moveGoogle({...ref(task),destination_list_id:"list-b"}),/confirmation failed/);
  f.lists.get("list-b").delete("known-new-id");f.lists.get("list-b").set("1",{id:"1",title:"Svetima užduotis",status:"needsAction"});
  f.restart();const result=await f.service.list(),foreign=result.items.find(item=>item.list_id==="list-b"&&item.id==="1");
  assert.ok(foreign);assert.equal(foreign.scheduled_at,null);
  assert.ok(f.db.prepare("SELECT 1 FROM task_plans WHERE task_key=?").get(task.key));
  assert.equal(f.db.prepare("SELECT count(*) AS count FROM settings WHERE key LIKE 'task_move_pending:%'").get().count,1);
  assert.ok(result.warnings.some(warning=>warning.includes("nepavyko automatiškai suderinti")));
});
