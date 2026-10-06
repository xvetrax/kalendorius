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
// Routes now use MULTI_USER_DATABASE_PATH (falling back to DATABASE_PATH).
process.env.MULTI_USER_DATABASE_PATH=path.join(temp,"multi.db");
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
const {encrypt}=await import("../lib/secrets.ts");
// Multi-user db: routes use this for tasks/plans; we also bootstrap a test session here
const {db:multiDb,createSession}=await import("../lib/db-multi.ts");
const {SESSION_COOKIE}=await import("../lib/db-multi.ts");
const notificationJobs=await import("../lib/notification-jobs.ts");
const notificationWorker=await import("../lib/notification-worker.ts");
const pushNotifications=await import("../lib/push-notifications.ts");
const route=await import("../app/api/tasks/route.ts");
const moveRoute=await import("../app/api/tasks/move/route.ts");
const orderRoute=await import("../app/api/tasks/order/route.ts");
const cleanupRoute=await import("../app/api/tasks/mirror-cleanup/route.ts");

// Bootstrap a test user in the multi-user DB and create a session
let testUserId, sessionCookie;
function bootstrapTestUser() {
  // Insert user if not exists
  const existing = multiDb.prepare("SELECT id FROM users LIMIT 1").get();
  if (existing) {
    testUserId = existing.id;
  } else {
    const result = multiDb.prepare(
      "INSERT INTO users (display_name, primary_email, role, status, created_at) VALUES (?, ?, 'admin', 'active', CURRENT_TIMESTAMP)"
    ).run("Test User", "test@example.com");
    testUserId = Number(result.lastInsertRowid);
  }
  const {rawToken} = createSession(testUserId);
  sessionCookie = `${SESSION_COOKIE}=${rawToken}`;
}
bootstrapTestUser();

const taskScope="https://www.googleapis.com/auth/tasks";
function connect() {
  // Clear multi-user tables for this user
  multiDb.exec(`DELETE FROM notification_deliveries WHERE job_id IN (SELECT id FROM notification_jobs WHERE user_id=${testUserId});DELETE FROM notification_jobs WHERE user_id=${testUserId};DELETE FROM notification_preferences WHERE user_id=${testUserId};DELETE FROM push_subscriptions WHERE user_id=${testUserId};DELETE FROM tasks WHERE user_id=${testUserId};DELETE FROM remote_tasks WHERE user_id=${testUserId};DELETE FROM remote_task_lists WHERE user_id=${testUserId};DELETE FROM task_plans WHERE user_id=${testUserId};DELETE FROM oauth_connections WHERE user_id=${testUserId};`);
  // Insert per-user oauth_connections (replaces legacy saveSetting for tokens)
  multiDb.prepare(`
    INSERT INTO oauth_connections (user_id, provider, provider_account_id, provider_email, encrypted_refresh_token, scopes, generation, status)
    VALUES (?, 'microsoft', 'microsoft-account', 'test@microsoft.example', ?, ?, 1, 'active')
  `).run(testUserId, encrypt("microsoft-refresh"), "openid offline_access User.Read Calendars.ReadWrite Tasks.ReadWrite");
  multiDb.prepare(`
    INSERT INTO oauth_connections (user_id, provider, provider_account_id, provider_email, encrypted_refresh_token, scopes, generation, status)
    VALUES (?, 'google', 'google-account', 'test@google.example', ?, ?, 1, 'active')
  `).run(testUserId, encrypt("google-refresh"), `${taskScope} https://www.googleapis.com/auth/calendar`);
}
beforeEach(()=>{upstream.reset();connect();});
after(()=>{globalThis.fetch=originalFetch;multiDb.close();hooks.deregister();rmSync(temp,{recursive:true,force:true});});

const url="http://localhost:3000/api/tasks";
const request=(method,body,origin="http://localhost:3000")=>new Request(url,{method,headers:{Origin:origin,"Content-Type":"application/json",Cookie:sessionCookie},body:body === undefined ? undefined : JSON.stringify(body)});
const list=async()=>route.GET(new Request(url+"?envelope=1",{headers:{Cookie:sessionCookie}}));
const ref=task=>({id:task.id,source:task.source,account_id:task.account_id,list_id:task.list_id,schedule_version:task.schedule_version});
const item=(envelope,source)=>envelope.items.find(task=>task.source===source);
const pushSample=suffix=>pushNotifications.parsePushSubscription({
  endpoint:`https://fcm.googleapis.com/fcm/send/${suffix}`,expirationTime:null,
  keys:{p256dh:"A".repeat(87),auth:"B".repeat(22)},deviceName:`Chrome ${suffix}`,
});

async function prepareInterruptedGoogleMove(deliveryState) {
  notificationJobs.updateTaskStartPreference(testUserId,true,10);
  pushNotifications.savePushSubscription(testUserId,pushSample(`recovery-${deliveryState}`));
  upstream.googleLists.set("google-list-b",{id:"google-list-b",title:"Google kitas",etag:"google-list-b-v1",_revision:1});
  upstream.googleListTasks.set("google-list-b",new Map());
  const base=Date.now();
  let task=item(await (await list()).json(),"google");
  task=await (await route.PATCH(request("PATCH",{...ref(task),scheduled_at:new Date(base+11*60_000).toISOString()}))).json();
  const before=multiDb.prepare("SELECT id,source_key FROM notification_jobs WHERE user_id=? AND scenario='task_start'").get(testUserId);
  const sent=await notificationWorker.processNotificationTick({
    workerId:`recovery-${deliveryState}`,
    now:new Date(base+2*60_000),
    send:deliveryState==="accepted" ? async()=>undefined : async()=>{throw new Error("synthetic timeout");},
  });
  assert.equal(sent.state,deliveryState);
  upstream.failGoogleTaskGetOnce=true;
  const moveResponse=await moveRoute.POST(new Request(url+"/move",{method:"POST",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify({...ref(task),destination_list_id:"google-list-b"})}));
  assert.ok(moveResponse.status>=500);
  assert.equal(multiDb.prepare("SELECT COUNT(*) count FROM user_settings WHERE user_id=? AND key LIKE 'task_move_pending:%'").get(testUserId).count,1);
  return {before,task};
}

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
    const remove=await route.DELETE(new Request(`${url}?${new URLSearchParams(ref(task))}`,{method:"DELETE",headers:{Origin:"http://localhost:3000",Cookie:sessionCookie}})); assert.equal(remove.status,200);
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

test("task routes atomically replace and cancel task-start notification jobs",async()=>{
  notificationJobs.updateTaskStartPreference(testUserId,true,10);
  let task=await (await route.POST(request("POST",{title:"Primenama vietinė"}))).json();
  task=await (await route.PATCH(request("PATCH",{...ref(task),scheduled_at:"2099-11-06T10:00:00.000Z"}))).json();
  let active=multiDb.prepare(`SELECT id,run_at FROM notification_jobs WHERE user_id=? AND scenario='task_start'
    AND cancelled_at IS NULL AND completed_at IS NULL`).all(testUserId);
  assert.equal(active.length,1);assert.equal(active[0].run_at,"2099-11-06T09:50:00.000Z");

  task=await (await route.PATCH(request("PATCH",{...ref(task),scheduled_at:"2099-11-06T11:00:00.000Z"}))).json();
  active=multiDb.prepare(`SELECT id,run_at FROM notification_jobs WHERE user_id=? AND scenario='task_start'
    AND cancelled_at IS NULL AND completed_at IS NULL`).all(testUserId);
  assert.equal(active.length,1);assert.equal(active[0].run_at,"2099-11-06T10:50:00.000Z");
  assert.equal(multiDb.prepare("SELECT COUNT(*) count FROM notification_jobs WHERE user_id=? AND scenario='task_start' AND cancelled_at IS NOT NULL").get(testUserId).count,1);

  task=await (await route.PATCH(request("PATCH",{...ref(task),completed:true}))).json();
  assert.equal(task.scheduled_at,null);
  assert.equal(multiDb.prepare("SELECT COUNT(*) count FROM notification_jobs WHERE user_id=? AND scenario='task_start' AND cancelled_at IS NULL AND completed_at IS NULL").get(testUserId).count,0);
  task=await (await route.PATCH(request("PATCH",{...ref(task),completed:false}))).json();
  assert.equal(task.scheduled_at,null);
  task=await (await route.PATCH(request("PATCH",{...ref(task),scheduled_at:"2099-11-06T12:00:00.000Z"}))).json();
  assert.equal(multiDb.prepare("SELECT COUNT(*) count FROM notification_jobs WHERE user_id=? AND scenario='task_start' AND cancelled_at IS NULL AND completed_at IS NULL").get(testUserId).count,1);
  assert.equal((await route.DELETE(new Request(`${url}?${new URLSearchParams(ref(task))}`,{method:"DELETE",headers:{Origin:"http://localhost:3000",Cookie:sessionCookie}}))).status,200);
  assert.equal(multiDb.prepare("SELECT COUNT(*) count FROM notification_jobs WHERE user_id=? AND scenario='task_start' AND cancelled_at IS NULL AND completed_at IS NULL").get(testUserId).count,0);
});

test("fresh provider completion and deletion cancel task-start jobs",async()=>{
  notificationJobs.updateTaskStartPreference(testUserId,true,10);
  let envelope=await (await list()).json();
  let google=item(envelope,"google"),microsoft=item(envelope,"microsoft");
  google=await (await route.PATCH(request("PATCH",{...ref(google),scheduled_at:"2099-11-08T10:00:00.000Z"}))).json();
  microsoft=await (await route.PATCH(request("PATCH",{...ref(microsoft),scheduled_at:"2099-11-08T11:00:00.000Z"}))).json();
  assert.equal(multiDb.prepare("SELECT COUNT(*) count FROM notification_jobs WHERE user_id=? AND scenario='task_start' AND cancelled_at IS NULL AND completed_at IS NULL").get(testUserId).count,2);
  upstream.google.get(String(google.id)).status="completed";
  upstream.microsoft.delete(String(microsoft.id));
  envelope=await (await list()).json();
  assert.equal(envelope.items.find(task=>task.key===google.key).completed,1);
  assert.equal(envelope.items.some(task=>task.key===microsoft.key),false);
  assert.equal(multiDb.prepare("SELECT COUNT(*) count FROM notification_jobs WHERE user_id=? AND scenario='task_start' AND cancelled_at IS NULL AND completed_at IS NULL").get(testUserId).count,0);
});

test("task mutations enforce same-origin and refresh cached remote task source data",async()=>{
  // Same-origin check fires before session check, so no Cookie needed for this test
  assert.equal((await route.POST(new Request(url,{method:"POST",headers:{Origin:"https://attacker.example","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify({title:"Užblokuota"})}))).status,403);
  let result=await (await list()).json(); const before=item(result,"google");
  upstream.google.get("shared-id").title="Google atnaujinta paslaugoje";
  result=await (await list()).json(); const refreshed=item(result,"google");
  assert.equal(refreshed.title,"Google atnaujinta paslaugoje"); assert.equal(refreshed.key,before.key);
});

test("an account swap rejects references selected for the old provider account",async()=>{
  const result=await (await list()).json();
  for(const source of ["microsoft","google"]){
    const task=item(result,source);
    // Simulate account swap by updating the provider_account_id in oauth_connections
    multiDb.prepare(`UPDATE oauth_connections SET provider_account_id = ? WHERE user_id = ? AND provider = ?`).run(`${source}-other-account`,testUserId,source);
    const response=await route.PATCH(request("PATCH",{...ref(task),scheduled_at:"2026-11-04T08:00:00.000Z"}));
    assert.equal(response.status,409);
    // Restore original account id
    multiDb.prepare(`UPDATE oauth_connections SET provider_account_id = ? WHERE user_id = ? AND provider = ?`).run(`${source}-account`,testUserId,source);
  }
});

test("actual Google move route preserves the plan under its destination identity",async()=>{
  notificationJobs.updateTaskStartPreference(testUserId,true,10);
  upstream.googleLists.set("google-list-b",{id:"google-list-b",title:"Google kitas",etag:"google-list-b-v1",_revision:1});
  upstream.googleListTasks.set("google-list-b",new Map());
  let task=item(await (await list()).json(),"google");
  task=await (await route.PATCH(request("PATCH",{...ref(task),scheduled_at:"2099-11-05T08:00:00.000Z",duration_minutes:55,project:"Darbas",tags:"perkelta"}))).json();
  const oldNotification=multiDb.prepare("SELECT source_key FROM notification_jobs WHERE user_id=? AND scenario='task_start' AND cancelled_at IS NULL").get(testUserId).source_key;
  const moveRequest=new Request(url+"/move",{method:"POST",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify({...ref(task),destination_list_id:"google-list-b"})});
  const response=await moveRoute.POST(moveRequest);assert.equal(response.status,200);const moved=await response.json();
  assert.equal(moved.list_id,"google-list-b");assert.equal(moved.scheduled_at,"2099-11-05T08:00:00.000Z");assert.equal(moved.duration_minutes,55);assert.equal(moved.project,"Darbas");assert.equal(moved.tags,"perkelta");assert.equal(moved.schedule_version,task.schedule_version+1);
  const movedNotification=multiDb.prepare("SELECT source_key FROM notification_jobs WHERE user_id=? AND scenario='task_start' AND cancelled_at IS NULL").get(testUserId).source_key;
  assert.notEqual(movedNotification,oldNotification);
  const refreshed=await (await list()).json(),listed=refreshed.items.find(entry=>entry.key===moved.key);
  assert.ok(listed);assert.equal(listed.scheduled_at,moved.scheduled_at);assert.equal(refreshed.items.some(entry=>entry.key===task.key),false);
  assert.equal((await moveRoute.POST(new Request(url+"/move",{method:"POST",headers:{Origin:"https://attacker.example","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify({...ref(moved),destination_list_id:"google-list"})}))).status,403);
});

for(const deliveryState of ["accepted","ambiguous"]){
test(`interrupted Google move recovery preserves ${deliveryState} task-start delivery`,async()=>{
  const {before}=await prepareInterruptedGoogleMove(deliveryState);
  const envelope=await (await list()).json(),moved=envelope.items.find(task=>task.source==="google"&&task.list_id==="google-list-b");
  assert.ok(moved);
  const jobs=multiDb.prepare("SELECT id,source_key,cancelled_at FROM notification_jobs WHERE user_id=? AND scenario='task_start'").all(testUserId);
  assert.equal(jobs.length,1);assert.equal(jobs[0].id,before.id);assert.notEqual(jobs[0].source_key,before.source_key);assert.equal(jobs[0].cancelled_at,null);
  assert.equal(multiDb.prepare("SELECT state FROM notification_deliveries WHERE job_id=?").get(before.id).state,deliveryState);
  assert.equal(multiDb.prepare("SELECT COUNT(*) count FROM user_settings WHERE user_id=? AND key LIKE 'task_move_pending:%'").get(testUserId).count,0);
});
}

test("interrupted Google move recovery cancels a completed destination task reminder",async()=>{
  notificationJobs.updateTaskStartPreference(testUserId,true,10);
  upstream.googleLists.set("google-list-b",{id:"google-list-b",title:"Google kitas",etag:"google-list-b-v1",_revision:1});
  upstream.googleListTasks.set("google-list-b",new Map());
  let task=item(await (await list()).json(),"google");
  task=await (await route.PATCH(request("PATCH",{...ref(task),scheduled_at:new Date(Date.now()+60*60_000).toISOString()}))).json();
  const before=multiDb.prepare("SELECT id FROM notification_jobs WHERE user_id=? AND scenario='task_start'").get(testUserId);
  upstream.failGoogleTaskGetOnce=true;
  const moveResponse=await moveRoute.POST(new Request(url+"/move",{method:"POST",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify({...ref(task),destination_list_id:"google-list-b"})}));
  assert.ok(moveResponse.status>=500);
  upstream.googleListTasks.get("google-list-b").get(String(task.id)).status="completed";
  const envelope=await (await list()).json(),moved=envelope.items.find(entry=>entry.source==="google"&&entry.list_id==="google-list-b");
  assert.ok(moved);assert.equal(moved.completed,1);assert.equal(moved.scheduled_at,null);
  const plan=multiDb.prepare("SELECT task_key,scheduled_at FROM task_plans WHERE user_id=?").get(testUserId);
  assert.equal(plan.task_key,moved.key);assert.equal(plan.scheduled_at,null);
  const jobs=multiDb.prepare("SELECT id,cancelled_at FROM notification_jobs WHERE user_id=? AND scenario='task_start'").all(testUserId);
  assert.equal(jobs.length,1);assert.equal(jobs[0].id,before.id);assert.ok(jobs[0].cancelled_at);
  assert.equal(multiDb.prepare("SELECT COUNT(*) count FROM notification_jobs WHERE user_id=? AND scenario='task_start' AND cancelled_at IS NULL AND completed_at IS NULL").get(testUserId).count,0);
});

test("Google move ignores another user's matching destination task identity",async()=>{
  upstream.googleLists.set("google-list-b",{id:"google-list-b",title:"Google kitas",etag:"google-list-b-v1",_revision:1});
  upstream.googleListTasks.set("google-list-b",new Map());
  let task=item(await (await list()).json(),"google");
  task=await (await route.PATCH(request("PATCH",{...ref(task),scheduled_at:"2099-11-07T08:00:00.000Z"}))).json();
  const foreignUser=Number(multiDb.prepare("INSERT INTO users(display_name,primary_email,role,status) VALUES ('Kitas','other@example.test','member','active')").run().lastInsertRowid);
  const destinationKey=JSON.stringify(["google","google-account","google-list-b",String(task.id)]);
  multiDb.prepare("INSERT INTO remote_tasks(user_id,task_key,account_id,list_id,task_json,source) VALUES (?,?,?,?,?,'google')")
    .run(foreignUser,destinationKey,"google-account","google-list-b",JSON.stringify({id:"foreign-id"}));
  try {
    const response=await moveRoute.POST(new Request(url+"/move",{method:"POST",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify({...ref(task),destination_list_id:"google-list-b"})}));
    assert.equal(response.status,200);
  } finally {
    multiDb.prepare("DELETE FROM users WHERE id=?").run(foreignUser);
  }
});

test("actual Google order route applies parent and previous with a versioned snapshot",async()=>{
  upstream.google.set("parent",{id:"parent",title:"Projektas",status:"needsAction"});
  upstream.google.set("first",{id:"first",title:"Pirma",parent:"parent",status:"needsAction"});
  const task=item(await (await list()).json(),"google"),orderUrl=url+"/order";
  const query=new URLSearchParams({source:"google",account_id:task.account_id,list_id:task.list_id,id:String(task.id)});
  let response=await orderRoute.GET(new Request(`${orderUrl}?${query}`,{headers:{Cookie:sessionCookie}}));assert.equal(response.status,200);const snapshot=await response.json();
  response=await orderRoute.PATCH(new Request(orderUrl,{method:"PATCH",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify({...Object.fromEntries(query),version:snapshot.version,parent_id:"parent",previous_id:"first"})}));
  assert.equal(response.status,200);const updated=await response.json();assert.equal(updated.parent_id,"parent");assert.equal(updated.previous_id,"first");
  assert.ok(upstream.writes("google").some(write=>write.path.endsWith("/shared-id/move?parent=parent&previous=first")));
  const hostile=await orderRoute.PATCH(new Request(orderUrl,{method:"PATCH",headers:{Origin:"https://attacker.example","Content-Type":"application/json",Cookie:sessionCookie},body:"{}"}));assert.equal(hostile.status,403);
});

test("Outlook mirror cleanup route enforces same-origin and removes a local-only orphan",async()=>{
  const taskKey=JSON.stringify(["google","google-account","google-list","deleted-task"]);
  const orphanedAt="2026-09-23 10:00:00";
  multiDb.prepare(`INSERT INTO task_plans(user_id,task_key,mirror_requested,mirror_orphaned_at,mirror_orphan_title,mirror_error)
    VALUES (?,?,1,?,?,?)`).run(testUserId,taskKey,orphanedAt,"Ištrinta", "Užduotis pašalinta šaltinyje. Pašalink likusį Outlook bloką nustatymuose.");
  const cleanupUrl=url+"/mirror-cleanup";
  const body={task_key:taskKey,orphaned_at:orphanedAt,mirror_event_id:null};
  // CSRF rejection fires before session check
  const hostile=await cleanupRoute.POST(new Request(cleanupUrl,{method:"POST",headers:{Origin:"https://attacker.example","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify(body)}));
  assert.equal(hostile.status,403);
  const invalid=await cleanupRoute.POST(new Request(cleanupUrl,{method:"POST",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:"null"}));
  assert.equal(invalid.status,400);
  const response=await cleanupRoute.POST(new Request(cleanupUrl,{method:"POST",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify(body)}));
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});
  assert.equal(multiDb.prepare("SELECT 1 FROM task_plans WHERE task_key=? AND user_id=?").get(taskKey,testUserId),undefined);
  const repeated=await cleanupRoute.POST(new Request(cleanupUrl,{method:"POST",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify(body)}));
  assert.equal(repeated.status,200);assert.deepEqual(await repeated.json(),{ok:true});
});
