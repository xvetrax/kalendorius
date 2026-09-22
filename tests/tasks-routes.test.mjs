import assert from "node:assert/strict";
import {test,after,beforeEach} from "node:test";
import {registerHooks} from "node:module";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

// Exercise the actual route, provider adapters, encryption, and SQLite. The
// preload fixture accepts no live network hosts and does not import the DB.
const temp=mkdtempSync(path.join(tmpdir(),"planner-task-routes-"));
process.env.DATABASE_PATH=path.join(temp,"test.db");
process.env.TOKEN_ENCRYPTION_KEY="cd".repeat(32);
process.env.APP_ORIGIN="http://localhost:3000";
process.env.TASKS_TEST_FIXTURE="isolated";
for(const provider of ["GOOGLE","MICROSOFT"]){
  process.env[`${provider}_CLIENT_ID`]="synthetic-client";
  process.env[`${provider}_CLIENT_SECRET`]="synthetic-secret";
  process.env[`${provider}_REDIRECT_URI`]=`http://localhost:3000/api/${provider.toLowerCase()}/callback`;
}
const hooks=registerHooks({resolve(specifier,context,next){
  return next(specifier.startsWith("@/") ? pathToFileURL(path.resolve(import.meta.dirname,"..",specifier.slice(2)+".ts")).href : specifier,context);
}});
const originalFetch=globalThis.fetch;
const {upstream}=await import("./fixtures/tasks-upstream.mjs");
const {db,saveSetting}=await import("../lib/db.ts");
const {encrypt}=await import("../lib/secrets.ts");
const route=await import("../app/api/tasks/route.ts");
const moveRoute=await import("../app/api/tasks/move/route.ts");

const taskScope="https://www.googleapis.com/auth/tasks";
function connect() {
  db.exec("DELETE FROM settings; DELETE FROM tasks; DELETE FROM remote_tasks; DELETE FROM remote_task_lists; DELETE FROM task_plans;");
  saveSetting("microsoft_refresh_token",encrypt("microsoft-refresh"));
  saveSetting("microsoft_account_id","microsoft-account");
  saveSetting("microsoft_connection_generation","microsoft-generation");
  saveSetting("google_refresh_token",encrypt("google-refresh"));
  saveSetting("google_account_id","google-account");
  saveSetting("google_granted_scopes",`${taskScope} https://www.googleapis.com/auth/calendar`);
  saveSetting("google_connection_generation","google-generation");
}
beforeEach(()=>{upstream.reset();connect();});
after(()=>{globalThis.fetch=originalFetch;db.close();hooks.deregister();rmSync(temp,{recursive:true,force:true});});

const url="http://localhost:3000/api/tasks";
const request=(method,body,origin="http://localhost:3000")=>new Request(url,{method,headers:{Origin:origin,"Content-Type":"application/json"},body:body === undefined ? undefined : JSON.stringify(body)});
const list=async()=>route.GET(new Request(url+"?envelope=1"));
const ref=task=>({id:task.id,source:task.source,account_id:task.account_id,list_id:task.list_id,schedule_version:task.schedule_version});
const item=(envelope,source)=>envelope.items.find(task=>task.source===source);

test("actual task route lists both providers with collision-safe identities and Google date-only deadlines",async()=>{
  const response=await list(); assert.equal(response.status,200); assert.equal(response.headers.get("cache-control"),"no-store");
  const result=await response.json(); const ms=item(result,"microsoft"), google=item(result,"google");
  assert.ok(ms); assert.ok(google); assert.equal(ms.id,google.id); assert.notEqual(ms.key,google.key);
  assert.equal(ms.due_at,"2026-10-25T08:00:00.000Z");
  assert.equal(google.due_date,"2026-10-26"); assert.equal(google.due_at,null);
  assert.deepEqual(result.lists.map(entry=>entry.source).sort(),["google","microsoft"]);
});

test("actual task route performs provider CRUD, completion and restore",async()=>{
  for(const source of ["microsoft","google"]){
    const create=source === "google"
      ? {source,title:"Nauja Google",notes:"Pastaba",account_id:"google-account",list_id:"google-list",due_date:"2026-11-01",duration_minutes:45}
      : {source,title:"Nauja Microsoft",notes:"Pastaba",account_id:"microsoft-account",list_id:"microsoft-list",due_at:"2026-11-01T10:00:00.000Z",duration_minutes:45};
    const created=await route.POST(request("POST",create)); assert.equal(created.status,201); let task=await created.json();
    assert.equal(task.source,source); assert.equal(task.duration_minutes,45);
    const update=await route.PATCH(request("PATCH",{...ref(task),title:"Pakeista",completed:true})); assert.equal(update.status,200); task=await update.json(); assert.equal(task.completed,1);
    const restore=await route.PATCH(request("PATCH",{...ref(task),completed:false})); assert.equal(restore.status,200); task=await restore.json(); assert.equal(task.completed,0);
    const remove=await route.DELETE(new Request(`${url}?${new URLSearchParams(ref(task))}`,{method:"DELETE",headers:{Origin:"http://localhost:3000"}})); assert.equal(remove.status,200);
    const writes=upstream.writes(source); assert.deepEqual(writes.map(write=>write.method),["POST","PATCH","PATCH","DELETE"]);
    if(source==="google") { assert.equal(writes[0].body.due,"2026-11-01T00:00:00.000Z"); assert.equal(writes[1].body.status,"completed"); assert.equal(writes[2].body.status,"needsAction"); }
    else { assert.equal(writes[0].body.dueDateTime.dateTime,"2026-11-01T10:00:00.000"); assert.equal(writes[1].body.status,"completed"); assert.equal(writes[2].body.status,"notStarted"); }
  }
});

test("scheduling a remote task, moving it and resizing it sends no provider writes and rejects stale versions",async()=>{
  const response=await list(); const envelope=await response.json();
  for(const source of ["microsoft","google"]){
  const original=item(envelope,source);
  upstream.calls.length=0;
  const scheduled=await route.PATCH(request("PATCH",{...ref(original),scheduled_at:"2026-11-02T08:00:00.000Z"})); assert.equal(scheduled.status,200); let task=await scheduled.json();
  assert.equal(task.scheduled_at,"2026-11-02T08:00:00.000Z");
  const moved=await route.PATCH(request("PATCH",{...ref(task),scheduled_at:"2026-11-02T10:00:00.000Z",duration_minutes:75})); assert.equal(moved.status,200); task=await moved.json();
  assert.equal(task.scheduled_at,"2026-11-02T10:00:00.000Z"); assert.equal(task.duration_minutes,75);
  assert.equal(upstream.writes(source).length,0);
  const stale=await route.PATCH(request("PATCH",{...ref(original),scheduled_at:"2026-11-03T08:00:00.000Z"})); assert.equal(stale.status,409);
  }
});

test("task mutations enforce same-origin and refresh cached remote task source data",async()=>{
  assert.equal((await route.POST(request("POST",{title:"Užblokuota"},"https://attacker.example"))).status,403);
  let result=await (await list()).json(); const before=item(result,"google");
  upstream.google.get("shared-id").title="Google atnaujinta paslaugoje";
  result=await (await list()).json(); const refreshed=item(result,"google");
  assert.equal(refreshed.title,"Google atnaujinta paslaugoje"); assert.equal(refreshed.key,before.key);
});

test("an account swap rejects references selected for the old provider account",async()=>{
  const result=await (await list()).json();
  for(const source of ["microsoft","google"]){
    const task=item(result,source); saveSetting(`${source}_account_id`,`${source}-other-account`);
    const response=await route.PATCH(request("PATCH",{...ref(task),scheduled_at:"2026-11-04T08:00:00.000Z"}));
    assert.equal(response.status,409); saveSetting(`${source}_account_id`,`${source}-account`);
  }
});

test("actual Google move route preserves the plan under its destination identity",async()=>{
  upstream.googleLists.set("google-list-b",{id:"google-list-b",title:"Google kitas",etag:"google-list-b-v1",_revision:1});
  upstream.googleListTasks.set("google-list-b",new Map());
  let task=item(await (await list()).json(),"google");
  task=await (await route.PATCH(request("PATCH",{...ref(task),scheduled_at:"2026-11-05T08:00:00.000Z",duration_minutes:55,project:"Darbas",tags:"perkelta"}))).json();
  const moveRequest=new Request(url+"/move",{method:"POST",headers:{Origin:"http://localhost:3000","Content-Type":"application/json"},body:JSON.stringify({...ref(task),destination_list_id:"google-list-b"})});
  const response=await moveRoute.POST(moveRequest);assert.equal(response.status,200);const moved=await response.json();
  assert.equal(moved.list_id,"google-list-b");assert.equal(moved.scheduled_at,"2026-11-05T08:00:00.000Z");assert.equal(moved.duration_minutes,55);assert.equal(moved.project,"Darbas");assert.equal(moved.tags,"perkelta");assert.equal(moved.schedule_version,task.schedule_version+1);
  const refreshed=await (await list()).json(),listed=refreshed.items.find(entry=>entry.key===moved.key);
  assert.ok(listed);assert.equal(listed.scheduled_at,moved.scheduled_at);assert.equal(refreshed.items.some(entry=>entry.key===task.key),false);
  assert.equal((await moveRoute.POST(request("POST",{...ref(moved),destination_list_id:"google-list"},"https://attacker.example"))).status,403);
});
