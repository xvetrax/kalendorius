import assert from "node:assert/strict";
import {test,after,beforeEach} from "node:test";
import {registerHooks} from "node:module";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

// The real provider module, real encryption and real SQLite run against only
// synthetic tokens and a unique test database. No network calls are permitted.
const temp=mkdtempSync(path.join(tmpdir(),"planner-auth-"));
process.env.DATABASE_PATH=path.join(temp,"test.db");
process.env.TOKEN_ENCRYPTION_KEY="ab".repeat(32);
process.env.APP_ORIGIN="http://localhost:3000";
process.env.GOOGLE_REDIRECT_URI="http://localhost:3000/api/google/callback";
process.env.GOOGLE_CLIENT_ID="test-client";
process.env.GOOGLE_CLIENT_SECRET="test-secret";
const hooks=registerHooks({resolve(specifier,context,next) {
  return next(specifier.startsWith("@/") ? pathToFileURL(path.resolve(import.meta.dirname,"..",specifier.slice(2)+".ts")).href : specifier,context);
}});
const {db,setting,saveSetting}=await import("../lib/db.ts");
const {encrypt,decrypt}=await import("../lib/secrets.ts");
const google=await import("../lib/google.ts");
const originalFetch=globalThis.fetch;
after(() => {globalThis.fetch=originalFetch;db.close();hooks.deregister();rmSync(temp,{recursive:true,force:true});});
beforeEach(() => {
  db.exec("DELETE FROM settings");
  saveSetting("google_refresh_token",encrypt("old-refresh"));
  saveSetting("google_account_id","old-account");
  saveSetting("google_account","Old account");
  saveSetting("google_connection_generation","generation-a");
  globalThis.fetch=async () => {throw new Error("Unexpected network request in test");};
});
const json=(data,status=200) => Response.json(data,{status});
function deferred() {let resolve;const promise=new Promise(r => {resolve=r;});return {promise,resolve};}

test("parallel Graph calls share one refresh and safely retain the rotated encrypted token",async () => {
  let refreshes=0;let graphCalls=0;
  globalThis.fetch=async (url,init) => {
    if (url.includes("/token")) {refreshes++;assert.equal(init.body.get("refresh_token"),"old-refresh");return json({access_token:"access-a",refresh_token:"rotated-refresh"});}
    graphCalls++;assert.equal(init.headers.authorization,"Bearer access-a");return json({value:[]});
  };
  await Promise.all([google.googleFetch("/calendars/primary/events"),google.googleFetch("/calendars/primary")]);
  assert.equal(refreshes,1);assert.equal(graphCalls,2);
  assert.equal(decrypt(setting("google_refresh_token")),"rotated-refresh");
  assert.notEqual(setting("google_refresh_token"),"rotated-refresh");
});

test("late refresh cannot reconnect a disconnected account or send its Graph request",async () => {
  const waiting=deferred();let calls=0;
  globalThis.fetch=async () => {calls++;return waiting.promise;};
  const request=google.googleFetch("/calendars/primary/events");
  google.disconnectGoogle();
  waiting.resolve(json({access_token:"old-access",refresh_token:"late-refresh"}));
  await assert.rejects(request,/pasikeitė/);
  assert.equal(calls,1);assert.equal(google.isGoogleConnected(),false);assert.equal(setting("google_account_id"),undefined);
});

test("failed new profile lookup leaves the previous token and account paired",async () => {
  globalThis.fetch=async (url) => url.includes("/token") ? json({access_token:"new-access",refresh_token:"new-refresh"}) : json({error:"unavailable"},503);
  await assert.rejects(google.exchangeCode("test-code"));
  assert.equal(setting("google_account_id"),"old-account");assert.equal(decrypt(setting("google_refresh_token")),"old-refresh");
});

test("successful account switch atomically replaces identity and clears the old task list",async () => {
  
  globalThis.fetch=async (url) => url.includes("/token") ? json({access_token:"new-access",refresh_token:"new-refresh"}) : json({sub:"new-account",name:"Test account"});
  await google.exchangeCode("test-code");
  assert.equal(setting("google_account_id"),"new-account");assert.equal(decrypt(setting("google_refresh_token")),"new-refresh");
  assert.notEqual(setting("google_connection_generation"),"generation-a");
});

test("in-flight sign-in cannot undo a newer disconnect",async () => {
  const waiting=deferred();
  globalThis.fetch=async (url) => url.includes("/token") ? waiting.promise : json({sub:"new-account"});
  const signingIn=google.exchangeCode("test-code");google.disconnectGoogle();
  waiting.resolve(json({access_token:"new-access",refresh_token:"new-refresh"}));
  await assert.rejects(signingIn,/pasikeitė/);assert.equal(google.isGoogleConnected(),false);
});

const tasksScope="https://www.googleapis.com/auth/tasks",calendarScope="https://www.googleapis.com/auth/calendar";
function allowTasks(){saveSetting("google_granted_scopes",`${calendarScope} ${tasksScope}`);}

test("legacy Calendar connection requires explicit Tasks consent and never attempts Tasks requests",async()=>{
  assert.equal(google.isGoogleConnected(),true);assert.equal(google.isGoogleTasksConnected(),false);assert.equal(google.googleTasksStatus(),"permission_required");
  const url=new URL(google.googleAuthUrl("test-state"));
  for(const [key,value] of Object.entries({include_granted_scopes:"true",prompt:"consent",access_type:"offline",state:"test-state",login_hint:"old-account"}))assert.equal(url.searchParams.get(key),value);
  assert.ok(url.searchParams.get("scope").split(" ").includes(tasksScope));
  await assert.rejects(google.googleTasksFetch("/users/@me/lists"),/Tasks leidimą/);
});

test("incremental grant without a refresh token reuses only the verified same account token",async()=>{
  globalThis.fetch=async url=>url.includes("/token")?json({access_token:"new-access",scope:`${calendarScope} ${tasksScope}`}):json({sub:"old-account"});
  assert.equal((await google.exchangeCode("consent")).tasksConnected,true);assert.equal(google.isGoogleTasksConnected(),true);
  assert.equal(decrypt(setting("google_refresh_token")),"old-refresh");
  const generation=setting("google_connection_generation");
  globalThis.fetch=async url=>url.includes("/token")?json({access_token:"other-access",scope:tasksScope}):json({sub:"other-account"});
  await assert.rejects(google.exchangeCode("other-account"),/refresh token/);
  assert.equal(setting("google_connection_generation"),generation);assert.equal(setting("google_account_id"),"old-account");
});

test("partial Tasks consent preserves Calendar and missing scopes never invent a new grant",async()=>{
  allowTasks();
  globalThis.fetch=async url=>url.includes("/token")?json({access_token:"access",refresh_token:"replacement",scope:calendarScope}):json({sub:"old-account"});
  assert.equal((await google.exchangeCode("partial")).tasksConnected,false);assert.equal(google.isGoogleConnected(),true);
  globalThis.fetch=async url=>url.includes("/token")?json({access_token:"access"}):json({items:[]});
  assert.deepEqual(await google.googleFetch("/calendars/primary/events"),{items:[]});
  globalThis.fetch=async url=>url.includes("/token")?json({access_token:"access",refresh_token:"new-refresh"}):json({sub:"new-account"});
  assert.equal((await google.exchangeCode("no-scopes")).tasksConnected,false);assert.equal(setting("google_granted_scopes"),"");
});

test("refresh scope removal blocks Tasks but leaves Calendar usable; missing refresh scope preserves known grants",async()=>{
  allowTasks();let apiCalls=0;
  globalThis.fetch=async url=>{if(url.includes("/token"))return json({access_token:"access",scope:calendarScope});apiCalls++;return json({items:[]});};
  await assert.rejects(google.googleTasksFetch("/users/@me/lists"),/Tasks leidimą/);assert.equal(apiCalls,0);
  await google.googleFetch("/calendars/primary/events");assert.equal(apiCalls,1);
  allowTasks();globalThis.fetch=async url=>url.includes("/token")?json({access_token:"access"}):json({items:[]});
  await google.googleTasksFetch("/users/@me/lists");assert.equal(google.googleTasksStatus(),"connected");
});

test("disabled Tasks API is distinct from denied scope and can recover without another consent",async()=>{
  allowTasks();let failing=true;
  globalThis.fetch=async url=>url.includes("/token")?json({access_token:"access"}):failing?json({error:{details:[{reason:"SERVICE_DISABLED"}]}},403):json({items:[]});
  await assert.rejects(google.googleTasksFetch("/users/@me/lists"),e=>e.status===403);
  assert.equal(google.googleTasksStatus(),"api_unavailable");assert.equal(google.isGoogleTasksConnected(),true);
  failing=false;await google.googleTasksFetch("/users/@me/lists");assert.equal(google.googleTasksStatus(),"connected");
  globalThis.fetch=async url=>url.includes("/token")?json({access_token:"access"}):json({error:{errors:[{reason:"insufficientPermissions"}]}},403);
  await assert.rejects(google.googleTasksFetch("/users/@me/lists"));assert.equal(google.googleTasksStatus(),"permission_required");
  google.disconnectGoogle();assert.equal(google.googleTasksStatus(),"disconnected");assert.equal(setting("google_tasks_status"),undefined);
});

test("quota errors never masquerade as missing consent and successful empty deletes are supported",async()=>{
  allowTasks();globalThis.fetch=async url=>url.includes("/token")?json({access_token:"access"}):json({error:{errors:[{reason:"rateLimitExceeded"}]}},403);
  await assert.rejects(google.googleTasksFetch("/users/@me/lists"));assert.equal(google.googleTasksStatus(),"connected");
  globalThis.fetch=async url=>url.includes("/token")?json({access_token:"access"}):new Response(null,{status:200});
  assert.equal(await google.googleTasksFetch("/lists/a/tasks/1",{method:"DELETE"}),null);
});

test("late Tasks failures cannot attach permission errors to a newly connected account",async()=>{
  allowTasks();const waiting=deferred(),started=deferred();
  globalThis.fetch=async url=>{if(url.includes("/token"))return json({access_token:"access"});started.resolve();return waiting.promise;};
  const request=google.googleTasksFetch("/users/@me/lists");await started.promise;
  saveSetting("google_connection_generation","new-generation");saveSetting("google_account_id","new-account");
  waiting.resolve(json({error:{details:[{reason:"SERVICE_DISABLED"}]}},403));await assert.rejects(request);
  assert.equal(google.googleTasksStatus(),"connected");assert.equal(setting("google_tasks_status"),undefined);
});

test("revoked refresh tokens require reconnection without exposing provider error details",async()=>{
  allowTasks();globalThis.fetch=async()=>json({error:"invalid_grant",error_description:"DO_NOT_EXPOSE"},400);
  await assert.rejects(google.googleTasksFetch("/users/@me/lists"),e=>e.status===401&&!e.message.includes("DO_NOT_EXPOSE"));
  assert.equal(google.googleTasksStatus(),"permission_required");
});

test("incremental consent keeps a token rotated during the account lookup",async()=>{
  const waiting=deferred(),started=deferred();
  globalThis.fetch=async url=>{if(url.includes("/token"))return json({access_token:"access",scope:tasksScope});started.resolve();return waiting.promise;};
  const exchange=google.exchangeCode("incremental");await started.promise;saveSetting("google_refresh_token",encrypt("rotated-during-consent"));
  waiting.resolve(json({sub:"old-account"}));await exchange;
  assert.equal(decrypt(setting("google_refresh_token")),"rotated-during-consent");
});
