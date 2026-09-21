import assert from "node:assert/strict";
import {test,after,beforeEach} from "node:test";
import {registerHooks} from "node:module";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

const temp=mkdtempSync(path.join(tmpdir(),"planner-task-recurrence-"));
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
const route=await import("../app/api/tasks/recurrence/route.ts");
const reminderRoute=await import("../app/api/tasks/reminder/route.ts");
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

const api="http://localhost:3000/api/tasks/recurrence";
const reminderApi="http://localhost:3000/api/tasks/reminder";
const ref={source:"microsoft",account_id:"microsoft-account",list_id:"microsoft-list",id:"shared-id"};
const req=(body,origin="http://localhost:3000")=>new Request(api,{method:"PATCH",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(body)});
const read=(reference=ref)=>route.GET(new Request(`${api}?${new URLSearchParams(reference)}`));
const snapshot=async(reference=ref)=>{const response=await read(reference);assert.equal(response.status,200);return response.json();};
const patch=async(current,recurrence,reference=ref)=>route.PATCH(req({...reference,version:current.version,recurrence}));
const reminderRead=()=>reminderRoute.GET(new Request(`${reminderApi}?${new URLSearchParams(ref)}`));
const reminderPatch=(current,changes)=>reminderRoute.PATCH(new Request(reminderApi,{method:"PATCH",headers:{Origin:"http://localhost:3000","Content-Type":"application/json"},body:JSON.stringify({...ref,version:current.version,...changes})}));
const rows=()=>Object.fromEntries(["tasks","remote_tasks","task_plans","remote_task_lists"].map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all()]));

const rules=[
  {rule:{frequency:"daily",interval:2,start_date:"2026-09-17"},graph:{pattern:{type:"daily",interval:2},range:{type:"noEnd",startDate:"2026-09-17"}}},
  {rule:{frequency:"weekly",interval:3,start_date:"2026-09-17",days_of_week:["monday","friday"]},graph:{pattern:{type:"weekly",interval:3,daysOfWeek:["monday","friday"],firstDayOfWeek:"monday"},range:{type:"noEnd",startDate:"2026-09-17"}}},
  {rule:{frequency:"monthly",interval:4,start_date:"2026-09-17",day_of_month:15},graph:{pattern:{type:"absoluteMonthly",interval:4,dayOfMonth:15},range:{type:"noEnd",startDate:"2026-09-17"}}},
  {rule:{frequency:"yearly",interval:1,start_date:"2026-09-17",day_of_month:29,month:2},graph:{pattern:{type:"absoluteYearly",interval:1,dayOfMonth:29,month:2},range:{type:"noEnd",startDate:"2026-09-17"}}},
];

test("Microsoft recurrence reads, writes every supported shape, clears, and preserves unrelated data",async()=>{
  const task=upstream.microsoft.get("shared-id");
  task.isReminderOn=true;task.reminderDateTime={dateTime:"2026-10-25T08:30:00.000",timeZone:"UTC"};
  task.checklistItems=[{id:"step",displayName:"Keep step",isChecked:false}];
  task.startDateTime={dateTime:"2026-10-20T07:00:00",timeZone:"UTC"};
  await tasksRoute.GET(new Request("http://localhost:3000/api/tasks"));
  const key=JSON.stringify(["microsoft","microsoft-account","microsoft-list","shared-id"]);
  db.prepare("INSERT INTO task_plans(task_key,scheduled_at,duration_minutes,mirror_requested,mirror_event_id) VALUES (?,?,?,?,?)").run(key,"2026-10-24T10:00:00.000Z",75,1,"untouched-mirror");
  const before=structuredClone(task),localBefore=rows();
  const response=await read();assert.equal(response.headers.get("cache-control"),"no-store");let current=await response.json();
  assert.deepEqual(current.recurrence,null);assert.equal(current.supported,true);assert.equal(typeof current.version,"string");
  for(const {rule} of rules){
    const saved=await patch(current,rule);assert.equal(saved.status,200);current=await saved.json();
    assert.deepEqual(current.recurrence,rule);assert.equal(current.supported,true);
  }
  const cleared=await patch(current,null);assert.equal(cleared.status,200);current=await cleared.json();
  assert.deepEqual(current.recurrence,null);assert.equal(current.supported,true);
  assert.deepEqual(rows(),localBefore);
  for(const field of ["title","status","body","dueDateTime","importance","isReminderOn","reminderDateTime","checklistItems","startDateTime"])assert.deepEqual(task[field],before[field]);
  assert.equal(task.recurrence,null);
  const writes=upstream.writes("microsoft");assert.equal(writes.length,rules.length+1);assert.ok(writes.every(write=>write.path.endsWith("/tasks/shared-id")&&write.ifMatch));
  assert.deepEqual(writes.map(write=>write.body),[...rules.map(({graph})=>({recurrence:graph})),{recurrence:null}]);
});

test("unsupported provider recurrence fails closed without writing it back",async()=>{
  const task=upstream.microsoft.get("shared-id");
  task.recurrence={pattern:{type:"relativeMonthly",interval:1,daysOfWeek:["monday"],index:"first"},range:{type:"noEnd",startDate:"2026-09-17"}};
  const current=await snapshot();assert.equal(current.supported,false);assert.deepEqual(current.recurrence,null);assert.ok(current.readonly_reason);
  assert.equal((await patch(current,null)).status,409);
  assert.equal((await patch(current,rules[0].rule)).status,409);
  assert.equal(upstream.writes("microsoft").length,0);
});

test("recurrence rejects malformed rules, foreign references, and CSRF before writing",async()=>{
  const current=await snapshot();
  const invalid=[
    undefined,[],"weekly",{},{frequency:"hourly",interval:1,start_date:"2026-09-17"},
    {frequency:"daily",interval:0,start_date:"2026-09-17"},{frequency:"daily",interval:1.5,start_date:"2026-09-17"},
    {frequency:"daily",interval:1,start_date:"2026-02-30"},{frequency:"daily",interval:1,start_date:"2026-09-17",days_of_week:["monday"]},
    {frequency:"weekly",interval:1,start_date:"2026-09-17"},{frequency:"weekly",interval:1,start_date:"2026-09-17",days_of_week:[]},
    {frequency:"weekly",interval:1,start_date:"2026-09-17",days_of_week:["monday","monday"]},
    {frequency:"monthly",interval:1,start_date:"2026-09-17"},{frequency:"monthly",interval:1,start_date:"2026-09-17",day_of_month:0},
    {frequency:"yearly",interval:1,start_date:"2026-09-17",day_of_month:15},{frequency:"yearly",interval:1,start_date:"2026-09-17",day_of_month:15,month:13},
    {...rules[0].rule,extra:"must-not-pass"},
  ];
  for(const recurrence of invalid) assert.equal((await patch(current,recurrence)).status,400,JSON.stringify(recurrence));
  for(const version of [undefined,"",123]) assert.equal((await route.PATCH(req({...ref,version,recurrence:rules[0].rule}))).status,400);
  for(const source of ["google","local"])assert.equal((await patch(current,rules[0].rule,{...ref,source})).status,400);
  assert.equal((await patch(current,rules[0].rule,{...ref,account_id:"other"})).status,409);
  upstream.microsoftLists.set("other",{id:"other",displayName:"Other",wellknownListName:"none",isOwner:true});
  upstream.microsoftListTasks.set("other",new Map([["shared-id",structuredClone(upstream.microsoft.get("shared-id"))]]));
  assert.equal((await patch(current,rules[0].rule,{...ref,list_id:"other"})).status,409);
  assert.equal((await route.PATCH(req({...ref,version:current.version,recurrence:rules[0].rule},"https://attacker.example"))).status,403);
  assert.equal((await route.PATCH(req(null))).status,400);
  assert.equal(upstream.writes("microsoft").length,0);assert.equal(upstream.writes("google").length,0);
});

test("special lists and completed tasks expose a read-only recurrence and reject writes",async()=>{
  upstream.microsoftLists.get("microsoft-list").wellknownListName="flaggedEmails";
  let current=await snapshot();assert.ok(current.readonly_reason);assert.equal((await patch(current,rules[0].rule)).status,403);
  upstream.microsoftLists.get("microsoft-list").wellknownListName="defaultList";upstream.microsoft.get("shared-id").status="completed";
  current=await snapshot();assert.match(current.readonly_reason,/Užbaigtos/);assert.equal((await patch(current,rules[0].rule)).status,403);
  assert.equal(upstream.writes("microsoft").length,0);
});

test("recurrence maps provider failures, conflicts, account changes, and an unconfirmed write without local mutation",async()=>{
  await tasksRoute.GET(new Request("http://localhost:3000/api/tasks"));const current=await snapshot(),before=rows();
  intercept=async(url,init,next)=>url.includes("/tasks/shared-id")&&init?.method==="PATCH" ? Response.json({error:"Changed"},{status:412}) : next(url,init);
  assert.equal((await patch(current,rules[0].rule)).status,409);assert.deepEqual(rows(),before);
  intercept=async(url,init,next)=>url.includes("/tasks/shared-id") ? Response.json({error:"Offline"},{status:503}) : next(url,init);
  assert.equal((await read()).status,502);assert.equal((await patch(current,rules[0].rule)).status,502);assert.deepEqual(rows(),before);
  intercept=async(url,init,next)=>{const result=await next(url,init);if(url.includes("/tasks/shared-id")){saveSetting("microsoft_account_id","switched");saveSetting("microsoft_connection_generation","switched");}return result;};
  assert.notEqual((await patch(current,rules[0].rule)).status,200);assert.deepEqual(rows(),before);assert.equal(upstream.writes("microsoft").length,0);

  connect();upstream.reset();intercept=null;const lostCurrent=await snapshot(),lostBefore=rows();
  intercept=async(url,init,next)=>{const result=await next(url,init);if(url.includes("/tasks/shared-id")&&init?.method==="PATCH")throw Error("Response lost");return result;};
  assert.equal((await patch(lostCurrent,rules[0].rule)).status,502);assert.deepEqual(rows(),lostBefore);
  intercept=null;assert.deepEqual((await snapshot()).recurrence,rules[0].rule);assert.equal(upstream.writes("microsoft").length,1);
});

test("simultaneous recurrence updates accept only the first observed version",async()=>{
  const current=await snapshot();const results=await Promise.all([patch(current,rules[0].rule),patch(current,rules[1].rule)]);
  assert.deepEqual(results.map(result=>result.status),[200,409]);assert.equal(upstream.writes("microsoft").length,1);
});

test("a recurrence change invalidates a previously read reminder snapshot",async()=>{
  const reminderResponse=await reminderRead();assert.equal(reminderResponse.status,200);const reminder=await reminderResponse.json();
  const current=await snapshot();assert.equal((await patch(current,rules[0].rule)).status,200);
  assert.equal((await reminderPatch(reminder,{enabled:false})).status,409);
  assert.equal(upstream.writes("microsoft").length,1);
});
