import assert from "node:assert/strict";
import {test,after} from "node:test";
import {registerHooks} from "node:module";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

// Exercise actual route handlers, provider adapters, encrypted settings and
// SQLite without listening on a port or making any real network request.
const temp=mkdtempSync(path.join(tmpdir(),"planner-event-routes-"));
process.env.DATABASE_PATH=path.join(temp,"test.db");process.env.TOKEN_ENCRYPTION_KEY="ad".repeat(32);
process.env.APP_ORIGIN="http://localhost:3000";process.env.CALENDAR_TEST_FIXTURE="isolated";
for(const provider of ["GOOGLE","MICROSOFT"]){process.env[`${provider}_CLIENT_ID`]="synthetic-client";process.env[`${provider}_CLIENT_SECRET`]="synthetic-secret";process.env[`${provider}_REDIRECT_URI`]=`http://localhost:3000/api/${provider.toLowerCase()}/callback`;}
const hooks=registerHooks({resolve(specifier,context,next){return next(specifier.startsWith("@/")?pathToFileURL(path.resolve(import.meta.dirname,"..",specifier.slice(2)+".ts")).href:specifier,context);}});
const originalFetch=globalThis.fetch;
await import("./fixtures/calendar-upstream.mjs");
const {db,saveSetting}=await import("../lib/db.ts");const {encrypt}=await import("../lib/secrets.ts");
for(const provider of ["google","microsoft"]){saveSetting(`${provider}_refresh_token`,encrypt("synthetic-refresh"));saveSetting(`${provider}_account_id`,"fixture-account");saveSetting(`${provider}_connection_generation`,`${provider}-fixture`);}
const routes={google:await import("../app/api/google/events/route.ts"),microsoft:await import("../app/api/microsoft/events/route.ts")};
after(()=>{globalThis.fetch=originalFetch;db.close();hooks.deregister();rmSync(temp,{recursive:true,force:true});});
const inputFor=e=>({id:e.id,calendarId:e.calendarId,version:e.version,connectionId:e.connectionId,start:e.start.dateTime,end:e.end.dateTime});
for(const provider of ["google","microsoft"]){
  const route=routes[provider],url=`http://localhost:3000/api/${provider}/events`;
  const patch=(body,origin="http://localhost:3000")=>route.PATCH(new Request(url,{method:"PATCH",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(body)}));
  test(`${provider} actual routes: normalized list, move, duration, source reload and conflict status`,async()=>{
    const listed=await route.GET(new Request(url));assert.equal(listed.status,200);assert.equal(listed.headers.get("cache-control"),"no-store");
    const event=(await listed.json()).items.find(e=>e.editable&&!e.attendeeCount);assert.ok(event);
    const input={...inputFor(event),start:new Date(Date.parse(event.start.dateTime)+864e5).toISOString(),end:new Date(Date.parse(event.end.dateTime)+864e5+30*6e4).toISOString()};
    assert.equal((await patch(input,"https://attacker.example")).status,403);
    const response=await patch(input);assert.equal(response.status,200);const updated=await response.json();
    assert.equal(Date.parse(updated.start.dateTime),Date.parse(input.start));assert.equal(Date.parse(updated.end.dateTime)-Date.parse(updated.start.dateTime),90*60000);
    const reloaded=(await (await route.GET(new Request(url))).json()).items.find(e=>e.id===event.id);assert.equal(reloaded.version,updated.version);assert.equal(reloaded.start.dateTime,updated.start.dateTime);
    assert.equal((await patch(input)).status,409);
    const conflict=await patch({...inputFor(updated),summary:"SIMULATE_CONFLICT"});assert.equal(conflict.status,409);assert.match((await conflict.json()).error,/pakeistas kitur/);
  });
  test(`${provider} actual routes: malformed input and arbitrary provider patch are rejected`,async()=>{
    for(const input of [null,[],{}, {id:".."}, {id:"x",patch:{attendees:[]}}])assert.equal((await patch(input)).status,400);
    const broken=await route.PATCH(new Request(url,{method:"PATCH",headers:{Origin:"http://localhost:3000"},body:"{"}));assert.equal(broken.status,400);
  });
}
test("actual Outlook route protects non-organizer events and requires participant confirmation on time change",async()=>{
  const route=routes.microsoft,url="http://localhost:3000/api/microsoft/events";
  const items=(await (await route.GET(new Request(url))).json()).items;
  const withAttendees=items.find(e=>e.attendeeCount&&e.editable);
  if(withAttendees){
    // time change with attendees requires confirmAttendees
    const movedInput={...inputFor(withAttendees),start:new Date(Date.parse(withAttendees.start.dateTime)+3600000).toISOString(),end:new Date(Date.parse(withAttendees.end.dateTime)+3600000).toISOString()};
    assert.equal((await route.PATCH(new Request(url,{method:"PATCH",headers:{Origin:"http://localhost:3000","Content-Type":"application/json"},body:JSON.stringify(movedInput)}))).status,409);
  }
  const nonEditable=items.find(e=>!e.editable);
  if(nonEditable)assert.equal((await route.PATCH(new Request(url,{method:"PATCH",headers:{Origin:"http://localhost:3000","Content-Type":"application/json"},body:JSON.stringify(inputFor(nonEditable))}))).status,403);
});

for(const provider of ["google","microsoft"]) test(`${provider}: same-ID events in different calendars update and delete independently`,async()=>{
  const route=routes[provider],url=`http://localhost:3000/api/${provider}/events`;
  saveSetting(`${provider}_enabled_calendars`,JSON.stringify([{id:"primary"},{id:"other/calendar",name:"Kitas",color:"#123456"}]));
  const items=(await (await route.GET(new Request(url))).json()).items;
  const target=items.find(e=>e.calendarId==="other/calendar"),original=items.find(e=>e.calendarId==="primary"&&e.id===target.id);
  assert.ok(original);assert.notEqual(target.key,original.key);
  const response=await route.PATCH(new Request(url,{method:"PATCH",headers:{Origin:"http://localhost:3000","Content-Type":"application/json"},body:JSON.stringify({...inputFor(target),summary:"Tik antrinis"})}));
  assert.equal(response.status,200);const updated=await response.json();assert.equal(updated.key,target.key);assert.equal(updated.calendarId,"other/calendar");
  const after=(await (await route.GET(new Request(url))).json()).items;
  assert.deepEqual(after.find(e=>e.key===original.key),original);assert.equal(after.find(e=>e.key===target.key).summary,"Tik antrinis");
  const headers={Origin:"http://localhost:3000"};
  assert.equal((await route.DELETE(new Request(url+"?id="+encodeURIComponent(target.id),{method:"DELETE",headers}))).status,400);
  const query=new URLSearchParams({id:updated.id,calendarId:updated.calendarId,connectionId:updated.connectionId,version:updated.version});
  for(const [field,value] of [["version","outdated"],["connectionId","another-account"]]) {
    const stale=new URLSearchParams(query);stale.set(field,value);
    assert.equal((await route.DELETE(new Request(url+"?"+stale,{method:"DELETE",headers}))).status,409);
  }
  assert.equal((await route.DELETE(new Request(url+"?"+query,{method:"DELETE",headers:{Origin:"https://attacker.example"}}))).status,403);
  assert.equal((await route.DELETE(new Request(url+"?"+query,{method:"DELETE",headers}))).status,200);
  const remaining=(await (await route.GET(new Request(url))).json()).items;
  assert.ok(remaining.some(e=>e.key===original.key));assert.ok(!remaining.some(e=>e.key===target.key));
  saveSetting(`${provider}_enabled_calendars`,JSON.stringify([{id:"primary"}]));
});
