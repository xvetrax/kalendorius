import assert from "node:assert/strict";
import {test,after,beforeEach} from "node:test";
import {registerHooks} from "node:module";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

const temp=mkdtempSync(path.join(tmpdir(),"planner-task-list-routes-"));
process.env.MULTI_USER_DATABASE_PATH=path.join(temp,"multi.db");
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
const {encrypt}=await import("../lib/secrets.ts");
// Multi-user db: routes use this for tasks/plans/oauth; we bootstrap a test session here
const {db:multiDb,createSession,SESSION_COOKIE}=await import("../lib/db-multi.ts");
const route=await import("../app/api/task-lists/route.ts");

// Bootstrap a test user and session
let testUserId, sessionCookie;
function bootstrapTestUser() {
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

function connect() {
  // Clear multi-user tables for this user
  multiDb.exec(`DELETE FROM tasks WHERE user_id=${testUserId};DELETE FROM remote_tasks WHERE user_id=${testUserId};DELETE FROM remote_task_lists WHERE user_id=${testUserId};DELETE FROM task_plans WHERE user_id=${testUserId};DELETE FROM oauth_connections WHERE user_id=${testUserId};`);
  // Insert oauth_connections for both providers in the multi-user db
  for(const source of ["google","microsoft"]){
    const scopes=source==="google"
      ? "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks offline_access"
      : "offline_access User.Read Calendars.ReadWrite Tasks.ReadWrite";
    multiDb.prepare(`INSERT INTO oauth_connections (user_id,provider,provider_account_id,provider_email,encrypted_refresh_token,scopes,generation,status,connected_at) VALUES (?,?,?,?,?,?,1,'active',CURRENT_TIMESTAMP)`)
      .run(testUserId,source,`${source}-account`,`${source}@example.com`,encrypt(`${source}-refresh`),scopes);
  }
}
beforeEach(()=>{upstream.reset();connect();});
after(()=>{globalThis.fetch=originalFetch;multiDb.close();hooks.deregister();rmSync(temp,{recursive:true,force:true});});

const api="http://localhost:3000/api/task-lists";
const request=(method,body,origin="http://localhost:3000")=>new Request(api,{method,headers:{Origin:origin,"Content-Type":"application/json",Cookie:sessionCookie},body:body === undefined ? undefined : JSON.stringify(body)});
const catalog=async()=>route.GET(new Request(api,{headers:{Cookie:sessionCookie}}));
const preview=async list=>route.GET(new Request(`${api}?${new URLSearchParams({source:list.source,account_id:list.account_id,list_id:list.list_id})}`,{headers:{Cookie:sessionCookie}}));

test("actual task-list route catalogs management metadata and protects mutations by origin",async()=>{
  const response=await catalog();assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
  const result=await response.json();assert.deepEqual(result.accounts.map(account=>account.source).sort(),["google","microsoft"]);assert.deepEqual(result.warnings,[]);
  const microsoft=result.lists.find(list=>list.source==="microsoft"),google=result.lists.find(list=>list.source==="google");
  assert.equal(microsoft.can_rename,false);assert.equal(microsoft.can_delete,false);assert.ok(microsoft.management_reason);assert.ok(microsoft.version);
  assert.equal(google.can_rename,true);assert.equal(google.can_delete,true);assert.ok(google.version);
  // CSRF check fires before session check; include cookie anyway to be realistic
  assert.equal((await route.POST(new Request(api,{method:"POST",headers:{Origin:"https://attacker.example","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify({source:"google",account_id:"google-account",name:"Blokuota"})}))).status,403);
});

test("actual task-list route keeps two accounts routable and labels identical lists",async()=>{
  for(const source of ["google","microsoft"]){
    const scopes=source==="google"?"https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks offline_access":"offline_access User.Read Calendars.ReadWrite Tasks.ReadWrite";
    multiDb.prepare(`INSERT INTO oauth_connections (user_id,provider,provider_account_id,provider_email,encrypted_refresh_token,scopes,generation,status,connected_at) VALUES (?,?,?,?,?,?,1,'active',CURRENT_TIMESTAMP)`)
      .run(testUserId,source,`${source}-second`,`second@${source}.example`,encrypt(`${source}-second-refresh`),scopes);
  }
  const response=await catalog();assert.equal(response.status,200);const result=await response.json();
  assert.equal(result.accounts.length,4);assert.equal(result.lists.length,4);
  assert.deepEqual(new Set(result.accounts.map(account=>account.label)),new Set(["google@example.com","microsoft@example.com","second@google.example","second@microsoft.example"]));
  assert.ok(result.lists.every(list=>typeof list.account_label==="string"&&list.account_label.length>0&&Number.isSafeInteger(list.connection_id)));
  const created=await route.POST(request("POST",{source:"google",account_id:"google-second",name:"Antros paskyros sąrašas"}));
  assert.equal(created.status,201);assert.equal((await created.json()).account_id,"google-second");
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
