import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {createServer} from "node:net";
import {setTimeout as delay} from "node:timers/promises";
import path from "node:path";
import {encrypt} from "../lib/secrets.ts";

const preview=process.argv.includes("--preview"),temp=mkdtempSync(path.join(tmpdir(),"planner-calendar-http-"));
const reservation=createServer();await new Promise((r,j)=>reservation.once("error",j).listen(preview?3101:0,"127.0.0.1",r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const origin=`http://127.0.0.1:${port}`,database=path.join(temp,"test.db");
process.env.TOKEN_ENCRYPTION_KEY="ac".repeat(32);
process.env.DATABASE_PATH=database;process.env.MULTI_USER_DATABASE_PATH=database;
const {db,createSession,SESSION_COOKIE}=await import("../lib/db-multi.ts");
const user=db.prepare("INSERT INTO users(display_name,primary_email,role,status) VALUES (?,?,'admin','active')").run("Calendar fixture","calendar@example.test");const userId=Number(user.lastInsertRowid);
for(const provider of ["google","microsoft"]){db.prepare("INSERT INTO oauth_connections(user_id,provider,provider_account_id,provider_email,encrypted_refresh_token,scopes,status) VALUES (?,?,?,?,?,?,'active')").run(userId,provider,"fixture-account","fixture@example.test",encrypt("synthetic-refresh"),provider==="google"?"https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks":"Calendars.ReadWrite Tasks.ReadWrite");}
const {rawToken}=createSession(userId),sessionCookie=`${SESSION_COOKIE}=${rawToken}`,nativeFetch=globalThis.fetch;globalThis.fetch=(input,init={})=>{const headers=new Headers(init.headers);headers.set("Cookie",sessionCookie);return nativeFetch(input,{...init,headers});};
const env={...process.env,DATABASE_PATH:database,MULTI_USER_DATABASE_PATH:database,APP_ORIGIN:origin,PORT:String(port),HOSTNAME:"127.0.0.1",CALENDAR_TEST_FIXTURE:"isolated"};
for(const provider of ["GOOGLE","MICROSOFT"]){env[`${provider}_CLIENT_ID`]="synthetic-client";env[`${provider}_CLIENT_SECRET`]="synthetic-secret";env[`${provider}_REDIRECT_URI`]=`${origin}/api/${provider.toLowerCase()}/callback`;}
const child=spawn(process.execPath,["--import",path.resolve("tests/fixtures/calendar-upstream.mjs"),"scripts/start.mjs"],{env,stdio:"ignore"});
const stopped=new Promise(r=>child.once("exit",r));
try {
  let ready=false;for(let i=0;i<80;i++){if(child.exitCode!==null)throw new Error("Fixture server failed");try{ready=(await fetch(origin)).ok;}catch{}if(ready)break;await delay(150);}assert.ok(ready);
  const headers={Origin:origin,"Content-Type":"application/json"};
  for(const provider of ["google","microsoft"]){
    const api=`${origin}/api/${provider}/events`,list=await (await fetch(api)).json();
    const event=list.items.find(e=>e.editable && !e.attendeeCount);assert.ok(event);
    const start=new Date(Date.parse(event.start.dateTime)+864e5).toISOString(),end=new Date(Date.parse(event.end.dateTime)+864e5+30*6e4).toISOString();
    const input={id:event.id,calendarId:event.calendarId,connectionId:event.connectionId,version:event.version,start,end};
    assert.equal((await fetch(api,{method:"PATCH",headers:{...headers,Origin:"https://evil.example"},body:JSON.stringify(input)})).status,403);
    const updated=await fetch(api,{method:"PATCH",headers,body:JSON.stringify(input)});assert.equal(updated.status,200);const result=await updated.json();
    assert.equal(Date.parse(result.start.dateTime),Date.parse(start));assert.notEqual(result.version,event.version);
    assert.equal((await fetch(api,{method:"PATCH",headers,body:JSON.stringify(input)})).status,409);
    const conflict=await fetch(api,{method:"PATCH",headers,body:JSON.stringify({...input,version:result.version,summary:"SIMULATE_CONFLICT"})});assert.equal(conflict.status,409);
  }
  const api=`${origin}/api/microsoft/events`,items=(await (await fetch(api)).json()).items;
  const meeting=items.find(e=>e.attendeeCount),locked=items.find(e=>!e.editable);
  // meeting: time change + attendees → 409 (requires confirmAttendees)
  const meetingShift=h=>new Date(Date.parse(h)+30*6e4).toISOString();
  assert.equal((await fetch(api,{method:"PATCH",headers,body:JSON.stringify({id:meeting.id,calendarId:meeting.calendarId,connectionId:meeting.connectionId,version:meeting.version,start:meetingShift(meeting.start.dateTime),end:meetingShift(meeting.end.dateTime)})})).status,409);
  // locked: not organizer → 403
  assert.equal((await fetch(api,{method:"PATCH",headers,body:JSON.stringify({id:locked.id,calendarId:locked.calendarId,connectionId:locked.connectionId,version:locked.version,start:locked.start.dateTime,end:locked.end.dateTime})})).status,403);
  console.log(`OK: abiejų kalendorių HTTP skaitymas, perkėlimas, trukmė, versijos konfliktai, dalyvių patvirtinimas ir teisės. ${origin}`);
  if(preview)await new Promise(resolve=>{process.once("SIGINT",resolve);process.once("SIGTERM",resolve);});
} finally {child.kill("SIGTERM");await stopped;rmSync(temp,{recursive:true,force:true});}
