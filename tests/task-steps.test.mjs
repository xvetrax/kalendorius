import assert from "node:assert/strict";
import {after,beforeEach,test} from "node:test";
import {registerHooks} from "node:module";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

const temp=mkdtempSync(path.join(tmpdir(),"planner-task-steps-"));
process.env.DATABASE_PATH=path.join(temp,"test.db");
process.env.TOKEN_ENCRYPTION_KEY="ab".repeat(32);
process.env.APP_ORIGIN="http://localhost:3000";
process.env.TASKS_TEST_FIXTURE="isolated";
process.env.MICROSOFT_CLIENT_ID="synthetic-client";
process.env.MICROSOFT_CLIENT_SECRET="synthetic-secret";
process.env.MICROSOFT_REDIRECT_URI="http://localhost:3000/api/microsoft/callback";
const hooks=registerHooks({resolve(specifier,context,next){return next(specifier.startsWith("@/")?pathToFileURL(path.resolve(import.meta.dirname,"..",specifier.slice(2)+".ts")).href:specifier,context);}});
const originalFetch=globalThis.fetch;
const {upstream}=await import("./fixtures/tasks-upstream.mjs");
const {db,saveSetting}=await import("../lib/db.ts");
const {encrypt}=await import("../lib/secrets.ts");
const route=await import("../app/api/tasks/steps/route.ts");
const fixtureFetch=globalThis.fetch;
let intercept=null;
globalThis.fetch=(url,init)=>intercept?intercept(String(url),init,fixtureFetch):fixtureFetch(url,init);

function connect(){
  db.exec("DELETE FROM settings; DELETE FROM tasks; DELETE FROM remote_tasks; DELETE FROM remote_task_lists; DELETE FROM task_plans;");
  saveSetting("microsoft_refresh_token",encrypt("microsoft-refresh"));
  saveSetting("microsoft_account_id","microsoft-account");
  saveSetting("microsoft_connection_generation","microsoft-generation");
}
beforeEach(()=>{upstream.reset();connect();intercept=null;upstream.microsoft.get("shared-id").checklistItems=[{id:"step-a",displayName:"Pirmas",isChecked:false}];});
after(()=>{globalThis.fetch=originalFetch;db.close();hooks.deregister();rmSync(temp,{recursive:true,force:true});});

const api="http://localhost:3000/api/tasks/steps";
const ref={source:"microsoft",account_id:"microsoft-account",list_id:"microsoft-list",id:"shared-id"};
const read=(reference=ref)=>route.GET(new Request(`${api}?${new URLSearchParams(reference)}`));
const request=(method,body,origin="http://localhost:3000")=>new Request(api,{method,headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(body)});
const mutate=(method,current,changes,reference=ref)=>route[method](request(method,{...reference,version:current.version,...changes}));
const snapshot=async(reference=ref)=>{const response=await read(reference);assert.equal(response.status,200);return response.json();};

test("steps list, create, toggle and delete use account-bound versioned snapshots",async()=>{
  const task=upstream.microsoft.get("shared-id"),before={title:task.title,status:task.status,dueDateTime:structuredClone(task.dueDateTime),recurrence:task.recurrence};
  let current=await snapshot();assert.deepEqual(current.items,[{id:"step-a",displayName:"Pirmas",isChecked:false}]);assert.equal(typeof current.version,"string");
  let response=await mutate("POST",current,{displayName:"Antras"});assert.equal(response.status,201);current=await response.json();
  const created=current.items.find(item=>item.displayName==="Antras");assert.ok(created);assert.equal(created.isChecked,false);
  response=await mutate("PATCH",current,{step_id:created.id,isChecked:true});assert.equal(response.status,200);current=await response.json();
  assert.equal(current.items.find(item=>item.id===created.id).isChecked,true);
  response=await mutate("DELETE",current,{step_id:"step-a"});assert.equal(response.status,200);current=await response.json();
  assert.deepEqual(current.items.map(item=>item.id),[created.id]);assert.deepEqual({title:task.title,status:task.status,dueDateTime:task.dueDateTime,recurrence:task.recurrence},before);
  const writes=upstream.writes("microsoft");assert.deepEqual(writes.map(write=>write.method),["POST","PATCH","DELETE"]);
  assert.ok(writes.every(write=>write.path.includes("/lists/microsoft-list/tasks/shared-id/checklistItems")));
});

test("steps reject stale versions, foreign identities, malformed input and CSRF before writes",async()=>{
  const current=await snapshot();upstream.microsoft.get("shared-id").checklistItems.push({id:"external",displayName:"Kitur",isChecked:false});
  assert.equal((await mutate("PATCH",current,{step_id:"step-a",isChecked:true})).status,409);
  assert.equal((await mutate("POST",current,{displayName:"X"},{...ref,account_id:"other"})).status,409);
  upstream.microsoftLists.set("other",{id:"other",displayName:"Kitas",wellknownListName:"none",isOwner:true});
  upstream.microsoftListTasks.set("other",new Map([["shared-id",structuredClone(upstream.microsoft.get("shared-id"))]]));
  assert.equal((await mutate("POST",current,{displayName:"X"},{...ref,list_id:"other"})).status,409);
  assert.equal((await mutate("POST",current,{displayName:"X"},{...ref,source:"google"})).status,400);
  for(const displayName of [""," ",123,"x".repeat(1001)])assert.equal((await mutate("POST",current,{displayName})).status,400);
  assert.equal((await mutate("PATCH",current,{step_id:"step-a",isChecked:"true"})).status,400);
  assert.equal((await route.POST(request("POST",{...ref,version:current.version,displayName:"X"},"https://attacker.example"))).status,403);
  assert.equal(upstream.writes("microsoft").length,0);
});

test("steps follow only same-endpoint Graph next links and detect duplicate pages",async()=>{
  const stepPath="/v1.0/me/todo/lists/microsoft-list/tasks/shared-id/checklistItems",seen=[];
  intercept=async(url,init,next)=>{
    const parsed=new URL(url);if(parsed.pathname!==stepPath)return next(url,init);seen.push(parsed.href);
    return parsed.searchParams.has("$skiptoken")?Response.json({value:[{id:"step-b",displayName:"Antras",isChecked:true}]}):Response.json({value:[{id:"step-a",displayName:"Pirmas",isChecked:false}],"@odata.nextLink":`https://graph.microsoft.com${stepPath}?$skiptoken=two`});
  };
  const current=await snapshot();assert.deepEqual(current.items.map(item=>item.id),["step-a","step-b"]);assert.equal(seen.length,2);
  intercept=async(url,init,next)=>new URL(url).pathname===stepPath?Response.json({value:[],"@odata.nextLink":"https://evil.example/steal"}):next(url,init);
  assert.equal((await read()).status,502);
  intercept=async(url,init,next)=>new URL(url).pathname===stepPath?Response.json({value:[{id:"step-a",displayName:"Pirmas",isChecked:false},{id:"step-a",displayName:"Dublikatas",isChecked:true}]}):next(url,init);
  assert.equal((await read()).status,502);
});

test("special lists and completed tasks expose read-only steps",async()=>{
  upstream.microsoftLists.get("microsoft-list").wellknownListName="flaggedEmails";
  let current=await snapshot();assert.match(current.readonly_reason,/specialaus/);assert.equal((await mutate("POST",current,{displayName:"X"})).status,403);
  upstream.microsoftLists.get("microsoft-list").wellknownListName="defaultList";upstream.microsoft.get("shared-id").status="completed";
  current=await snapshot();assert.match(current.readonly_reason,/Užbaigtos/);assert.equal((await mutate("DELETE",current,{step_id:"step-a"})).status,403);
  assert.equal(upstream.writes("microsoft").length,0);
});

test("simultaneous step changes accept one snapshot and a lost response remains recoverable",async()=>{
  let current=await snapshot();
  const results=await Promise.all([mutate("PATCH",current,{step_id:"step-a",isChecked:true}),mutate("POST",current,{displayName:"Lygiagretus"})]);
  assert.deepEqual(results.map(response=>response.status),[200,409]);assert.equal(upstream.writes("microsoft").length,1);
  current=await snapshot();
  intercept=async(url,init,next)=>{const result=await next(url,init);if(url.includes("/checklistItems/step-a")&&init?.method==="PATCH")throw Error("Response lost");return result;};
  const lost=await mutate("PATCH",current,{step_id:"step-a",isChecked:false});assert.equal(lost.status,502);
  intercept=null;assert.equal((await snapshot()).items.find(item=>item.id==="step-a").isChecked,false);
});
