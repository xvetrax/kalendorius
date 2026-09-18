import assert from "node:assert/strict";
import {test,after,beforeEach} from "node:test";
import {registerHooks} from "node:module";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

const temp=mkdtempSync(path.join(tmpdir(),"planner-task-reminders-"));
process.env.DATABASE_PATH=path.join(temp,"test.db");
process.env.TOKEN_ENCRYPTION_KEY="ab".repeat(32);
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
const route=await import("../app/api/tasks/reminder/route.ts");
const tasksRoute=await import("../app/api/tasks/route.ts");
const fixtureFetch=globalThis.fetch;
let intercept=null;
globalThis.fetch=(url,init)=>intercept ? intercept(String(url),init,fixtureFetch) : fixtureFetch(url,init);

function connect() {
  db.exec("DELETE FROM settings; DELETE FROM tasks; DELETE FROM remote_tasks; DELETE FROM remote_task_lists; DELETE FROM task_plans;");
  for(const source of ["google","microsoft"]){
    saveSetting(`${source}_refresh_token`,encrypt(`${source}-refresh`));
    saveSetting(`${source}_account_id`,`${source}-account`);
    saveSetting(`${source}_connection_generation`,`${source}-generation`);
  }
  saveSetting("google_granted_scopes","https://www.googleapis.com/auth/tasks");
}
beforeEach(()=>{upstream.reset();connect();intercept=null;});
after(()=>{globalThis.fetch=originalFetch;db.close();hooks.deregister();rmSync(temp,{recursive:true,force:true});});

const api="http://localhost:3000/api/tasks/reminder";
const ref={source:"microsoft",account_id:"microsoft-account",list_id:"microsoft-list",id:"shared-id"};
const req=(body,origin="http://localhost:3000")=>new Request(api,{method:"PATCH",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(body)});
const read=(reference=ref)=>route.GET(new Request(`${api}?${new URLSearchParams(reference)}`));
const snapshot=async()=>{const response=await read();assert.equal(response.status,200);return response.json();};
const patch=async(current,changes,reference=ref)=>route.PATCH(req({...reference,version:current.version,...changes}));
const rows=()=>Object.fromEntries(["tasks","remote_tasks","task_plans","remote_task_lists"].map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all()]));

test("Microsoft reminder enable, retime and disable write only reminder fields and preserve plans/recurrence/metadata",async()=>{
  const task=upstream.microsoft.get("shared-id");
  task.recurrence={pattern:{type:"weekly",interval:1,daysOfWeek:["monday"]},range:{type:"noEnd",startDate:"2026-09-17"}};
  task.checklistItems=[{id:"step",displayName:"Keep step",isChecked:false}];
  task.startDateTime={dateTime:"2026-10-20T07:00:00",timeZone:"UTC"};
  await tasksRoute.GET(new Request("http://localhost:3000/api/tasks"));
  const key=JSON.stringify(["microsoft","microsoft-account","microsoft-list","shared-id"]);
  db.prepare("INSERT INTO task_plans(task_key,scheduled_at,duration_minutes,mirror_requested,mirror_event_id) VALUES (?,?,?,?,?)").run(key,"2026-10-24T10:00:00.000Z",75,1,"untouched-mirror");
  const before=structuredClone(task),localBefore=rows();
  const response=await read();assert.equal(response.headers.get("cache-control"),"no-store");let current=await response.json();assert.equal(current.enabled,false);assert.equal(current.recurring,true);
  let saved=await patch(current,{enabled:true,at:"2026-10-25T10:30:00+02:00",title:"Must not overwrite",recurrence:null});assert.equal(saved.status,200);current=await saved.json();
  assert.equal(current.enabled,true);assert.equal(current.at,"2026-10-25T08:30:00.000Z");
  saved=await patch(current,{enabled:true,at:"2026-10-26T08:45:00.000Z"});assert.equal(saved.status,200);current=await saved.json();
  assert.equal(current.at,"2026-10-26T08:45:00.000Z");
  saved=await patch(current,{enabled:false});assert.equal(saved.status,200);current=await saved.json();assert.equal(current.enabled,false);
  assert.equal((await snapshot()).enabled,false);
  assert.deepEqual(rows(),localBefore);
  for(const field of ["title","status","body","dueDateTime","importance","recurrence","checklistItems","startDateTime"])assert.deepEqual(task[field],before[field]);
  const writes=upstream.writes("microsoft");assert.equal(writes.length,3);assert.ok(writes.every(write=>write.path.endsWith("/tasks/shared-id")&&write.ifMatch));
  assert.deepEqual(writes.map(write=>write.body),[{isReminderOn:true,reminderDateTime:{dateTime:"2026-10-25T08:30:00.000",timeZone:"UTC"}},{isReminderOn:true,reminderDateTime:{dateTime:"2026-10-26T08:45:00.000",timeZone:"UTC"}},{isReminderOn:false}]);
});

test("reminder rejects stale versions, same-ID foreign lists and wrong accounts without writes",async()=>{
  const current=await snapshot();upstream.microsoft.get("shared-id").isReminderOn=true;
  assert.equal((await patch(current,{enabled:false})).status,409);
  assert.equal((await patch(current,{enabled:false},{...ref,account_id:"other"})).status,409);
  upstream.microsoftLists.set("other",{id:"other",displayName:"Other",wellknownListName:"none",isOwner:true});
  upstream.microsoftListTasks.set("other",new Map([["shared-id",structuredClone(upstream.microsoft.get("shared-id"))]]));
  assert.equal((await patch(await snapshot(),{enabled:false},{...ref,list_id:"other"})).status,409);
  assert.equal(upstream.writes("microsoft").length,0);
});

test("reminder validates exact dates, types, source and CSRF before writes",async()=>{
  const current=await snapshot();
  for(const at of [null,"",123,"2026-10-25","2026-10-25T10:30:00","2026-02-30T10:30:00Z","2026-10-25T24:00:00Z","2026-10-25T10:30:00+25:00"]){
    assert.equal((await patch(current,{enabled:true,at})).status,400,String(at));
  }
  for(const enabled of [null,"true",0])assert.equal((await patch(current,{enabled})).status,400);
  for(const source of ["google","local"])assert.equal((await patch(current,{enabled:false},{...ref,source})).status,400);
  assert.equal((await route.PATCH(req({...ref,enabled:false,version:current.version},"https://attacker.example"))).status,403);
  assert.equal((await route.PATCH(req(null))).status,400);
  assert.equal(upstream.writes("microsoft").length,0);assert.equal(upstream.writes("google").length,0);
});

test("special lists and completed tasks expose a read-only reminder and reject writes",async()=>{
  upstream.microsoftLists.get("microsoft-list").wellknownListName="flaggedEmails";
  let current=await snapshot();assert.ok(current.readonly_reason);assert.equal((await patch(current,{enabled:false})).status,403);
  upstream.microsoftLists.get("microsoft-list").wellknownListName="defaultList";upstream.microsoft.get("shared-id").status="completed";
  current=await snapshot();assert.match(current.readonly_reason,/Užbaigtos/);assert.equal((await patch(current,{enabled:false})).status,403);assert.equal(upstream.writes("microsoft").length,0);
});

test("provider reminder wall-clock zones are never silently interpreted as UTC",async()=>{
  const task=upstream.microsoft.get("shared-id");task.isReminderOn=true;
  for(const timeZone of ["FLE Standard Time","Europe/Vilnius","Unknown Zone"]){task.reminderDateTime={dateTime:"2026-10-25T03:30:00.0000000",timeZone};const current=await snapshot();assert.equal(current.at,null);assert.deepEqual(current.source_time,task.reminderDateTime);}
  task.reminderDateTime={dateTime:"2026-10-25T03:30:00.1234567",timeZone:"UTC"};assert.equal((await snapshot()).at,"2026-10-25T03:30:00.123Z");
  task.reminderDateTime={dateTime:"2026-10-25T03:30:00+03:00",timeZone:"FLE Standard Time"};assert.equal((await snapshot()).at,"2026-10-25T00:30:00.000Z");
});

test("provider errors, ETag conflicts and account changes preserve all local data",async()=>{
  await tasksRoute.GET(new Request("http://localhost:3000/api/tasks"));const current=await snapshot(),before=rows();
  intercept=async(url,init,next)=>url.includes("/tasks/shared-id")&&init?.method==="PATCH" ? Response.json({error:"Changed"},{status:412}) : next(url,init);
  assert.equal((await patch(current,{enabled:true,at:"2026-10-25T08:30:00Z"})).status,409);assert.deepEqual(rows(),before);
  intercept=async(url,init,next)=>url.includes("/tasks/shared-id") ? Response.json({error:"Offline"},{status:503}) : next(url,init);
  assert.equal((await read()).status,502);assert.equal((await patch(current,{enabled:false})).status,502);assert.deepEqual(rows(),before);
  intercept=async(url,init,next)=>{const result=await next(url,init);if(url.includes("/tasks/shared-id")){saveSetting("microsoft_account_id","switched");saveSetting("microsoft_connection_generation","switched");}return result;};
  assert.notEqual((await patch(current,{enabled:false})).status,200);assert.deepEqual(rows(),before);assert.equal(upstream.writes("microsoft").length,0);
});

test("simultaneous reminder updates accept only the first observed version",async()=>{
  const current=await snapshot();const results=await Promise.all([patch(current,{enabled:true,at:"2026-10-25T08:30:00Z"}),patch(current,{enabled:true,at:"2026-10-25T09:30:00Z"})]);
  assert.deepEqual(results.map(result=>result.status),[200,409]);assert.equal(upstream.writes("microsoft").length,1);
});

test("unconfirmed provider write response is surfaced as failure without changing local state",async()=>{
  const current=await snapshot(),before=rows();
  intercept=async(url,init,next)=>{const result=await next(url,init);if(url.includes("/tasks/shared-id")&&init?.method==="PATCH")throw Error("Response lost");return result;};
  assert.equal((await patch(current,{enabled:true,at:"2026-10-25T08:30:00Z"})).status,502);assert.deepEqual(rows(),before);
  intercept=null;assert.equal((await snapshot()).enabled,true);assert.equal(upstream.writes("microsoft").length,1);
});
