import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTaskService, migrateTaskPlanning } from "../lib/task-service.ts";

function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '', due_at TEXT, duration_minutes INTEGER NOT NULL DEFAULT 30,
    completed INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    project TEXT NOT NULL DEFAULT 'Asmeniniai', priority TEXT NOT NULL DEFAULT 'normal',
    tags TEXT NOT NULL DEFAULT '', energy TEXT NOT NULL DEFAULT 'medium');`);
}
function gateway() {
  const calls = []; const events = new Map(); const transactions = new Map();
  const remote = new Map([["1", { id:"1", title:"Microsoft užduotis", status:"notStarted", importance:"normal", dueDateTime:{dateTime:"2026-10-30T12:00:00.0000000",timeZone:"UTC"} }]]);
  const state = { connected:true, account:"account-a", offline:false, uncertainCreate:false };
  return {
    calls, events, remote, state,
    connected:() => state.connected,
    cachedAccountId:() => state.account,
    accountId:async () => state.account,
    defaultListId:async () => "list-a",
    async request(url, init = {}) {
      const method = init.method || "GET"; const body = init.body ? JSON.parse(init.body) : null;
      calls.push({url, method, body});
      if (state.offline) throw new Error("Offline");
      if (url.startsWith("/me/todo/lists?") && method === "GET") return {value:[{id:"list-a",displayName:"Darbai",wellknownListName:"defaultList"}]};
      if (url.startsWith("/me/todo/lists/list-a/tasks")) {
        if (method === "GET") return {value:structuredClone([...remote.values()])};
        if (method === "POST") { const task = {id:`remote-${remote.size+1}`,status:"notStarted",...body}; remote.set(task.id,task); return task; }
        const id = decodeURIComponent(url.split("/").at(-1));
        if (method === "PATCH") { Object.assign(remote.get(id),body); return remote.get(id); }
        if (method === "DELETE") { remote.delete(id); return null; }
      }
      if (url === "/me/events" && method === "POST") {
        const id = transactions.get(body.transactionId) || `event-${transactions.size+1}`;
        transactions.set(body.transactionId,id); events.set(id,body);
        if (state.uncertainCreate) { state.uncertainCreate=false; throw new Error("Response lost after create"); }
        return {id};
      }
      const id = decodeURIComponent(url.split("/").at(-1));
      if (url.startsWith("/me/events/") && method === "PATCH") { events.set(id,{...events.get(id),...body}); return {id}; }
      if (url.startsWith("/me/events/") && method === "DELETE") { events.delete(id); return null; }
      throw new Error(`Unexpected request: ${method} ${url}`);
    },
  };
}
function fixture(t, {migrate = true} = {}) {
  const db = new DatabaseSync(":memory:"); schema(db); if (migrate) migrateTaskPlanning(db);
  const graph = gateway(); const service = createTaskService(db,graph);
  t.after(() => db.close()); return {db,graph,service};
}
const ref = (task) => ({id:task.id,source:task.source,account_id:task.account_id,list_id:task.list_id,schedule_version:task.schedule_version});
const start = "2026-10-25T08:00:00.000Z";

test("legacy migration preserves deadline and schedule, and never reapplies an removed schedule", async (t) => {
  const {db,service} = fixture(t,{migrate:false});
  db.prepare("INSERT INTO tasks(title,due_at,duration_minutes) VALUES (?,?,?)").run("Sena užduotis",start,45);
  migrateTaskPlanning(db);
  let task = (await service.list()).items.find(t => t.source === "local");
  assert.equal(task.due_at,start); assert.equal(task.scheduled_at,start); assert.equal(task.legacy_schedule,1);
  task = await service.update({...ref(task),scheduled_at:null});
  migrateTaskPlanning(db);
  task = (await service.list()).items.find(t => t.source === "local");
  assert.equal(task.scheduled_at,null); assert.equal(task.due_at,start); assert.equal(task.legacy_schedule,0);
});

test("local and Microsoft identities coexist even with identical ids; local writes never reach Graph", async (t) => {
  const {service,graph} = fixture(t);
  let local = await service.create({title:"Vietinė",due_at:start});
  const {items} = await service.list();
  assert.equal(items.length,2); assert.notEqual(items[0].key,items[1].key);
  assert.equal(local.scheduled_at,null);
  graph.calls.length=0;
  local = await service.update({...ref(local),title:"Pakeista",scheduled_at:start});
  await service.remove(ref(local));
  assert.equal(graph.calls.length,0); assert.equal(graph.remote.size,1);
});

test("Microsoft planning, moving, duration and unscheduling persist without any provider writes", async (t) => {
  const temp = mkdtempSync(path.join(tmpdir(),"planner-contract-"));
  let db = new DatabaseSync(path.join(temp,"test.db")); schema(db); migrateTaskPlanning(db);
  t.after(() => {db.close(); rmSync(temp,{recursive:true,force:true});});
  const graph = gateway(); let service = createTaskService(db,graph);
  let task = (await service.list()).items[0]; const deadline = task.due_at;
  graph.calls.length=0;
  task = await service.update({...ref(task),scheduled_at:start});
  task = await service.update({...ref(task),scheduled_at:"2026-10-26T10:00:00+02:00",duration_minutes:75});
  assert.equal(graph.calls.length,0); assert.equal(task.due_at,deadline);
  db.close(); db=new DatabaseSync(path.join(temp,"test.db")); migrateTaskPlanning(db); service=createTaskService(db,graph);
  task=(await service.list()).items[0];
  assert.equal(task.duration_minutes,75); assert.equal(task.scheduled_at,"2026-10-26T08:00:00.000Z"); assert.equal(task.due_at,deadline);
  task=await service.update({...ref(task),scheduled_at:null});
  assert.equal(task.scheduled_at,null); assert.equal(task.due_at,deadline);
  assert.ok(graph.calls.every(c => c.method === "GET"));
});

test("stale and simultaneous schedule versions cannot overwrite the accepted plan", async (t) => {
  const {service} = fixture(t); const task=await service.create({title:"Lenktynės"});
  const results=await Promise.allSettled([
    service.update({...ref(task),scheduled_at:start}),
    service.update({...ref(task),scheduled_at:"2026-10-26T08:00:00.000Z"}),
  ]);
  assert.equal(results[0].status,"fulfilled"); assert.equal(results[1].status,"rejected");
  assert.equal(results[1].reason.status,409);
  assert.equal((await service.list()).items[0].scheduled_at,start);
});

test("invalid mutations are rejected before writes", async (t) => {
  const {service,graph} = fixture(t); const task=(await service.list()).items[0]; graph.calls.length=0;
  for (const patch of [{duration_minutes:0},{duration_minutes:1.5},{scheduled_at:"2026-10-25T10:00"},{priority:"urgent"},{title:" "},{completed:1},{mirror_requested:"yes"}]) {
    await assert.rejects(service.update({...ref(task),...patch}), e => e.status === 400);
  }
  assert.equal(graph.calls.length,0);
});

test("opt-in block is free, linked once, moved in place and removed on completion", async (t) => {
  const {service,graph} = fixture(t); let task=(await service.list()).items[0]; const deadline=task.due_at;
  task=await service.update({...ref(task),scheduled_at:start,mirror_requested:true});
  const eventId=task.mirror_event_id; assert.ok(eventId); assert.equal(task.mirror_error,null);
  task=await service.update({...ref(task),scheduled_at:"2026-10-26T09:00:00Z",duration_minutes:60});
  assert.equal(task.mirror_event_id,eventId); assert.equal(task.due_at,deadline);
  assert.equal(graph.calls.filter(c => c.url === "/me/events" && c.method === "POST").length,1);
  for (const call of graph.calls.filter(c => c.url.startsWith("/me/events") && c.body)) {
    assert.equal(call.body.showAs,"free"); assert.equal(call.body.isReminderOn,false); assert.equal(call.body.attendees,undefined); assert.equal(call.body.isOnlineMeeting,undefined);
  }
  task=await service.update({...ref(task),completed:true});
  assert.equal(task.scheduled_at,null); assert.equal(task.mirror_event_id,null); assert.equal(graph.events.size,0);
  const todoWrites=graph.calls.filter(c => c.url.includes("/todo/") && c.method !== "GET");
  assert.deepEqual(todoWrites.map(c => c.body),[{status:"completed"}]);
});

test("uncertain block creation retains its transaction and can be resolved then removed after restart", async (t) => {
  const {db,service,graph}=fixture(t); let task=await service.create({title:"Pakartojimas"});
  graph.state.uncertainCreate=true;
  task=await service.update({...ref(task),scheduled_at:start,mirror_requested:true});
  assert.equal(task.scheduled_at,start); assert.ok(task.mirror_error); assert.equal(graph.events.size,1);
  const restarted=createTaskService(db,graph);
  task=await restarted.update({...ref(task),scheduled_at:null,mirror_requested:false});
  const creates=graph.calls.filter(c => c.method === "POST");
  assert.equal(creates.length,2); assert.deepEqual(creates[0].body,creates[1].body);
  assert.equal(graph.events.size,0); assert.equal(task.mirror_error,null); assert.equal(task.mirror_event_id,null);
});

test("offline provider retains local and stale cached tasks; account change rejects old references", async (t) => {
  const {service,graph}=fixture(t); await service.create({title:"Vietinė"});
  const remote=(await service.list()).items.find(t => t.source === "microsoft");
  graph.state.offline=true;
  const offline=await service.list(); assert.equal(offline.items.length,2); assert.ok(offline.warnings.length); assert.equal(offline.items[1].stale,true);
  graph.state.account="account-b"; graph.calls.length=0;
  await assert.rejects(service.update({...ref(remote),scheduled_at:start}), e => e.status === 409);
  assert.equal(graph.calls.length,0); assert.equal((await service.list()).items.length,1);
});

test("explicit Microsoft creation preserves source, deadline and local duration", async (t) => {
  const {service,graph}=fixture(t);
  const task=await service.create({source:"microsoft",title:"Nauja",duration_minutes:90,due_at:start});
  assert.equal(task.source,"microsoft"); assert.equal(task.due_at,start); assert.equal(task.scheduled_at,null); assert.equal(task.duration_minutes,90);
  assert.equal(graph.calls.length,1); assert.equal(graph.calls[0].url,"/me/todo/lists/list-a/tasks");
});

test("an account switch while resolving a list cannot create a task in the wrong account", async (t) => {
  const {service,graph}=fixture(t);
  graph.defaultListId=async () => {graph.state.account="account-b";return "list-b";};
  await assert.rejects(service.create({source:"microsoft",title:"Nauja"}),e => e.status === 409);
  assert.equal(graph.calls.length,0);
});

test("explicit UTC offsets on Microsoft deadlines are normalized without appending a second zone", async (t) => {
  const {service,graph}=fixture(t);
  graph.remote.get("1").dueDateTime={dateTime:"2026-10-25T10:00:00+02:00",timeZone:"UTC"};
  assert.equal((await service.list()).items[0].due_at,start);
});

test("pagination is followed only for the same Graph task list", async (t) => {
  const {db,graph}=fixture(t); let calls=0;
  graph.request=async () => { calls++; return {value:[],"@odata.nextLink":"https://evil.example/v1.0/me/todo/lists/list-a/tasks"}; };
  const service=createTaskService(db,graph);
  assert.ok((await service.list()).warnings.length); assert.equal(calls,1);
  calls=0;
  graph.request=async (url) => {if(url.startsWith("/me/todo/lists?"))return {value:[{id:"list-a"}]};calls++; return calls===1 ? {value:[{id:"a",title:"Pirma"}],"@odata.nextLink":"https://graph.microsoft.com/v1.0/me/todo/lists/list-a/tasks?$skiptoken=next"} : {value:[{id:"b",title:"Antra"}]};};
  const result=await service.list(); assert.equal(result.items.length,2); assert.deepEqual(result.warnings,[]); assert.equal(calls,2);
});


test("Microsoft source completion clears persisted schedule without reviving it on restore", async (t) => {
  const {service,graph}=fixture(t); let task=(await service.list()).items[0];
  task=await service.update({...ref(task),scheduled_at:start});const stale=ref(task);
  graph.remote.get("1").status="completed";
  task=(await service.list()).items[0];assert.equal(task.completed,1);assert.equal(task.scheduled_at,null);
  await assert.rejects(service.update({...stale,scheduled_at:start}),e=>e.status===409);
  graph.remote.get("1").status="notStarted";
  task=(await service.list()).items[0];assert.equal(task.completed,0);assert.equal(task.scheduled_at,null);
  assert.ok(graph.calls.every(c=>c.method==="GET"));
});

test("Microsoft multi-list discovery and creation use selected account-bound lists, preserving identical task ids",async t=>{
  const {db,graph}=fixture(t);const writes=[];
  graph.request=async (raw,init={})=>{
    const u=new URL(raw,"https://fixture.invalid");
    if(u.pathname==="/me/todo/lists")return u.searchParams.has("$skiptoken")?{value:[{id:"second",displayName:"Antras",wellknownListName:"none"},{id:"flagged",wellknownListName:"flaggedEmails"}]}:{value:[{id:"first",displayName:"Pirmas"}],"@odata.nextLink":"https://graph.microsoft.com/v1.0/me/todo/lists?$skiptoken=next"};
    if(init.method==="POST"){writes.push({raw,body:JSON.parse(init.body)});return {id:"created",...JSON.parse(init.body)};}
    return {value:[{id:"same",title:"Užduotis"}]};
  };
  const service=createTaskService(db,graph),result=await service.list();assert.equal(result.lists.length,3);assert.equal(new Set(result.items.map(t=>t.key)).size,3);
  const task=await service.create({source:"microsoft",account_id:"account-a",list_id:"second",title:"Pasirinktas sąrašas"});
  assert.equal(task.list_id,"second");assert.equal(writes[0].raw,"/me/todo/lists/second/tasks");
  await assert.rejects(service.create({source:"microsoft",account_id:"account-a",list_id:"flagged",title:"Neleistina"}),e=>e.status===403);
  assert.equal(writes.length,1);const locked=result.items.find(t=>t.list_id==="flagged");
  await assert.rejects(service.update({...ref(locked),completed:true}),e=>e.status===403);
  assert.equal((await service.update({...ref(locked),scheduled_at:start})).scheduled_at,start);
});

test("source completion marks an existing Outlook block for explicit cleanup and retries safely",async t=>{
  const {service,graph}=fixture(t);let task=(await service.list()).items[0];
  task=await service.update({...ref(task),scheduled_at:start,mirror_requested:true});
  graph.remote.get("1").status="completed";graph.calls.length=0;
  task=(await service.list()).items[0];assert.equal(task.scheduled_at,null);assert.ok(task.mirror_error);assert.ok(graph.calls.every(c=>c.method==="GET"));
  task=await service.update({...ref(task),scheduled_at:null,mirror_requested:false});assert.equal(task.mirror_error,null);assert.equal(graph.events.size,0);
});
