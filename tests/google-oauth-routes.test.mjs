import assert from "node:assert/strict";
import {test,after,beforeEach} from "node:test";
import {registerHooks} from "node:module";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
const temp=mkdtempSync(path.join(tmpdir(),"planner-google-consent-"));
Object.assign(process.env,{DATABASE_PATH:path.join(temp,"test.db"),TOKEN_ENCRYPTION_KEY:"ba".repeat(32),APP_ORIGIN:"http://localhost:3000",GOOGLE_CLIENT_ID:"fixture",GOOGLE_CLIENT_SECRET:"fixture",GOOGLE_REDIRECT_URI:"http://localhost:3000/api/google/callback"});
const jar=new Map();globalThis.__googleTestCookies={get:k=>jar.has(k)?{value:jar.get(k)}:undefined,set:(k,v)=>jar.set(k,v),delete:k=>jar.delete(k)};
const hooks=registerHooks({resolve(specifier,context,next){
  if(specifier==="next/headers")return {url:"data:text/javascript,export async function cookies(){return globalThis.__googleTestCookies;}",shortCircuit:true};
  return next(specifier.startsWith("@/")?pathToFileURL(path.resolve(import.meta.dirname,"..",specifier.slice(2)+".ts")).href:specifier,context);
}});
const {db,saveSetting,setting}=await import("../lib/db.ts"),{encrypt}=await import("../lib/secrets.ts");
const connect=await import("../app/api/google/connect/route.ts"),callback=await import("../app/api/google/callback/route.ts"),status=await import("../app/api/google/status/route.ts");
const originalFetch=globalThis.fetch,calendar="https://www.googleapis.com/auth/calendar",tasks="https://www.googleapis.com/auth/tasks";
beforeEach(()=>{db.exec("DELETE FROM settings");jar.clear();saveSetting("google_refresh_token",encrypt("synthetic"));saveSetting("google_account_id","fixture-account");saveSetting("google_connection_generation","fixture-generation");saveSetting("google_granted_scopes",calendar);globalThis.fetch=async()=>{throw Error("No external network allowed");};});
after(()=>{globalThis.fetch=originalFetch;delete globalThis.__googleTestCookies;hooks.deregister();db.close();rmSync(temp,{recursive:true,force:true});});
const req=query=>new Request("http://localhost:3000/api/google/callback?"+new URLSearchParams(query));
const oauthResult=r=>new URL(r.headers.get("location")).searchParams.get("oauth");
function consent(scope){globalThis.fetch=async raw=>{const url=new URL(raw);if(url.origin==="https://oauth2.googleapis.com")return Response.json({access_token:"synthetic-access",scope});if(url.origin==="https://openidconnect.googleapis.com")return Response.json({sub:"fixture-account"});throw Error("No external network allowed");};}

test("Google connect requests incremental Tasks consent and callback marks granted permission",async()=>{
  const response=await connect.GET(new Request("http://localhost:3000/api/google/connect"));
  const auth=new URL(response.headers.get("location")),state=auth.searchParams.get("state");
  assert.equal(jar.get("google_oauth_state"),state);assert.equal(auth.searchParams.get("prompt"),"consent");assert.equal(auth.searchParams.get("include_granted_scopes"),"true");assert.ok(auth.searchParams.get("scope").includes(tasks));
  consent(`${calendar} ${tasks}`);assert.equal(oauthResult(await callback.GET(req({state,code:"synthetic"}))),"connected");
  const s=await status.GET();assert.equal(s.headers.get("cache-control"),"no-store");const body=await s.json();assert.equal(body.tasksConnected,true);assert.equal(body.tasksStatus,"connected");
  assert.equal(oauthResult(await callback.GET(req({state,code:"replay"}))),"error");
});

test("partial or denied Tasks consent reports an actionable result while preserving the old Calendar connection",async()=>{
  jar.set("google_oauth_state","partial");consent(calendar);
  assert.equal(oauthResult(await callback.GET(req({state:"partial",code:"synthetic"}))),"tasks-permission-required");
  let s=await (await status.GET()).json();assert.equal(s.connected,true);assert.equal(s.tasksStatus,"permission_required");
  const stored=setting("google_refresh_token"),generation=setting("google_connection_generation");
  jar.set("google_oauth_state","denied");globalThis.fetch=async()=>{throw Error("Must not exchange denied consent");};
  assert.equal(oauthResult(await callback.GET(req({state:"denied",error:"access_denied"}))),"tasks-permission-required");
  assert.equal(setting("google_refresh_token"),stored);assert.equal(setting("google_connection_generation"),generation);
});

test("invalid OAuth state cannot change permission state or expose provider errors",async()=>{
  jar.set("google_oauth_state","expected");
  const r=await callback.GET(req({state:"wrong",code:"secret",error_description:"DO_NOT_EXPOSE"}));assert.equal(oauthResult(r),"error");assert.ok(!r.headers.get("location").includes("DO_NOT_EXPOSE"));assert.equal(jar.size,0);assert.equal(setting("google_granted_scopes"),calendar);
});
