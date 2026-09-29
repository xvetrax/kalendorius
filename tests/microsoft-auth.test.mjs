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
process.env.MICROSOFT_REDIRECT_URI="http://localhost:3000/api/microsoft/callback";
process.env.MICROSOFT_CLIENT_ID="test-client";
process.env.MICROSOFT_CLIENT_SECRET="test-secret";
const hooks=registerHooks({resolve(specifier,context,next) {
  return next(specifier.startsWith("@/") ? pathToFileURL(path.resolve(import.meta.dirname,"..",specifier.slice(2)+".ts")).href : specifier,context);
}});
// Import db-multi first so the multi-user schema is applied before lib/db.ts runs.
const {db:multiDb,createSession,SESSION_COOKIE}=await import("../lib/db-multi.ts");
const {db}=await import("../lib/db.ts");
const {encrypt,decrypt}=await import("../lib/secrets.ts");
const ms=await import("../lib/microsoft.ts");
const {getConnection,getConnectionByAccount,listConnections}=await import("../lib/oauth-service.ts");
const originalFetch=globalThis.fetch;

// Bootstrap a test user once
const userResult=multiDb.prepare(
  "INSERT INTO users (display_name, primary_email, role, status, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)"
).run("MS Auth Test User","msauth@example.com","admin","active");
const testUserId=Number(userResult.lastInsertRowid);

after(() => {globalThis.fetch=originalFetch;db.close();hooks.deregister();rmSync(temp,{recursive:true,force:true});});

// Helper: set up a fresh oauth_connections row for the test user
function setupConn(overrides={}) {
  multiDb.prepare("DELETE FROM oauth_connections WHERE user_id=?").run(testUserId);
  multiDb.prepare(`
    INSERT INTO oauth_connections
      (user_id, provider, provider_account_id, provider_email,
       encrypted_refresh_token, scopes, generation, status, connected_at)
    VALUES (?, 'microsoft', ?, ?, ?, ?, 1, 'active', CURRENT_TIMESTAMP)
  `).run(
    testUserId,
    overrides.accountId ?? "old-account",
    overrides.email ?? "Old account",
    overrides.encryptedToken ?? encrypt("old-refresh"),
    overrides.scopes ?? "offline_access User.Read Calendars.ReadWrite Tasks.ReadWrite"
  );
  return getConnection(testUserId, "microsoft");
}

beforeEach(() => {
  ms._clearCachedTokenForTest();
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
  const conn=getConnection(testUserId,"microsoft");
  await Promise.all([ms.graphFetchForUser(testUserId,conn,"/me/events"),ms.graphFetchForUser(testUserId,conn,"/me/todo/lists")]);
  assert.equal(refreshes,1);assert.equal(graphCalls,2);
  const updated=getConnection(testUserId,"microsoft");
  assert.equal(decrypt(updated.encrypted_refresh_token),"rotated-refresh");
  assert.notEqual(updated.encrypted_refresh_token,"rotated-refresh");
});

test("late refresh cannot reconnect a disconnected account or send its Graph request",async () => {
  const waiting=deferred();let calls=0;
  globalThis.fetch=async () => {calls++;return waiting.promise;};
  const conn=getConnection(testUserId,"microsoft");
  const request=ms.graphFetchForUser(testUserId,conn,"/me/events");
  ms.disconnectMicrosoftForUser(testUserId);
  waiting.resolve(json({access_token:"old-access",refresh_token:"late-refresh"}));
  await assert.rejects(request,/pasikeitė/);
  assert.equal(calls,1);assert.equal(ms.isMicrosoftConnectedForUser(testUserId),false);assert.equal(getConnection(testUserId,"microsoft"),null);
});

test("failed new profile lookup leaves the previous token and account paired",async () => {
  globalThis.fetch=async (url) => url.includes("/token") ? json({access_token:"new-access",refresh_token:"new-refresh"}) : json({error:"unavailable"},503);
  await assert.rejects(ms.exchangeMicrosoftCode("test-code","test-verifier",testUserId));
  const conn=getConnection(testUserId,"microsoft");
  assert.equal(conn.provider_account_id,"old-account");assert.equal(decrypt(conn.encrypted_refresh_token),"old-refresh");
});

test("legacy consent rejects a different account without creating an unusable sibling",async () => {
  const beforeConn=getConnection(testUserId,"microsoft");
  globalThis.fetch=async (url) => url.includes("/token") ? json({access_token:"new-access",refresh_token:"new-refresh"}) : json({id:"new-account",displayName:"Test account"});
  await assert.rejects(
    ms.exchangeMicrosoftCode("test-code","test-verifier",testUserId),
    /Pasirinkta kita Microsoft paskyra/,
  );
  const after=getConnection(testUserId,"microsoft");
  assert.equal(after.id,beforeConn.id);
  assert.equal(after.provider_account_id,"old-account");
  assert.equal(decrypt(after.encrypted_refresh_token),"old-refresh");
  assert.equal(listConnections(testUserId,"microsoft").length,1);
});

test("explicit add creates a sibling while re-consent is bound to one exact Microsoft account",async () => {
  const original=getConnection(testUserId,"microsoft");
  globalThis.fetch=async (url) => url.includes("/token")
    ? json({access_token:"new-access",refresh_token:"new-refresh",scope:"Calendars.ReadWrite"})
    : json({id:"new-account",mail:"new@example.test"});
  const added=await ms.exchangeMicrosoftCode(
    "test-code",
    "test-verifier",
    testUserId,
    {mode:"add"},
  );
  assert.equal(getConnectionByAccount(testUserId,"microsoft","new-account").id,added.connectionId);
  assert.equal(listConnections(testUserId,"microsoft").length,2);

  globalThis.fetch=async (url) => url.includes("/token")
    ? json({access_token:"wrong-access",refresh_token:"wrong-refresh",scope:"Calendars.ReadWrite"})
    : json({id:"new-account"});
  await assert.rejects(
    ms.exchangeMicrosoftCode(
      "test-code",
      "test-verifier",
      testUserId,
      {mode:"reconsent",expectedConnectionId:original.id},
    ),
    /ne ta Microsoft paskyra/,
  );
  assert.equal(decrypt(getConnectionByAccount(testUserId,"microsoft","old-account").encrypted_refresh_token),"old-refresh");
});

test("in-flight Microsoft re-consent cannot recreate a connection deleted before callback completion",async () => {
  const waiting=deferred();
  globalThis.fetch=async (url) => url.includes("/token") ? waiting.promise : json({id:"old-account"});
  const conn=getConnection(testUserId,"microsoft");
  const signingIn=ms.exchangeMicrosoftCode(
    "test-code",
    "test-verifier",
    testUserId,
    {mode:"reconsent",expectedConnectionId:conn.id},
  );
  ms.disconnectMicrosoftForUser(testUserId,conn.id);
  waiting.resolve(json({access_token:"new-access",refresh_token:"new-refresh"}));
  await assert.rejects(signingIn,/jungtis leidimui atnaujinti neberasta|target changed or was disconnected/);
  assert.equal(getConnection(testUserId,"microsoft"),null);
});

test("a list response arriving after an account switch cannot poison the new account cache",async () => {
  const waiting=deferred();const reached=deferred();
  globalThis.fetch=async (url) => {
    if (url.includes("/token")) return json({access_token:"old-access"});
    reached.resolve();return waiting.promise;
  };
  const conn=getConnection(testUserId,"microsoft");
  const request=ms.defaultTaskListIdForUser(testUserId,conn);await reached.promise;
  // Simulate account switch: disconnect old, insert new connection
  ms.disconnectMicrosoftForUser(testUserId);
  multiDb.prepare(`
    INSERT INTO oauth_connections
      (user_id, provider, provider_account_id, provider_email,
       encrypted_refresh_token, scopes, generation, status, connected_at)
    VALUES (?, 'microsoft', 'new-account', 'new@example.com', ?, ?, 1, 'active', CURRENT_TIMESTAMP)
  `).run(testUserId, encrypt("new-refresh"), "offline_access User.Read Calendars.ReadWrite Tasks.ReadWrite");
  waiting.resolve(json({value:[{id:"old-list",wellknownListName:"defaultList"}]}));
  // The in-flight request uses the old conn object; after disconnect the
  // connection check fails → graphFetchForUser rejects
  await assert.rejects(request,/pasikeitė/);
});

test("cached token is reused for sequential API calls without hitting the token endpoint again",async () => {
  let refreshes=0;let graphCalls=0;
  globalThis.fetch=async (url,init) => {
    if (url.includes("/token")) {refreshes++;return json({access_token:"cached-access",refresh_token:"rotated-refresh",expires_in:3600});}
    graphCalls++;assert.equal(init.headers.authorization,"Bearer cached-access");return json({value:[]});
  };
  const conn=getConnection(testUserId,"microsoft");
  await ms.graphFetchForUser(testUserId,conn,"/me/events");
  await ms.graphFetchForUser(testUserId,conn,"/me/todo/lists");
  await ms.graphFetchForUser(testUserId,conn,"/me/calendars");
  assert.equal(refreshes,1,"token endpoint must be called only once for three sequential requests");
  assert.equal(graphCalls,3);
});

test("disconnect clears the token cache so the next call triggers a fresh refresh",async () => {
  let refreshes=0;
  globalThis.fetch=async (url) => {
    if (url.includes("/token")) {refreshes++;return json({access_token:"access-"+refreshes,expires_in:3600});}
    return json({value:[]});
  };
  const conn=getConnection(testUserId,"microsoft");
  await ms.graphFetchForUser(testUserId,conn,"/me/events");
  assert.equal(refreshes,1);
  ms.disconnectMicrosoftForUser(testUserId);
  // Re-create the connection with a new refresh token
  multiDb.prepare(`
    INSERT INTO oauth_connections
      (user_id, provider, provider_account_id, provider_email,
       encrypted_refresh_token, scopes, generation, status, connected_at)
    VALUES (?, 'microsoft', 'old-account', 'Old account', ?, ?, 1, 'active', CURRENT_TIMESTAMP)
  `).run(testUserId, encrypt("new-refresh"), "offline_access User.Read Calendars.ReadWrite Tasks.ReadWrite");
  const newConn=getConnection(testUserId,"microsoft");
  await ms.graphFetchForUser(testUserId,newConn,"/me/events");
  assert.equal(refreshes,2,"after disconnect+reconnect the token endpoint must be called again");
});
