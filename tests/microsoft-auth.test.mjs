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
process.env.MICROSOFT_REDIRECT_URI="http://localhost:3000/api/microsoft/callback";
process.env.MICROSOFT_CLIENT_ID="test-client";
process.env.MICROSOFT_CLIENT_SECRET="test-secret";
const hooks=registerHooks({resolve(specifier,context,next) {
  return next(specifier.startsWith("@/") ? pathToFileURL(path.resolve(import.meta.dirname,"..",specifier.slice(2)+".ts")).href : specifier,context);
}});
const {db,setting,saveSetting}=await import("../lib/db.ts");
const {encrypt,decrypt}=await import("../lib/secrets.ts");
const ms=await import("../lib/microsoft.ts");
const originalFetch=globalThis.fetch;
after(() => {globalThis.fetch=originalFetch;db.close();hooks.deregister();rmSync(temp,{recursive:true,force:true});});
beforeEach(() => {
  db.exec("DELETE FROM settings");
  saveSetting("microsoft_refresh_token",encrypt("old-refresh"));
  saveSetting("microsoft_account_id","old-account");
  saveSetting("microsoft_account","Old account");
  saveSetting("microsoft_connection_generation","generation-a");
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
  await Promise.all([ms.graphFetch("/me/events"),ms.graphFetch("/me/todo/lists")]);
  assert.equal(refreshes,1);assert.equal(graphCalls,2);
  assert.equal(decrypt(setting("microsoft_refresh_token")),"rotated-refresh");
  assert.notEqual(setting("microsoft_refresh_token"),"rotated-refresh");
});

test("late refresh cannot reconnect a disconnected account or send its Graph request",async () => {
  const waiting=deferred();let calls=0;
  globalThis.fetch=async () => {calls++;return waiting.promise;};
  const request=ms.graphFetch("/me/events");
  ms.disconnectMicrosoft();
  waiting.resolve(json({access_token:"old-access",refresh_token:"late-refresh"}));
  await assert.rejects(request,/pasikeitė/);
  assert.equal(calls,1);assert.equal(ms.isMicrosoftConnected(),false);assert.equal(ms.cachedMicrosoftAccountId(),null);
});

test("failed new profile lookup leaves the previous token and account paired",async () => {
  globalThis.fetch=async (url) => url.includes("/token") ? json({access_token:"new-access",refresh_token:"new-refresh"}) : json({error:"unavailable"},503);
  await assert.rejects(ms.exchangeMicrosoftCode("test-code"));
  assert.equal(ms.cachedMicrosoftAccountId(),"old-account");assert.equal(decrypt(setting("microsoft_refresh_token")),"old-refresh");
});

test("successful account switch atomically replaces identity and clears the old task list",async () => {
  saveSetting("microsoft_task_list_id","old-list");
  globalThis.fetch=async (url) => url.includes("/token") ? json({access_token:"new-access",refresh_token:"new-refresh"}) : json({id:"new-account",displayName:"Test account"});
  await ms.exchangeMicrosoftCode("test-code");
  assert.equal(ms.cachedMicrosoftAccountId(),"new-account");assert.equal(decrypt(setting("microsoft_refresh_token")),"new-refresh");
  assert.equal(setting("microsoft_task_list_id"),undefined);assert.notEqual(setting("microsoft_connection_generation"),"generation-a");
});

test("in-flight sign-in cannot undo a newer disconnect",async () => {
  const waiting=deferred();
  globalThis.fetch=async (url) => url.includes("/token") ? waiting.promise : json({id:"new-account"});
  const signingIn=ms.exchangeMicrosoftCode("test-code");ms.disconnectMicrosoft();
  waiting.resolve(json({access_token:"new-access",refresh_token:"new-refresh"}));
  await assert.rejects(signingIn,/pasikeitė/);assert.equal(ms.isMicrosoftConnected(),false);
});

test("a list response arriving after an account switch cannot poison the new account cache",async () => {
  const waiting=deferred();const reached=deferred();
  globalThis.fetch=async (url) => {
    if (url.includes("/token")) return json({access_token:"old-access"});
    reached.resolve();return waiting.promise;
  };
  const request=ms.defaultTaskListId();await reached.promise;
  ms.disconnectMicrosoft();saveSetting("microsoft_refresh_token",encrypt("new-refresh"));saveSetting("microsoft_account_id","new-account");
  waiting.resolve(json({value:[{id:"old-list",wellknownListName:"defaultList"}]}));
  await assert.rejects(request,/pasikeitė/);assert.equal(setting("microsoft_task_list_id"),undefined);
});
