import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {createTaskService,migrateTaskPlanning} from "../lib/task-service.ts";

function fixture(t) {
  const db=new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,notes TEXT DEFAULT '',due_at TEXT,
    duration_minutes INTEGER DEFAULT 30,completed INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    project TEXT DEFAULT 'Asmeniniai',priority TEXT DEFAULT 'normal',energy TEXT DEFAULT 'medium',tags TEXT DEFAULT '');`);
  migrateTaskPlanning(db);t.after(()=>db.close());
  const adapters={};
  for(const source of ["google","microsoft"]){
    const state={account:"account",connected:true,offline:false,failWrite:false,onRead:null};
    const lists=new Map([["same",source==="google"?{id:"same",title:"Darbai",etag:'"v1"'}:{id:"same",displayName:"Darbai",isOwner:true,wellknownListName:"none"}]]);
    const tasks=new Map([["same",new Map([["same",{id:"same",title:"Užduotis",status:source==="google"?"needsAction":"notStarted"}]])]]),calls=[];
    let nextId=1;
    adapters[source]={state,lists,tasks,calls,connected:()=>state.connected,cachedAccountId:()=>state.account,accountId:async()=>state.account,
      async request(raw,init={}){
        const method=init.method||"GET",url=new URL(raw,"https://fixture.invalid"),body=init.body?JSON.parse(init.body):undefined;
        calls.push({raw,method,body,headers:init.headers});if(state.offline)throw Error("Offline");if(method!=="GET"&&state.failWrite)throw Error("Write failed");
        if(method==="GET"&&state.onRead)await state.onRead(raw);
        const listRoot=source==="google"?"/users/@me/lists":"/me/todo/lists",listMatch=url.pathname.startsWith(listRoot);
        const parts=url.pathname.split("/").map(decodeURIComponent),taskIndex=parts.indexOf("tasks");
        if(taskIndex>=0){const listId=parts[taskIndex-1],map=tasks.get(listId);if(!map)throw Error("Missing list");
          if(method==="GET")return source==="google"?{items:structuredClone([...map.values()])}:{value:structuredClone([...map.values()])};
          if(method==="POST"){const task={id:`created-${nextId++}`,...body};map.set(task.id,task);return structuredClone(task);}
          throw Error("Unexpected task write");
        }
        if(listMatch){
          if(url.pathname===listRoot){
            if(method==="GET")return source==="google"?{items:structuredClone([...lists.values()])}:{value:structuredClone([...lists.values()])};
            if(method==="POST"){const id=`created-${nextId++}`,list=source==="google"?{id,etag:'"created"',...body}:{id,isOwner:true,wellknownListName:"none",...body};lists.set(id,list);tasks.set(id,new Map());return structuredClone(list);}
          }
          const id=parts.at(-1),list=lists.get(id);if(!list)throw Error("Missing list");
          if(method==="PATCH"){Object.assign(list,body);if(source==="google")list.etag='"v2"';return structuredClone(list);}
          if(method==="DELETE"){lists.delete(id);tasks.delete(id);return null;}
        }
        throw Error(`Unexpected fixture request ${method} ${raw}`);
      }};
  }
  return {db,...adapters,service:createTaskService(db,adapters.microsoft,adapters.google)};
}
const ref=list=>({source:list.source,account_id:list.account_id,list_id:list.list_id,version:list.version});
const deletion=preview=>({...ref(preview.list),confirmation:preview.confirmation,confirm_name:preview.list.name});
const taskRef=task=>({source:task.source,account_id:task.account_id,list_id:task.list_id,id:task.id,schedule_version:task.schedule_version});

for(const source of ["google","microsoft"]){
  test(`${source} list creation and rename send only provider name fields, retaining task plans`,async t=>{
    const f=fixture(t),g=f[source];let lists=(await f.service.listCatalog()).lists;let list=lists.find(l=>l.source===source);
    assert.equal(list.can_rename,true);assert.equal(list.can_delete,true);assert.ok(list.version);
    let task=(await f.service.list()).items.find(t=>t.source===source);
    task=await f.service.update({...taskRef(task),scheduled_at:"2026-09-16T07:00:00.000Z",duration_minutes:60});
    const created=await f.service.createList({source,account_id:"account",name:"  Naujas  "});assert.equal(created.name,"Naujas");
    const previous=ref(list);list=await f.service.renameList({...previous,name:"Pervadintas",arbitrary:"ignored"});assert.equal(list.name,"Pervadintas");assert.notEqual(list.version,previous.version);
    task=(await f.service.list()).items.find(t=>t.source===source);assert.equal(task.list_name,"Pervadintas");assert.equal(task.scheduled_at,"2026-09-16T07:00:00.000Z");assert.equal(task.duration_minutes,60);
    assert.deepEqual(g.calls.filter(c=>c.method!=="GET").map(c=>c.body),source==="google"?[{title:"Naujas"},{title:"Pervadintas"}]:[{displayName:"Naujas"},{displayName:"Pervadintas"}]);
    if(source==="google")assert.equal(g.calls.find(c=>c.method==="PATCH").headers["If-Match"],'"v1"');
    await assert.rejects(f.service.renameList({...previous,name:"Stale"}),e=>e.status===409);
  });
  test(`${source} confirmed nonempty list deletion cleans only that provider's tasks and persisted plans`,async t=>{
    const f=fixture(t);await f.service.create({title:"Vietinė"});
    for(const task of (await f.service.list()).items)await f.service.update({...taskRef(task),scheduled_at:"2026-09-16T07:00:00Z"});
    const preview=await f.service.previewListDeletion({source,account_id:"account",list_id:"same"});assert.equal(preview.task_count,1);assert.ok(preview.confirmation);
    await f.service.deleteList(deletion(preview));assert.equal(f[source].lists.size,0);
    const items=(await f.service.list()).items;assert.equal(items.length,2);assert.ok(items.every(task=>task.source!==source&&task.scheduled_at));
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM task_plans").get().n,2);
  });
  test(`${source} stale delete previews and wrong typed names reject all writes`,async t=>{
    const f=fixture(t),g=f[source],preview=await f.service.previewListDeletion({source,account_id:"account",list_id:"same"});
    await assert.rejects(f.service.deleteList({...deletion(preview),confirm_name:"wrong"}),e=>e.status===409);
    g.tasks.get("same").get("same").title="Changed externally";
    await assert.rejects(f.service.deleteList(deletion(preview)),e=>e.status===409);
    assert.equal(g.calls.filter(c=>c.method!=="GET").length,0);
  });
  test(`${source} failed deletion preserves every local plan and cached task`,async t=>{
    const f=fixture(t),g=f[source];const task=(await f.service.list()).items.find(t=>t.source===source);
    await f.service.update({...taskRef(task),scheduled_at:"2026-09-16T07:00:00Z"});const preview=await f.service.previewListDeletion({source,account_id:"account",list_id:"same"});g.state.failWrite=true;
    await assert.rejects(f.service.deleteList(deletion(preview)),/Write failed/);
    assert.ok(f.db.prepare("SELECT task_key FROM task_plans WHERE task_key=?").get(task.key));assert.ok(f.db.prepare("SELECT task_key FROM remote_tasks WHERE task_key=?").get(task.key));
  });
  test(`${source} account changes and invalid names are rejected before provider writes`,async t=>{
    const f=fixture(t),g=f[source],list=(await f.service.listCatalog()).lists.find(l=>l.source===source);
    for(const name of ["", " ", "x".repeat(256), 123])await assert.rejects(f.service.createList({source,account_id:"account",name}),e=>e.status===400);
    await assert.rejects(f.service.createList({source,account_id:"other",name:"X"}),e=>e.status===409);
    g.state.onRead=async()=>{g.state.account="new-account";};
    await assert.rejects(f.service.renameList({...ref(list),name:"X"}),e=>e.status===409);
    assert.equal(g.calls.filter(c=>c.method!=="GET").length,0);
  });
  test(`${source} catalog fallback marks lists stale and does not offer creation accounts`,async t=>{
    const f=fixture(t),g=f[source];await f.service.listCatalog();g.state.offline=true;
    let result=await f.service.listCatalog();assert.equal(result.lists.find(l=>l.source===source).stale,true);assert.ok(!result.accounts.some(a=>a.source===source));assert.equal(result.warnings.length,1);
    g.state.account="other";result=await f.service.listCatalog();assert.ok(!result.lists.some(l=>l.source===source));
  });
}

test("Microsoft built-in, unknown and unowned lists cannot be renamed or deleted",async t=>{
  const f=fixture(t);
  for(const raw of [{wellknownListName:"defaultList",isOwner:true},{wellknownListName:"flaggedEmails",isOwner:true},{wellknownListName:"unknownFutureValue",isOwner:true},{isOwner:true},{wellknownListName:"none",isOwner:false},{wellknownListName:"none"}]){
    f.microsoft.lists.set("same",{id:"same",displayName:"Protected",...raw});const list=(await f.service.listCatalog()).lists.find(l=>l.source==="microsoft");assert.equal(list.can_delete,false);assert.equal(list.can_rename,false);
    await assert.rejects(f.service.renameList({...ref(list),name:"X"}),e=>e.status===403);
    const preview=await f.service.previewListDeletion(ref(list));assert.equal(preview.confirmation,null);assert.ok(preview.blocked_reason);
  }
  assert.ok(f.microsoft.calls.every(c=>c.method==="GET"));
});

test("Google deletion includes hidden/assigned tasks and refuses to delete Docs/Chat originals",async t=>{
  const f=fixture(t);f.google.tasks.get("same").set("assigned",{id:"assigned",status:"completed",hidden:true,assignmentInfo:{surfaceType:"DOCUMENT"}});
  const preview=await f.service.previewListDeletion({source:"google",account_id:"account",list_id:"same"});assert.equal(preview.task_count,2);assert.equal(preview.confirmation,null);assert.match(preview.blocked_reason,/Docs/);
  const url=new URL(f.google.calls.find(c=>c.raw.includes("/tasks?")).raw,"https://fixture.invalid");for(const flag of ["showAssigned","showHidden","showCompleted"])assert.equal(url.searchParams.get(flag),"true");
  await assert.rejects(f.service.deleteList({...deletion(preview),confirmation:"forged"}),e=>e.status===409);assert.ok(f.google.calls.every(c=>c.method==="GET"));
});

test("pending and orphaned Outlook mirror references prevent list deletion",async t=>{
  const f=fixture(t),key=JSON.stringify(["google","account","same","no-longer-cached"]);
  f.db.prepare("INSERT INTO task_plans(task_key,mirror_transaction_id) VALUES (?,?)").run(key,"pending");
  const preview=await f.service.previewListDeletion({source:"google",account_id:"account",list_id:"same"});assert.equal(preview.confirmation,null);assert.match(preview.blocked_reason,/Outlook/);
  assert.ok(f.google.calls.every(c=>c.method==="GET"));
});

test("list deletion shares the task provider lock so a concurrent creation invalidates its preview",async t=>{
  const f=fixture(t),preview=await f.service.previewListDeletion({source:"google",account_id:"account",list_id:"same"});
  const created=f.service.create({source:"google",account_id:"account",list_id:"same",title:"New during confirmation"});
  const deleted=f.service.deleteList(deletion(preview));await created;await assert.rejects(deleted,e=>e.status===409);assert.equal(f.google.lists.size,1);
});

for(const source of ["google","microsoft"]){
  test(`${source} deletion checks later pages and refuses partial or changed snapshots`,async t=>{
    const f=fixture(t),g=f[source],request=g.request.bind(g);
    let lastTask={id:"last-page",title:"Last",status:"completed"},failLast=false;
    g.request=async(raw,init={})=>{
      const url=new URL(raw,"https://fixture.invalid");
      if((init.method||"GET")==="GET"&&url.pathname.endsWith("/tasks")){
        const last=url.searchParams.has(source==="google"?"pageToken":"$skiptoken");
        if(last){if(failLast)throw Error("Last page unavailable");return source==="google"?{items:[structuredClone(lastTask)]}:{value:[structuredClone(lastTask)]};}
        const result=await request(raw,init);
        return source==="google"?{...result,nextPageToken:"last"}:{...result,"@odata.nextLink":`https://graph.microsoft.com/v1.0${url.pathname}?$skiptoken=last`};
      }
      return request(raw,init);
    };
    const preview=await f.service.previewListDeletion({source,account_id:"account",list_id:"same"});assert.equal(preview.task_count,2);
    lastTask.title="Changed on last page";
    await assert.rejects(f.service.deleteList(deletion(preview)),e=>e.status===409);
    failLast=true;await assert.rejects(f.service.deleteList(deletion(preview)),/Last page unavailable/);
    assert.ok(g.calls.every(call=>call.method==="GET"));assert.equal(g.lists.size,1);
  });
}

test("an Outlook mirror introduced after confirmation blocks list deletion",async t=>{
  const f=fixture(t),preview=await f.service.previewListDeletion({source:"google",account_id:"account",list_id:"same"});
  f.db.prepare("INSERT INTO task_plans(task_key,mirror_event_id) VALUES (?,?)").run(JSON.stringify(["google","account","same","same"]),"new-mirror");
  await assert.rejects(f.service.deleteList(deletion(preview)),e=>e.status===409&&/Outlook/.test(e.message));
  assert.ok(f.google.calls.every(call=>call.method==="GET"));
});
