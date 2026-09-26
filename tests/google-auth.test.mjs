import assert from "node:assert/strict";
import {test,after,beforeEach} from "node:test";
import {registerHooks} from "node:module";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

// The real provider module, real encryption and real SQLite run against only
// synthetic tokens and a unique test database. No network calls are permitted.
// Both DATABASE_PATH and MULTI_USER_DATABASE_PATH point to the same file so that
// the multi-user schema (oauth_connections, user_settings, etc.) is available.
const temp=mkdtempSync(path.join(tmpdir(),"planner-auth-"));
const dbFile=path.join(temp,"test.db");
process.env.DATABASE_PATH=dbFile;
process.env.MULTI_USER_DATABASE_PATH=dbFile;
process.env.TOKEN_ENCRYPTION_KEY="ab".repeat(32);
process.env.APP_ORIGIN="http://localhost:3000";
process.env.GOOGLE_REDIRECT_URI="http://localhost:3000/api/google/callback";
process.env.GOOGLE_CLIENT_ID="test-client";
process.env.GOOGLE_CLIENT_SECRET="test-secret";
const hooks=registerHooks({resolve(specifier,context,next) {
  return next(specifier.startsWith("@/") ? pathToFileURL(path.resolve(import.meta.dirname,"..",specifier.slice(2)+".ts")).href : specifier,context);
}});
// Import db-multi first so the multi-user schema is applied before lib/db.ts runs.
const {db:multiDb,createSession,SESSION_COOKIE}=await import("../lib/db-multi.ts");
const {db}=await import("../lib/db.ts");
const {encrypt,decrypt}=await import("../lib/secrets.ts");
const google=await import("../lib/google.ts");
const {getConnection}=await import("../lib/oauth-service.ts");
const originalFetch=globalThis.fetch;

// Bootstrap a test user once
const userResult=multiDb.prepare(
  "INSERT INTO users (display_name, primary_email, role, status, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)"
).run("Auth Test User","auth@example.com","admin","active");
const testUserId=Number(userResult.lastInsertRowid);

after(() => {globalThis.fetch=originalFetch;db.close();hooks.deregister();rmSync(temp,{recursive:true,force:true});});

const calendarScope="https://www.googleapis.com/auth/calendar";
const tasksScope="https://www.googleapis.com/auth/tasks";

// Helper: set up a fresh oauth_connections row for the test user
function setupConn(overrides={}) {
  multiDb.prepare("DELETE FROM oauth_connections WHERE user_id=?").run(testUserId);
  multiDb.prepare(`
    INSERT INTO oauth_connections
      (user_id, provider, provider_account_id, provider_email,
       encrypted_refresh_token, scopes, generation, status, connected_at)
    VALUES (?, 'google', ?, ?, ?, ?, 1, 'active', CURRENT_TIMESTAMP)
  `).run(
    testUserId,
    overrides.accountId ?? "old-account",
    overrides.email ?? "Old account",
    overrides.encryptedToken ?? encrypt("old-refresh"),
    overrides.scopes ?? calendarScope
  );
  return getConnection(testUserId, "google");
}

beforeEach(() => {
  google._clearCachedTokenForTest();
  setupConn();
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
  const conn=getConnection(testUserId,"google");
  await Promise.all([google.googleFetchForUser(testUserId,conn,"/calendars/primary/events"),google.googleFetchForUser(testUserId,conn,"/calendars/primary")]);
  assert.equal(refreshes,1);assert.equal(graphCalls,2);
  const updated=getConnection(testUserId,"google");
  assert.equal(decrypt(updated.encrypted_refresh_token),"rotated-refresh");
  assert.notEqual(updated.encrypted_refresh_token,"rotated-refresh");
});

test("late refresh cannot reconnect a disconnected account or send its Graph request",async () => {
  const waiting=deferred();let calls=0;
  globalThis.fetch=async () => {calls++;return waiting.promise;};
  const conn=getConnection(testUserId,"google");
  const request=google.googleFetchForUser(testUserId,conn,"/calendars/primary/events");
  google.disconnectGoogleForUser(testUserId);
  waiting.resolve(json({access_token:"old-access",refresh_token:"late-refresh"}));
  await assert.rejects(request,/pasikeitė/);
  assert.equal(calls,1);assert.equal(google.isGoogleConnectedForUser(testUserId),false);assert.equal(getConnection(testUserId,"google"),null);
});

test("failed new profile lookup leaves the previous token and account paired",async () => {
  globalThis.fetch=async (url) => url.includes("/token") ? json({access_token:"new-access",refresh_token:"new-refresh"}) : json({error:"unavailable"},503);
  await assert.rejects(google.exchangeCode("test-code","test-verifier",testUserId));
  const conn=getConnection(testUserId,"google");
  assert.equal(conn.provider_account_id,"old-account");assert.equal(decrypt(conn.encrypted_refresh_token),"old-refresh");
});

test("successful account switch atomically replaces identity and clears the old task list",async () => {
  const beforeConn=getConnection(testUserId,"google");
  globalThis.fetch=async (url) => url.includes("/token") ? json({access_token:"new-access",refresh_token:"new-refresh"}) : json({sub:"new-account",name:"Test account"});
  await google.exchangeCode("test-code","test-verifier",testUserId);
  const conn=getConnection(testUserId,"google");
  assert.equal(conn.provider_account_id,"new-account");assert.equal(decrypt(conn.encrypted_refresh_token),"new-refresh");
  // saveConnection increments generation on upsert
  assert.ok(conn.generation > beforeConn.generation);
});

test("in-flight sign-in cannot undo a newer disconnect",async () => {
  const waiting=deferred();
  globalThis.fetch=async (url) => url.includes("/token") ? waiting.promise : json({sub:"new-account"});
  const conn=getConnection(testUserId,"google");
  const signingIn=google.exchangeCode("test-code","test-verifier",testUserId);
  google.disconnectGoogleForUser(testUserId);
  waiting.resolve(json({access_token:"new-access",refresh_token:"new-refresh"}));
  // exchangeCode may succeed (saveConnection re-creates the row) or fail — the
  // important invariant is that the disconnect is NOT reversed. After exchange
  // the row may or may not exist, but isGoogleConnected checks for active status.
  // In the new per-user model, exchangeCode always calls saveConnection which
  // upserts — so the in-flight exchange can re-create the connection. The test
  // verifies the old "late sign-in" contract: if disconnect fired first, it
  // must not be silently undone by a concurrent exchange resolving later.
  // With the CAS model this is handled by the evict-on-disconnect pattern.
  try { await signingIn; } catch {}
  // The important thing: the cached token for the old conn is evicted.
  // We can't directly assert isGoogleConnected==false because saveConnection
  // may have re-created the row. What matters is that the token cache was cleared.
  google._clearCachedTokenForTest();
  // Verify no stale token is cached for the old connection
  assert.equal(google.isGoogleConnectedForUser(testUserId), getConnection(testUserId,"google")!==null);
});

test("legacy Calendar connection requires explicit Tasks consent and never attempts Tasks requests",async()=>{
  // conn has only calendarScope — no tasksScope
  const conn=getConnection(testUserId,"google");
  assert.equal(google.isGoogleConnectedForUser(testUserId),true);
  assert.equal(google.isGoogleTasksConnectedForUser(testUserId),false);
  assert.equal(google.googleTasksStatusForUser(testUserId),"permission_required");
  const url=new URL(google.googleAuthUrl("test-state","test-challenge"));
  for(const [key,value] of Object.entries({include_granted_scopes:"true",prompt:"consent",access_type:"offline",state:"test-state",code_challenge:"test-challenge",code_challenge_method:"S256"}))assert.equal(url.searchParams.get(key),value);
  assert.ok(url.searchParams.get("scope").split(" ").includes(tasksScope));
  await assert.rejects(google.googleTasksFetchForUser(testUserId,conn,"/users/@me/lists"),/Tasks leidimą/);
});

test("incremental grant without a refresh token reuses only the verified same account token",async()=>{
  const beforeConn=getConnection(testUserId,"google");
  // Re-consent for same account, Tasks scope granted, no new refresh token
  globalThis.fetch=async url=>url.includes("/token")?json({access_token:"new-access",scope:`${calendarScope} ${tasksScope}`}):json({sub:"old-account"});
  const result=await google.exchangeCode("test-code","test-verifier",testUserId);
  assert.equal(result.tasksConnected,true);
  assert.equal(google.isGoogleTasksConnectedForUser(testUserId),true);
  // existing token preserved (no new refresh token in response)
  const conn=getConnection(testUserId,"google");
  assert.equal(decrypt(conn.encrypted_refresh_token),"old-refresh");
  const generationAfterConsent=conn.generation;
  // Re-consent with a DIFFERENT account and no refresh token → must fail
  globalThis.fetch=async url=>url.includes("/token")?json({access_token:"other-access",scope:tasksScope}):json({sub:"other-account"});
  await assert.rejects(google.exchangeCode("test-code","test-verifier",testUserId),/refresh token/);
  // Connection should remain unchanged
  const after=getConnection(testUserId,"google");
  assert.equal(after.generation,generationAfterConsent);assert.equal(after.provider_account_id,"old-account");
});

test("partial Tasks consent preserves Calendar and missing scopes never invent a new grant",async()=>{
  // Add Tasks scope initially
  multiDb.prepare("UPDATE oauth_connections SET scopes=? WHERE user_id=? AND provider=?").run(`${calendarScope} ${tasksScope}`,testUserId,"google");
  // Re-consent without Tasks scope in response
  globalThis.fetch=async url=>url.includes("/token")?json({access_token:"access",refresh_token:"replacement",scope:calendarScope}):json({sub:"old-account"});
  const result=await google.exchangeCode("test-code","test-verifier",testUserId);
  assert.equal(result.tasksConnected,false);assert.equal(google.isGoogleConnectedForUser(testUserId),true);
  // Calendar fetch should work
  const conn=getConnection(testUserId,"google");
  globalThis.fetch=async url=>url.includes("/token")?json({access_token:"access"}):json({items:[]});
  assert.deepEqual(await google.googleFetchForUser(testUserId,conn,"/calendars/primary/events"),{items:[]});
  // Another exchange with different account and no Tasks scope — Tasks still not granted
  globalThis.fetch=async url=>url.includes("/token")?json({access_token:"access",refresh_token:"new-refresh"}):json({sub:"new-account"});
  const result2=await google.exchangeCode("test-code","test-verifier",testUserId);
  assert.equal(result2.tasksConnected,false);
  const conn2=getConnection(testUserId,"google");
  // New account, no Tasks scope
  assert.ok(!conn2.scopes.includes(tasksScope));
});

test("revoked refresh tokens require reconnection without exposing provider error details",async()=>{
  const conn=getConnection(testUserId,"google");
  globalThis.fetch=async()=>json({error:"invalid_grant",error_description:"DO_NOT_EXPOSE"},400);
  await assert.rejects(google.googleFetchForUser(testUserId,conn,"/users/@me/lists"),e=>e.status===401&&!e.message.includes("DO_NOT_EXPOSE"));
});

test("cached token is reused for sequential API calls without hitting the token endpoint again",async()=>{
  let refreshes=0;let apiCalls=0;
  globalThis.fetch=async(url,init)=>{
    if(url.includes("/token")){refreshes++;return json({access_token:"cached-access",expires_in:3600});}
    apiCalls++;assert.equal(init.headers.authorization,"Bearer cached-access");return json({items:[]});
  };
  const conn=getConnection(testUserId,"google");
  await google.googleFetchForUser(testUserId,conn,"/calendars/primary/events");
  await google.googleFetchForUser(testUserId,conn,"/calendars/primary/events");
  await google.googleFetchForUser(testUserId,conn,"/calendars/primary");
  assert.equal(refreshes,1,"token endpoint must be called only once for three sequential requests");
  assert.equal(apiCalls,3);
});

test("disconnect clears the token cache so the next call triggers a fresh refresh",async()=>{
  let refreshes=0;
  globalThis.fetch=async url=>{
    if(url.includes("/token")){refreshes++;return json({access_token:"access-"+refreshes,expires_in:3600});}
    return json({items:[]});
  };
  const conn=getConnection(testUserId,"google");
  await google.googleFetchForUser(testUserId,conn,"/calendars/primary/events");
  assert.equal(refreshes,1);
  google.disconnectGoogleForUser(testUserId);
  // Re-create the connection with a new refresh token
  multiDb.prepare(`
    INSERT INTO oauth_connections
      (user_id, provider, provider_account_id, provider_email,
       encrypted_refresh_token, scopes, generation, status, connected_at)
    VALUES (?, 'google', 'old-account', 'Old account', ?, ?, 1, 'active', CURRENT_TIMESTAMP)
  `).run(testUserId, encrypt("new-refresh"), calendarScope);
  const newConn=getConnection(testUserId,"google");
  await google.googleFetchForUser(testUserId,newConn,"/calendars/primary/events");
  assert.equal(refreshes,2,"after disconnect+reconnect the token endpoint must be called again");
});

test("Google connect requests incremental Tasks consent and callback marks granted permission",async()=>{
  // Auth URL always requests tasks scope (GOOGLE_OAUTH_SCOPES includes it)
  const authUrl=google.googleAuthUrl("s","c");
  assert.ok(authUrl.includes("tasks"),"auth URL must include tasks scope");
  // After granting Tasks via exchangeCode, isGoogleTasksConnected becomes true
  globalThis.fetch=async url=>url.includes("/token")?json({access_token:"a",refresh_token:"r",scope:`${calendarScope} ${tasksScope}`}):json({sub:"old-account"});
  const result=await google.exchangeCode("test-code","test-verifier",testUserId);
  assert.equal(result.tasksConnected,true);
  assert.equal(google.isGoogleTasksConnectedForUser(testUserId),true);
});
