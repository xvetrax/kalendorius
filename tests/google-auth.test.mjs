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
