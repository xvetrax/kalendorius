import assert from "node:assert/strict";
import {test,after,beforeEach} from "node:test";
import {registerHooks} from "node:module";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

const temp=mkdtempSync(path.join(tmpdir(),"planner-task-list-routes-"));
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
const route=await import("../app/api/task-lists/route.ts");

function connect() {
  db.exec("DELETE FROM settings; DELETE FROM tasks; DELETE FROM remote_tasks; DELETE FROM remote_task_lists; DELETE FROM task_plans;");
  for(const source of ["google","microsoft"]){
    saveSetting(`${source}_refresh_token`,encrypt(`${source}-refresh`));
    saveSetting(`${source}_account_id`,`${source}-account`);
    saveSetting(`${source}_connection_generation`,`${source}-generation`);
  }
  saveSetting("google_granted_scopes","https://www.googleapis.com/auth/tasks");
}
beforeEach(()=>{upstream.reset();connect();});
after(()=>{globalThis.fetch=originalFetch;db.close();hooks.deregister();rmSync(temp,{recursive:true,force:true});});

const api="http://localhost:3000/api/task-lists";
const request=(method,body,origin="http://localhost:3000")=>new Request(api,{method,headers:{Origin:origin,"Content-Type":"application/json"},body:body === undefined ? undefined : JSON.stringify(body)});
const catalog=async()=>route.GET(new Request(api));
const preview=async list=>route.GET(new Request(`${api}?${new URLSearchParams({source:list.source,account_id:list.account_id,list_id:list.list_id})}`));

test("actual task-list route catalogs management metadata and protects mutations by origin",async()=>{
  const response=await catalog();assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
  const result=await response.json();assert.deepEqual(result.accounts.map(account=>account.source).sort(),["google","microsoft"]);assert.deepEqual(result.warnings,[]);
  const microsoft=result.lists.find(list=>list.source==="microsoft"),google=result.lists.find(list=>list.source==="google");
  assert.equal(microsoft.can_rename,false);assert.equal(microsoft.can_delete,false);assert.ok(microsoft.management_reason);assert.ok(microsoft.version);
  assert.equal(google.can_rename,true);assert.equal(google.can_delete,true);assert.ok(google.version);
  assert.equal((await route.POST(request("POST",{source:"google",account_id:"google-account",name:"Blokuota"},"https://attacker.example"))).status,403);
});

test("actual task-list route creates, renames, rejects stale versions, previews and deletes provider lists",async()=>{
  for(const source of ["microsoft","google"]){
    const account_id=`${source}-account`;
    const createdResponse=await route.POST(request("POST",{source,account_id,name:`${source} naujas`}));assert.equal(createdResponse.status,201);
    const created=await createdResponse.json();assert.equal(created.can_rename,true);assert.equal(created.can_delete,true);
    const renamedResponse=await route.PATCH(request("PATCH",{source,account_id,list_id:created.list_id,version:created.version,name:`${source} pervadintas`}));assert.equal(renamedResponse.status,200);
    const renamed=await renamedResponse.json();assert.equal(renamed.name,`${source} pervadintas`);assert.notEqual(renamed.version,created.version);
    assert.equal((await route.PATCH(request("PATCH",{source,account_id,list_id:created.list_id,version:created.version,name:"Pasenęs"}))).status,409);
    const previewResponse=await preview(renamed);assert.equal(previewResponse.status,200);const deletion=await previewResponse.json();
    assert.equal(deletion.task_count,0);assert.equal(deletion.list.name,renamed.name);assert.equal(typeof deletion.confirmation,"string");
    const removed=await route.DELETE(request("DELETE",{source,account_id,list_id:renamed.list_id,version:renamed.version,confirmation:deletion.confirmation,confirm_name:renamed.name}));assert.equal(removed.status,200);assert.deepEqual(await removed.json(),{ok:true});
    const lists=(await (await catalog()).json()).lists;assert.ok(lists.some(list=>list.source===source && list.list_id===`${source}-list`));assert.ok(!lists.some(list=>list.key===renamed.key));
    const writes=upstream.writes(source).map(write=>write.method);assert.ok(writes.includes("POST"));assert.ok(writes.includes("PATCH"));assert.ok(writes.includes("DELETE"));
  }
});
