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
const {db,saveSetting,setting}=await import("../lib/db.ts");const {encrypt}=await import("../lib/secrets.ts");
for(const provider of ["google","microsoft"]){saveSetting(`${provider}_refresh_token`,encrypt("synthetic-refresh"));saveSetting(`${provider}_account_id`,"fixture-account");saveSetting(`${provider}_connection_generation`,`${provider}-fixture`);}
const routes={google:await import("../app/api/google/events/route.ts"),microsoft:await import("../app/api/microsoft/events/route.ts")};
const microsoftCalendars=await import("../app/api/microsoft/calendars/route.ts");
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
  test(`${provider} actual routes: detailed timed properties persist and reload`,async()=>{
    const event=(await (await route.GET(new Request(url))).json()).items.find(item=>item.editable&&!item.attendeeCount&&!item.recurring);assert.ok(event);
    const body={...inputFor(event),showAs:"free",visibility:"private",reminder:{mode:"minutes",minutes:30}};
    const response=await patch(body);assert.equal(response.status,200);const updated=await response.json();
    assert.equal(updated.showAs,"free");assert.equal(updated.visibility,"private");assert.deepEqual(updated.reminder,{mode:"minutes",minutes:30});
    const reloaded=(await (await route.GET(new Request(url))).json()).items.find(item=>item.key===event.key);
    assert.equal(reloaded.version,updated.version);assert.equal(reloaded.showAs,"free");assert.equal(reloaded.visibility,"private");assert.deepEqual(reloaded.reminder,{mode:"minutes",minutes:30});
  });
}
for(const provider of ["google","microsoft"])test(`${provider} actual route submits an account-bound RSVP and reloads its status`,async()=>{
  const route=routes[provider],url=`http://localhost:3000/api/${provider}/events`;
  const event=(await (await route.GET(new Request(url))).json()).items.find(item=>item.canRespond);assert.ok(event);assert.equal(event.editable,false);assert.equal(event.responseStatus,"needsAction");
  const body={id:event.id,calendarId:event.calendarId,connectionId:event.connectionId,version:event.version,responseStatus:"accepted"};
  const put=(value,origin="http://localhost:3000")=>route.PUT(new Request(url,{method:"PUT",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(value)}));
  assert.equal((await put(body,"https://attacker.example")).status,403);
  assert.equal((await put({...body,version:"stale"})).status,409);
  const response=await put(body);assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,responseStatus:"accepted"});
  assert.equal((await put(body)).status,200);
  const reloaded=(await (await route.GET(new Request(url))).json()).items.find(item=>item.key===event.key);assert.equal(reloaded.responseStatus,"accepted");assert.notEqual(reloaded.version,event.version);
  assert.equal((await put({...body,version:reloaded.version,responseStatus:"invalid"})).status,400);
});
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
  const selected=[{id:"primary"},{id:"other/calendar",name:"Kitas",color:"#123456"}];
  saveSetting(`${provider}_enabled_calendars`,JSON.stringify(provider==="microsoft"?{accountId:"fixture-account",items:selected}:selected));
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
  const primary=[{id:"primary"}];saveSetting(`${provider}_enabled_calendars`,JSON.stringify(provider==="microsoft"?{accountId:"fixture-account",items:primary}:primary));
});

test("Outlook route confirms mirror identity by account and transaction, never by event ID alone",async()=>{
  const {calendarUpstream}=await import("./fixtures/calendar-upstream.mjs");
  const source=calendarUpstream.outlook.get("primary").get("outlook-personal");
  const mirror={...structuredClone(source),id:"mirror-shared",showAs:"free",transactionId:"created-by-this-plan",subject:"✓ Darbas",
    bodyPreview:"Dienos planas: pasirenkamas užduoties darbo laikas.",body:{contentType:"text",content:"Dienos planas: pasirenkamas užduoties darbo laikas."},
    isReminderOn:false,isOnlineMeeting:false,onlineMeeting:null,location:{displayName:""},sensitivity:"normal",importance:"normal",hasAttachments:false,categories:[],recurrence:null};
  const defaultCalendar=new Map([[mirror.id,mirror]]),other=calendarUpstream.outlook.get("other/calendar");
  calendarUpstream.outlook.set("opaque-default",defaultCalendar);other.set(mirror.id,structuredClone(mirror));
  const catalogResponse=await microsoftCalendars.GET();assert.equal(catalogResponse.status,200);
  assert.ok((await catalogResponse.json()).items.some(calendar=>calendar.id==="opaque-default"&&calendar.isDefault));
  assert.deepEqual(JSON.parse(setting("microsoft_default_calendar_identity")),["fixture-account","microsoft-fixture","opaque-default"]);
  const selection=await microsoftCalendars.PATCH(new Request("http://localhost:3000/api/microsoft/calendars",{method:"PATCH",headers:{Origin:"http://localhost:3000","Content-Type":"application/json"},body:JSON.stringify({enabled:[{id:"opaque-default"},{id:"other/calendar"}]})}));
  assert.equal(selection.status,200);assert.equal(JSON.parse(setting("microsoft_enabled_calendars")).accountId,"fixture-account");
  db.prepare("DELETE FROM settings WHERE key='microsoft_default_calendar_identity'").run();
  const insert=db.prepare(`INSERT INTO task_plans(task_key,scheduled_at,mirror_requested,mirror_account_id,mirror_event_id,mirror_transaction_id) VALUES (?,?,1,?,?,?)`);
  insert.run("mirror-test",source.start.dateTime+"Z","fixture-account",mirror.id,mirror.transactionId);
  const list=async()=>{
    const response=await routes.microsoft.GET(new Request("http://localhost:3000/api/microsoft/events"));
    assert.equal(response.status,200);return (await response.json()).items.filter(e=>e.id===mirror.id);
  };
  try {
    let events=await list();assert.equal(events.find(e=>e.calendarId==="opaque-default").mirrorTaskKey,"mirror-test");
    assert.equal(events.find(e=>e.calendarId==="other/calendar").mirrorTaskKey,null);
    assert.ok(events.every(e=>!("transactionId" in e)));
    saveSetting("microsoft_account_id","different-account");assert.deepEqual(await list(),[]);
    saveSetting("microsoft_account_id","fixture-account");
    saveSetting("microsoft_connection_generation","different-generation");events=await list();
    assert.equal(events.find(e=>e.calendarId==="opaque-default").mirrorTaskKey,"mirror-test");
    assert.deepEqual(JSON.parse(setting("microsoft_default_calendar_identity")),["fixture-account","different-generation","opaque-default"]);
    saveSetting("microsoft_connection_generation","microsoft-fixture");
    for (const change of [{transactionId:undefined},{showAs:"busy"},{isOrganizer:false},{isAllDay:true},{type:"occurrence"},{attendees:[{emailAddress:{address:"guest@example.test"}}]},
      {isReminderOn:true},{location:{displayName:"Kita vieta"}},{bodyPreview:"Pakeistas turinys"},{isOnlineMeeting:true},{onlineMeeting:{joinUrl:"https://teams.example.test"}},
      {sensitivity:"private"},{importance:"high"},{hasAttachments:true},{categories:["Pakeista"]},{recurrence:{pattern:{type:"daily"}}}]) {
      defaultCalendar.set(mirror.id,{...mirror,...change});assert.ok((await list()).every(e=>e.mirrorTaskKey===null),JSON.stringify(change));
    }
    defaultCalendar.set(mirror.id,mirror);
    insert.run("mirror-ambiguous",source.start.dateTime+"Z","fixture-account",mirror.id,mirror.transactionId);
    assert.ok((await list()).every(e=>e.mirrorTaskKey===null));
    db.prepare("DELETE FROM task_plans WHERE task_key=?").run("mirror-ambiguous");
    for (const sql of ["mirror_requested=0","mirror_error='Retry'","scheduled_at=NULL"]) {
      db.prepare(`UPDATE task_plans SET ${sql} WHERE task_key='mirror-test'`).run();
      assert.ok((await list()).every(e=>e.mirrorTaskKey===null));
      db.prepare("UPDATE task_plans SET mirror_requested=1,mirror_error=NULL,scheduled_at=? WHERE task_key='mirror-test'").run(source.start.dateTime+"Z");
    }
    // Mutation responses must clear a formerly confirmed association explicitly.
    const linked=(await list()).find(e=>e.calendarId==="opaque-default");defaultCalendar.set(mirror.id,{...mirror,transactionId:undefined});
    const response=await routes.microsoft.PATCH(new Request("http://localhost:3000/api/microsoft/events",{method:"PATCH",headers:{Origin:"http://localhost:3000","Content-Type":"application/json"},body:JSON.stringify(inputFor(linked))}));
    assert.equal(response.status,200);assert.equal((await response.json()).mirrorTaskKey,null);
  } finally {
    calendarUpstream.outlook.delete("opaque-default");other.delete(mirror.id);
    db.prepare("DELETE FROM task_plans WHERE task_key IN ('mirror-test','mirror-ambiguous')").run();
    db.prepare("DELETE FROM settings WHERE key='microsoft_default_calendar_identity'").run();
    saveSetting("microsoft_account_id","fixture-account");saveSetting("microsoft_connection_generation","microsoft-fixture");
    saveSetting("microsoft_enabled_calendars",JSON.stringify({accountId:"fixture-account",items:[{id:"primary"}]}));
  }
});
