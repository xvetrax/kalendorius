import assert from "node:assert/strict";
import {test,after,beforeEach} from "node:test";
import {registerHooks} from "node:module";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
const temp=mkdtempSync(path.join(tmpdir(),"planner-google-consent-"));
const dbFile=path.join(temp,"test.db");
Object.assign(process.env,{DATABASE_PATH:dbFile,MULTI_USER_DATABASE_PATH:dbFile,TOKEN_ENCRYPTION_KEY:"ba".repeat(32),APP_ORIGIN:"http://localhost:3000",GOOGLE_CLIENT_ID:"fixture",GOOGLE_CLIENT_SECRET:"fixture",GOOGLE_REDIRECT_URI:"http://localhost:3000/api/google/callback"});
const hooks=registerHooks({resolve(specifier,context,next){
  return next(specifier.startsWith("@/")?pathToFileURL(path.resolve(import.meta.dirname,"..",specifier.slice(2)+".ts")).href:specifier,context);
}});
// Import db-multi first so multi-user schema is applied before lib/db.ts
const {db:multiDb,createSession,SESSION_COOKIE}=await import("../lib/db-multi.ts");
const {db}=await import("../lib/db.ts");
const {encrypt}=await import("../lib/secrets.ts");
const {getConnection,getConnectionByAccount,listConnections}=await import("../lib/oauth-service.ts");
const connect=await import("../app/api/google/connect/route.ts");
const callback=await import("../app/api/google/callback/route.ts");
const status=await import("../app/api/google/status/route.ts");
const originalFetch=globalThis.fetch;
const calendar="https://www.googleapis.com/auth/calendar";
const tasks="https://www.googleapis.com/auth/tasks";

// Bootstrap a test user once
const userResult=multiDb.prepare(
  "INSERT INTO users (display_name, primary_email, role, status, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)"
).run("Google OAuth Test User","googleoauth@example.com","admin","active");
const testUserId=Number(userResult.lastInsertRowid);

let sessionCookie;
function refreshSession(){
  const {rawToken}=createSession(testUserId);
  sessionCookie=`${SESSION_COOKIE}=${rawToken}`;
}
refreshSession();

// Helper: build a connect request with session cookie
function connectReq(query=""){return new Request("http://localhost:3000/api/google/connect"+query,{headers:{Cookie:sessionCookie}});}
// Helper: build a callback request, forwarding google_connect_state cookie from connect response
function callbackReq(connectResp,query){
  const setCookie=connectResp.headers.get("set-cookie")||"";
  const stateVal=setCookie.match(/google_connect_state=([^;]+)/)?.[1]||"";
  const cookies=`${sessionCookie}; google_connect_state=${stateVal}`;
  return new Request("http://localhost:3000/api/google/callback?"+new URLSearchParams(query),{headers:{Cookie:cookies}});
}
function oauthResult(r){return new URL(r.headers.get("location")).searchParams.get("oauth");}
function consent(scope,accountId="fixture-account"){
  globalThis.fetch=async raw=>{
    const url=new URL(raw);
    if(url.origin==="https://oauth2.googleapis.com")return Response.json({access_token:"synthetic-access",refresh_token:"synthetic-refresh",scope});
    if(url.origin==="https://openidconnect.googleapis.com")return Response.json({sub:accountId,email:`${accountId}@example.test`});
    throw Error("No external network allowed");
  };
}

beforeEach(()=>{
  multiDb.exec(`DELETE FROM oauth_connections WHERE user_id=${testUserId}; DELETE FROM auth_operations;`);
  globalThis.fetch=async()=>{throw Error("No external network allowed");};
});

test("overlapping default Google bootstrap flows cannot create different sibling accounts",async()=>{
  const first=await connect.GET(connectReq());
  const second=await connect.GET(connectReq());
  const firstState=new URL(first.headers.get("location")).searchParams.get("state");
  const secondState=new URL(second.headers.get("location")).searchParams.get("state");
  const modes=multiDb.prepare(
    "SELECT oauth_mode FROM auth_operations WHERE state_hash IN (?,?) ORDER BY id",
  ).all(
    (await import("node:crypto")).createHash("sha256").update(firstState).digest("hex"),
    (await import("node:crypto")).createHash("sha256").update(secondState).digest("hex"),
  );
  assert.deepEqual(modes.map(row=>row.oauth_mode),["legacy","legacy"]);

  consent(calendar,"first-account");
  assert.notEqual(oauthResult(await callback.GET(callbackReq(first,{state:firstState,code:"first"}))),"error");
  consent(calendar,"second-account");
  assert.equal(oauthResult(await callback.GET(callbackReq(second,{state:secondState,code:"second"}))),"error");
  assert.equal(listConnections(testUserId,"google").length,1);
  assert.ok(getConnectionByAccount(testUserId,"google","first-account"));
});

test("explicit add and account-bound re-consent persist intent and keep exact disconnect recoverable",async()=>{
  multiDb.prepare(`INSERT INTO oauth_connections
    (user_id,provider,provider_account_id,provider_email,encrypted_refresh_token,scopes,generation,status,connected_at)
    VALUES (?,?,?,?,?,?,1,'active',CURRENT_TIMESTAMP)`)
    .run(testUserId,"google","old-account","old@example.test",encrypt("old-refresh"),calendar);
  const old=getConnection(testUserId,"google");

  const reconsent=await connect.GET(connectReq(`?mode=reconsent&connectionId=${old.id}`));
  const reconsentAuth=new URL(reconsent.headers.get("location"));
  assert.equal(reconsentAuth.searchParams.get("login_hint"),"old@example.test");
  const reconsentState=reconsentAuth.searchParams.get("state");
  const reconsentOp=multiDb.prepare(
    "SELECT oauth_mode,expected_connection_id FROM auth_operations WHERE state_hash=?",
  ).get((await import("node:crypto")).createHash("sha256").update(reconsentState).digest("hex"));
  assert.deepEqual({...reconsentOp},{oauth_mode:"reconsent",expected_connection_id:old.id});

  consent(calendar,"different-account");
  const rejected=await callback.GET(callbackReq(reconsent,{state:reconsentState,code:"wrong-account"}));
  assert.equal(oauthResult(rejected),"error");
  assert.equal(listConnections(testUserId,"google").length,1);
  assert.equal(getConnection(testUserId,"google").provider_account_id,"old-account");

  const add=await connect.GET(connectReq("?mode=add"));
  const addAuth=new URL(add.headers.get("location"));
  assert.equal(addAuth.searchParams.get("login_hint"),null);
  assert.match(addAuth.searchParams.get("prompt"),/select_account/);
  const addState=addAuth.searchParams.get("state");
  const addOp=multiDb.prepare(
    "SELECT oauth_mode,expected_connection_id FROM auth_operations WHERE state_hash=?",
  ).get((await import("node:crypto")).createHash("sha256").update(addState).digest("hex"));
  assert.deepEqual({...addOp},{oauth_mode:"add",expected_connection_id:null});

  consent(`${calendar} ${tasks}`,"new-account");
  const added=await callback.GET(callbackReq(add,{state:addState,code:"new-account"}));
  assert.equal(oauthResult(added),"connected");
  const newConnection=getConnectionByAccount(testUserId,"google","new-account");
  assert.ok(newConnection);

  const state=await (await status.GET(new Request(
    "http://localhost:3000/api/google/status",
    {headers:{Cookie:sessionCookie}},
  ))).json();
  assert.equal(state.connections.length,2);
  assert.equal(state.account,null);

  const removed=await status.DELETE(new Request(
    `http://localhost:3000/api/google/status?connectionId=${newConnection.id}`,
    {method:"DELETE",headers:{Cookie:sessionCookie,Origin:"http://localhost:3000"}},
  ));
  assert.equal(removed.status,200);
  assert.equal(getConnectionByAccount(testUserId,"google","new-account"),null);
  assert.equal(getConnectionByAccount(testUserId,"google","old-account").id,old.id);
});
after(()=>{globalThis.fetch=originalFetch;db.close();hooks.deregister();rmSync(temp,{recursive:true,force:true});});

test("Google connect requests incremental Tasks consent and callback marks granted permission",async()=>{
  const resp=await connect.GET(connectReq());
  assert.equal(resp.status,302,"connect must redirect");
  const auth=new URL(resp.headers.get("location"));
  const state=auth.searchParams.get("state");
  assert.ok(state,"connect redirect must include state");
  // State cookie must be set on the response
  const setCookie=resp.headers.get("set-cookie")||"";
  assert.ok(setCookie.includes("google_connect_state="),"connect must set google_connect_state cookie");
  // Auth URL checks
  assert.match(auth.searchParams.get("prompt"),/consent/);
  assert.equal(auth.searchParams.get("include_granted_scopes"),"true");
  assert.ok(auth.searchParams.get("scope").includes("tasks"),"scope must include tasks");
  assert.equal(auth.searchParams.get("code_challenge_method"),"S256");
  assert.ok(auth.searchParams.get("code_challenge"),"code_challenge must be set");

  // Callback with Tasks scope granted
  consent(`${calendar} ${tasks}`);
  const cbResp=await callback.GET(callbackReq(resp,{state,code:"synthetic"}));
  assert.equal(oauthResult(cbResp),"connected");

  // Status reflects connected+tasks
  const s=await status.GET(new Request("http://localhost:3000/api/google/status",{headers:{Cookie:sessionCookie}}));
  assert.equal(s.headers.get("cache-control"),"no-store");
  const body=await s.json();
  assert.equal(body.tasksConnected,true);
  assert.equal(body.tasksStatus,"connected");

  // Replay callback must be rejected (operation already used)
  const replay=await callback.GET(callbackReq(resp,{state,code:"replay"}));
  assert.equal(oauthResult(replay),"error");
});

test("partial or denied Tasks consent reports an actionable result while preserving the old Calendar connection",async()=>{
  // Pre-populate a calendar-only connection
  multiDb.prepare(`INSERT INTO oauth_connections (user_id,provider,provider_account_id,provider_email,encrypted_refresh_token,scopes,generation,status,connected_at) VALUES (?,?,?,?,?,?,1,'active',CURRENT_TIMESTAMP)`)
    .run(testUserId,"google","fixture-account","fixture@example.com",encrypt("old-refresh"),calendar);

  // Connect → get state
  const resp=await connect.GET(connectReq());
  const auth=new URL(resp.headers.get("location"));
  const state=auth.searchParams.get("state");

  // Callback with calendar scope only (tasks not granted)
  consent(calendar);
  const cbResp=await callback.GET(callbackReq(resp,{state,code:"synthetic"}));
  assert.equal(oauthResult(cbResp),"tasks-permission-required");

  const s=await (await status.GET(new Request("http://localhost:3000/api/google/status",{headers:{Cookie:sessionCookie}}))).json();
  assert.equal(s.connected,true);
  assert.equal(s.tasksStatus,"permission_required");

  // Store token state before denied flow
  const connBefore=getConnection(testUserId,"google");

  // Connect again → denied access
  const resp2=await connect.GET(connectReq());
  const state2=new URL(resp2.headers.get("location")).searchParams.get("state");
  globalThis.fetch=async()=>{throw Error("Must not exchange denied consent");};
  const cbResp2=await callback.GET(callbackReq(resp2,{state:state2,error:"access_denied"}));
  assert.equal(oauthResult(cbResp2),"tasks-permission-required");

  // Token must be unchanged
  const connAfter=getConnection(testUserId,"google");
  assert.equal(connBefore.encrypted_refresh_token,connAfter.encrypted_refresh_token);
  assert.equal(connBefore.generation,connAfter.generation);
});

test("invalid OAuth state cannot change permission state or expose provider errors",async()=>{
  // Pre-populate connection with calendar scope
  multiDb.prepare(`INSERT INTO oauth_connections (user_id,provider,provider_account_id,provider_email,encrypted_refresh_token,scopes,generation,status,connected_at) VALUES (?,?,?,?,?,?,1,'active',CURRENT_TIMESTAMP)`)
    .run(testUserId,"google","fixture-account","fixture@example.com",encrypt("old-refresh"),calendar);

  // Start a real connect flow to get a valid state cookie, but send wrong state in query
  const resp=await connect.GET(connectReq());
  // Build callback with mismatched state (keep correct cookie from resp but wrong state param)
  const setCookie=resp.headers.get("set-cookie")||"";
  const stateVal=setCookie.match(/google_connect_state=([^;]+)/)?.[1]||"";
  const cookies=`${sessionCookie}; google_connect_state=${stateVal}`;
  const r=await callback.GET(new Request(
    "http://localhost:3000/api/google/callback?"+new URLSearchParams({state:"wrong",code:"secret",error_description:"DO_NOT_EXPOSE"}),
    {headers:{Cookie:cookies}}
  ));
  assert.equal(oauthResult(r),"error");
  assert.ok(!r.headers.get("location").includes("DO_NOT_EXPOSE"));

  // Connection must be unchanged
  const conn=getConnection(testUserId,"google");
  assert.equal(conn.scopes,calendar);
});

test("Calendar and Tasks callback requires the same active app session",async()=>{
  const resp=await connect.GET(connectReq());
  const auth=new URL(resp.headers.get("location"));
  const state=auth.searchParams.get("state");
  const stateCookie=(resp.headers.get("set-cookie")||"").match(/google_connect_state=([^;]+)/)?.[1]||"";
  let providerCalled=false;
  globalThis.fetch=async()=>{providerCalled=true;throw Error("Must not reach provider");};

  const result=await callback.GET(new Request(
    "http://localhost:3000/api/google/callback?"+new URLSearchParams({state,code:"synthetic"}),
    {headers:{Cookie:`google_connect_state=${stateCookie}`}},
  ));

  assert.equal(oauthResult(result),"error");
  assert.equal(providerCalled,false);
  const operation=multiDb.prepare("SELECT used FROM auth_operations WHERE state_hash = ?").get(
    (await import("node:crypto")).createHash("sha256").update(state).digest("hex"),
  );
  assert.equal(operation.used,0,"failed session binding must not consume the operation");
});
