import assert from "node:assert/strict";
import {test,after} from "node:test";
import {registerHooks} from "node:module";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {zonedInstant,zonedLocalInput} from "../lib/calendar-time-zone.ts";

// Exercise actual route handlers, provider adapters, encrypted settings and
// SQLite without listening on a port or making any real network request.
// Both DATABASE_PATH and MULTI_USER_DATABASE_PATH point to the same temp file
// so that the multi-user schema (user_settings, oauth_connections, task_plans
// with user_id, etc.) is created in the same database that lib/db.ts opens.
const temp=mkdtempSync(path.join(tmpdir(),"planner-event-routes-"));
const dbFile=path.join(temp,"test.db");
process.env.DATABASE_PATH=dbFile;
process.env.MULTI_USER_DATABASE_PATH=dbFile;
process.env.TOKEN_ENCRYPTION_KEY="ad".repeat(32);
process.env.APP_ORIGIN="http://localhost:3000";process.env.CALENDAR_TEST_FIXTURE="isolated";
for(const provider of ["GOOGLE","MICROSOFT"]){process.env[`${provider}_CLIENT_ID`]="synthetic-client";process.env[`${provider}_CLIENT_SECRET`]="synthetic-secret";process.env[`${provider}_REDIRECT_URI`]=`http://localhost:3000/api/${provider.toLowerCase()}/callback`;}
const hooks=registerHooks({resolve(specifier,context,next){return next(specifier.startsWith("@/")?pathToFileURL(path.resolve(import.meta.dirname,"..",specifier.slice(2)+".ts")).href:specifier,context);}});
const originalFetch=globalThis.fetch;
const fixture=await import("./fixtures/calendar-upstream.mjs"),{calendarUpstream,calendarUpstreamWrites}=fixture;
// Import db-multi FIRST so multi-user schema (user_settings, oauth_connections,
// task_plans with user_id, etc.) is applied before lib/db.ts runs.
const {db:multiDb,createSession,SESSION_COOKIE}=await import("../lib/db-multi.ts");
const {db,saveUserSetting,userSetting}=await import("../lib/db.ts");
const {encrypt}=await import("../lib/secrets.ts");

// Bootstrap test user and session in the multi-user DB.
const userResult=multiDb.prepare(
  "INSERT INTO users (display_name, primary_email, role, status, created_at) VALUES (?, ?, 'admin', 'active', CURRENT_TIMESTAMP)"
).run("Calendar Test User","caltest@example.com");
const testUserId=Number(userResult.lastInsertRowid);
const {rawToken}=createSession(testUserId);
const sessionCookie=`${SESSION_COOKIE}=${rawToken}`;

// Insert per-user oauth_connections for both providers.
// connectionId = String(conn.id) — the numeric row id — is used in event keys.
const connIds={};
for(const provider of ["google","microsoft"]){
  multiDb.prepare(`
    INSERT INTO oauth_connections
      (user_id, provider, provider_account_id, provider_email,
       encrypted_refresh_token, scopes, generation, status, connected_at)
    VALUES (?, ?, 'fixture-account', 'test@fixture.example', ?, ?, 1, 'active', CURRENT_TIMESTAMP)
  `).run(
    testUserId,provider,encrypt("synthetic-refresh"),
    provider==="google"
      ?"https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks offline_access"
      :"offline_access User.Read Calendars.ReadWrite Tasks.ReadWrite"
  );
  const row=multiDb.prepare("SELECT id FROM oauth_connections WHERE user_id=? AND provider=?").get(testUserId,provider);
  connIds[provider]=String(row.id);
}

const routes={google:await import("../app/api/google/events/route.ts"),microsoft:await import("../app/api/microsoft/events/route.ts")};
const calendarCatalogs={google:await import("../app/api/google/calendars/route.ts"),microsoft:await import("../app/api/microsoft/calendars/route.ts")};
const microsoftCalendars=calendarCatalogs.microsoft;
after(()=>{globalThis.fetch=originalFetch;db.close();hooks.deregister();rmSync(temp,{recursive:true,force:true});});
const inputFor=e=>({id:e.id,calendarId:e.calendarId,version:e.version,connectionId:e.connectionId,start:e.start.dateTime,end:e.end.dateTime});
const shiftDate=(value,days)=>{const date=new Date(`${value}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);};
let createOperation=0;const operationId=()=>`00000000-0000-4000-8000-${String(++createOperation).padStart(12,"0")}`;

for(const provider of ["google","microsoft"]){
  const route=routes[provider],url=`http://localhost:3000/api/${provider}/events`;
  const patch=(body,origin="http://localhost:3000")=>route.PATCH(new Request(url,{method:"PATCH",headers:{Origin:origin,"Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify(body)}));
  const post=(body,origin="http://localhost:3000")=>route.POST(new Request(url,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify({operationId:body.operationId||operationId(),...body})}));
  test(`${provider} actual routes: normalized list, move, duration, source reload and conflict status`,async()=>{
    const listed=await route.GET(new Request(url,{headers:{Cookie:sessionCookie}}));assert.equal(listed.status,200);assert.equal(listed.headers.get("cache-control"),"no-store");
    const event=(await listed.json()).items.find(e=>e.editable&&!e.attendeeCount);assert.ok(event);
    const input={...inputFor(event),start:new Date(Date.parse(event.start.dateTime)+864e5).toISOString(),end:new Date(Date.parse(event.end.dateTime)+864e5+30*6e4).toISOString()};
    assert.equal((await patch(input,"https://attacker.example")).status,403);
    const response=await patch(input);assert.equal(response.status,200);const updated=await response.json();
    assert.equal(Date.parse(updated.start.dateTime),Date.parse(input.start));assert.equal(Date.parse(updated.end.dateTime)-Date.parse(updated.start.dateTime),90*60000);
    const reloaded=(await (await route.GET(new Request(url,{headers:{Cookie:sessionCookie}}))).json()).items.find(e=>e.id===event.id);assert.equal(reloaded.version,updated.version);assert.equal(reloaded.start.dateTime,updated.start.dateTime);
    assert.equal((await patch(input)).status,409);
    const conflict=await patch({...inputFor(updated),summary:"SIMULATE_CONFLICT"});assert.equal(conflict.status,409);assert.match((await conflict.json()).error,/pakeistas kitur/);
  });
  test(`${provider} actual routes: malformed input and arbitrary provider patch are rejected`,async()=>{
    for(const input of [null,[],{}, {id:".."}, {id:"x",patch:{attendees:[]}}])assert.equal((await patch(input)).status,400);
    const broken=await route.PATCH(new Request(url,{method:"PATCH",headers:{Origin:"http://localhost:3000",Cookie:sessionCookie},body:"{"}));assert.equal(broken.status,400);
  });
  test(`${provider} actual routes: detailed timed properties persist and reload`,async()=>{
    const event=(await (await route.GET(new Request(url,{headers:{Cookie:sessionCookie}}))).json()).items.find(item=>item.editable&&!item.attendeeCount&&!item.recurring);assert.ok(event);
    const body={...inputFor(event),showAs:"free",visibility:"private",reminder:{mode:"minutes",minutes:30}};
    const response=await patch(body);assert.equal(response.status,200);const updated=await response.json();
    assert.equal(updated.showAs,"free");assert.equal(updated.visibility,"private");assert.deepEqual(updated.reminder,{mode:"minutes",minutes:30});
    const reloaded=(await (await route.GET(new Request(url,{headers:{Cookie:sessionCookie}}))).json()).items.find(item=>item.key===event.key);
    assert.equal(reloaded.version,updated.version);assert.equal(reloaded.showAs,"free");assert.equal(reloaded.visibility,"private");assert.deepEqual(reloaded.reminder,{mode:"minutes",minutes:30});
  });
  test(`${provider} actual routes: all-day dates persist and reload`,async()=>{
    const event=(await (await route.GET(new Request(url,{headers:{Cookie:sessionCookie}}))).json()).items.find(item=>item.allDay&&item.editable);assert.ok(event);assert.ok(event.start.date);assert.ok(event.end.date);
    const body={id:event.id,calendarId:event.calendarId,version:event.version,connectionId:event.connectionId,allDay:true,start:shiftDate(event.start.date,1),end:shiftDate(event.end.date,1)};
    const response=await patch(body);assert.equal(response.status,200);const updated=await response.json();assert.equal(updated.start.date,body.start);assert.equal(updated.end.date,body.end);assert.equal(updated.allDay,true);
    const reloaded=(await (await route.GET(new Request(url,{headers:{Cookie:sessionCookie}}))).json()).items.find(item=>item.key===event.key);assert.equal(reloaded.version,updated.version);assert.equal(reloaded.start.date,body.start);assert.equal(reloaded.end.date,body.end);
  });
  test(`${provider} actual routes: timed and all-day modes convert in both directions`,async()=>{
    const event=(await (await route.GET(new Request(url,{headers:{Cookie:sessionCookie}}))).json()).items.find(item=>item.editable&&!item.allDay&&!item.attendeeCount&&!item.recurring);assert.ok(event);
    const identity={id:event.id,calendarId:event.calendarId,connectionId:event.connectionId,version:event.version};
    const allDayResponse=await patch({...identity,allDay:true,start:"2026-10-27",end:"2026-10-29"});assert.equal(allDayResponse.status,200);const allDay=await allDayResponse.json();assert.equal(allDay.allDay,true);assert.deepEqual(allDay.start,{date:"2026-10-27"});assert.deepEqual(allDay.end,{date:"2026-10-29"});
    const timedResponse=await patch({...identity,version:allDay.version,allDay:false,start:"2026-10-27T07:00:00Z",end:"2026-10-27T08:00:00Z",timeZone:"Europe/Vilnius"});assert.equal(timedResponse.status,200);const timed=await timedResponse.json();assert.equal(timed.allDay,false);assert.equal(timed.start.dateTime,"2026-10-27T07:00:00.000Z");assert.equal(timed.end.dateTime,"2026-10-27T08:00:00.000Z");assert.equal(timed.timeZone,"Europe/Vilnius");
    const reloaded=(await (await route.GET(new Request(url,{headers:{Cookie:sessionCookie}}))).json()).items.find(item=>item.key===event.key);assert.equal(reloaded.version,timed.version);assert.equal(reloaded.allDay,false);assert.equal(reloaded.start.dateTime,timed.start.dateTime);
  });
  test(`${provider} actual routes: a timezone change preserves wall time and reloads`,async()=>{
    const event=(await (await route.GET(new Request(url,{headers:{Cookie:sessionCookie}}))).json()).items.find(item=>item.editable&&!item.allDay&&!item.attendeeCount);assert.ok(event);assert.ok(event.timeZone);
    const target=event.timeZone==="Europe/London"?"Europe/Vilnius":"Europe/London",start=zonedInstant(zonedLocalInput(event.start.dateTime,event.timeZone),target),end=zonedInstant(zonedLocalInput(event.end.dateTime,event.timeZone),target);
    const response=await patch({...inputFor(event),start,end,timeZone:target});assert.equal(response.status,200);const updated=await response.json();assert.equal(updated.timeZone,target);assert.equal(updated.start.dateTime,start);assert.equal(updated.end.dateTime,end);
    const reloaded=(await (await route.GET(new Request(url,{headers:{Cookie:sessionCookie}}))).json()).items.find(item=>item.key===event.key);assert.equal(reloaded.timeZone,target);assert.equal(reloaded.start.dateTime,start);assert.equal(reloaded.end.dateTime,end);
  });
  test(`${provider} actual routes: timed creation writes the selected timezone`,async()=>{
    const requested=provider==="google"?"Europe/Vilnius":"Europe/Kyiv",providerZone=provider==="google"?requested:"Europe/Kiev",before=calendarUpstreamWrites.length;
    const catalogResponse=await calendarCatalogs[provider].GET(new Request(`http://localhost:3000/api/${provider}/calendars`,{headers:{Cookie:sessionCookie}})),catalog=await catalogResponse.json();assert.equal(catalogResponse.status,200);assert.ok(catalog.version);assert.deepEqual(catalog.enabled,[provider==="google"?"primary":"opaque-default"]);
    const body={calendarId:"other/calendar",calendarVersion:catalog.version,summary:`${provider} zonos kūrimas`,start:"2026-10-24T07:00:00Z",end:"2026-10-24T08:00:00Z",timeZone:requested,showAs:"busy"};
    assert.equal((await post(body)).status,409);assert.equal(calendarUpstreamWrites.length,before);
    const selection=await calendarCatalogs[provider].PATCH(new Request(`http://localhost:3000/api/${provider}/calendars`,{method:"PATCH",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify({enabled:catalog.items.map(item=>({id:item.id})),version:catalog.version})}));assert.equal(selection.status,200);
    const response=await post(body);assert.equal(response.status,201);assert.equal(calendarUpstreamWrites.length,before+1);
    const write=calendarUpstreamWrites.at(-1);assert.equal(write.provider,provider==="google"?"google":"outlook");assert.equal(write.body.start.timeZone,providerZone);assert.equal(write.body.end.timeZone,providerZone);
    assert.match(write.path,/\/calendars\/other%2Fcalendar\/events$/);
    if(provider==="google"){assert.equal(write.body.start.dateTime,"2026-10-24T07:00:00.000Z");assert.equal(write.body.end.dateTime,"2026-10-24T08:00:00.000Z");}
    else {assert.equal(write.body.start.dateTime,"2026-10-24T10:00:00");assert.equal(write.body.end.dateTime,"2026-10-24T11:00:00");}
  });
  test(`${provider} actual routes: recurring create is idempotent and a series rule uses the master version`,async()=>{
    const catalog=await (await calendarCatalogs[provider].GET(new Request(`http://localhost:3000/api/${provider}/calendars`,{headers:{Cookie:sessionCookie}}))).json(),id=operationId(),calendarId=catalog.items.find(item=>item.primary||item.isDefault)?.id||"primary",map=calendarUpstream[provider==="google"?"google":"outlook"].get(calendarId),before=map.size;
    const recurrence={frequency:"weekly",interval:2,days_of_week:["monday","wednesday"],end:{type:"count",count:8}};
    const body={operationId:id,calendarId,calendarVersion:catalog.version,summary:`${provider} kartojimas`,start:"2026-10-26T07:00:00Z",end:"2026-10-26T08:00:00Z",timeZone:"Europe/Vilnius",recurrence};
    const first=await post(body);assert.equal(first.status,201);const created=await first.json();assert.equal(map.size,before+1);
    const second=await post(body);assert.ok([200,201].includes(second.status));assert.equal((await second.json()).id,created.id);assert.equal(map.size,before+1);
    const changedPayload=await post({...body,summary:`${body.summary} pakeistas`});assert.equal(changedPayload.status,409);assert.equal(map.size,before+1);
    const writes=calendarUpstreamWrites.filter(write=>write.body.summary===body.summary||write.body.subject===body.summary);assert.equal(writes.length,2);
    if(provider==="google"){assert.match(writes[0].body.id,/^dp[0-9a-v]{40}$/);assert.deepEqual(writes[0].body.recurrence,["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=8"]);}
    else {assert.ok(writes[0].body.transactionId);assert.deepEqual(writes[0].body.recurrence,{pattern:{type:"weekly",interval:2,daysOfWeek:["monday","wednesday"],firstDayOfWeek:"monday"},range:{type:"numbered",startDate:"2026-10-26",numberOfOccurrences:8,recurrenceTimeZone:"Europe/Vilnius"}});}

    // connectionId is now the numeric oauth_connections row id (String(conn.id))
    const occurrence={seriesId:provider==="google"?"test-series":"outlook-series",calendarId:"primary",connectionId:connIds[provider]};
    const query=new URLSearchParams({seriesId:occurrence.seriesId,calendarId:occurrence.calendarId,connectionId:occurrence.connectionId}),snapshotResponse=await route.GET(new Request(`${url}?${query}`,{headers:{Cookie:sessionCookie}}));assert.equal(snapshotResponse.status,200);const snapshot=await snapshotResponse.json();assert.equal(snapshot.supported,true);assert.ok(snapshot.version);assert.ok(snapshot.startDate);
    const nextRule={frequency:"daily",interval:3,end:{type:"date",date:shiftDate(snapshot.startDate,30)}};
    const changed=await patch({scope:"series",seriesId:occurrence.seriesId,calendarId:occurrence.calendarId,connectionId:occurrence.connectionId,version:snapshot.version,recurrence:nextRule});assert.equal(changed.status,200);const updated=await changed.json();assert.deepEqual(updated.recurrence,nextRule);
    assert.equal((await patch({scope:"series",seriesId:occurrence.seriesId,calendarId:occurrence.calendarId,connectionId:occurrence.connectionId,version:snapshot.version,recurrence:nextRule})).status,409);
  });
  test(`${provider} actual routes: an ambiguous create can be retried without a duplicate`,async()=>{
    const catalog=await (await calendarCatalogs[provider].GET(new Request(`http://localhost:3000/api/${provider}/calendars`,{headers:{Cookie:sessionCookie}}))).json(),id=operationId(),calendarId=catalog.items.find(item=>item.primary||item.isDefault)?.id||"primary",map=calendarUpstream[provider==="google"?"google":"outlook"].get(calendarId),before=map.size;
    const body={operationId:id,calendarId,calendarVersion:catalog.version,summary:"SIMULATE_AMBIGUOUS_CREATE",start:"2026-11-02T08:00:00Z",end:"2026-11-02T09:00:00Z",timeZone:"UTC"};
    const first=await post(body);assert.equal(first.status,provider==="google"?200:502);const changed=await post({...body,summary:"Pakeista po neaiškaus atsakymo"});assert.equal(changed.status,409);assert.equal(map.size,before+1);const second=await post(body);assert.ok([200,201].includes(second.status));assert.equal(map.size,before+1);
  });
  test(`${provider} actual routes: removed enabled calendars are pruned before listing`,async()=>{
    const key=`${provider}_enabled_calendars`,previous=userSetting(testUserId,key);
    try {
      saveUserSetting(testUserId,key,JSON.stringify({accountId:"fixture-account",items:[{id:"removed-calendar"}]}));
      const listed=await route.GET(new Request(url,{headers:{Cookie:sessionCookie}}));assert.equal(listed.status,200);assert.deepEqual((await listed.json()).items,[]);
      const catalogResponse=await calendarCatalogs[provider].GET(new Request(`http://localhost:3000/api/${provider}/calendars`,{headers:{Cookie:sessionCookie}})),catalog=await catalogResponse.json();assert.equal(catalogResponse.status,200);assert.deepEqual(catalog.enabled,[]);
      const saved=await calendarCatalogs[provider].PATCH(new Request(`http://localhost:3000/api/${provider}/calendars`,{method:"PATCH",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify({enabled:[],version:catalog.version})}));
      assert.equal(saved.status,200);assert.deepEqual(JSON.parse(userSetting(testUserId,key)).items,[]);
    } finally {
      if(previous===undefined)db.prepare("DELETE FROM user_settings WHERE user_id=? AND key=?").run(testUserId,key);
      else saveUserSetting(testUserId,key,previous);
    }
  });
  test(`${provider} actual routes: invalid and all-day timezones never create`,async()=>{
    const catalogResponse=await calendarCatalogs[provider].GET(new Request(`http://localhost:3000/api/${provider}/calendars`,{headers:{Cookie:sessionCookie}})),catalog=await catalogResponse.json();assert.equal(catalogResponse.status,200);
    const before=calendarUpstreamWrites.length,base={calendarId:"other/calendar",calendarVersion:catalog.version,summary:"Nekurti",start:"2026-10-24T07:00:00Z",end:"2026-10-24T08:00:00Z"};
    assert.equal((await post({...base,calendarId:undefined,timeZone:"UTC"})).status,400);
    assert.equal((await post({...base,calendarVersion:"stale",timeZone:"UTC"})).status,409);
    assert.equal((await post({...base,timeZone:"+03:00"})).status,400);
    assert.equal((await post({...base,allDay:true,start:"2026-10-24",end:"2026-10-25",timeZone:"Europe/Vilnius"})).status,400);
    if(provider==="microsoft"){
      assert.equal((await post({...base,timeZone:"Pacific/Auckland"})).status,400);
      const fold=await post({...base,start:"2026-10-24T23:30:00Z",end:"2026-10-25T00:30:00Z",timeZone:"Europe/Vilnius"});assert.equal(fold.status,400);assert.match((await fold.json()).error,/kartojasi/);
    }
    assert.equal((await post({...base,calendarId:"readonly",timeZone:"UTC"})).status,403);
    assert.equal((await post({...base,timeZone:"UTC"},"https://attacker.example")).status,403);assert.equal(calendarUpstreamWrites.length,before);
    saveUserSetting(testUserId,`${provider}_enabled_calendars`,JSON.stringify({accountId:"fixture-account",items:[{id:"primary"}]}));
  });
}

test("Google legacy calendar selections migrate without losing explicit empty or secondary calendars",async()=>{
  const key="google_enabled_calendars",previous=userSetting(testUserId,key),url="http://localhost:3000/api/google/events";
  try {
    saveUserSetting(testUserId,key,JSON.stringify([]));
    let catalog=await (await calendarCatalogs.google.GET(new Request("http://localhost:3000/api/google/calendars",{headers:{Cookie:sessionCookie}}))).json();assert.deepEqual(catalog.enabled,[]);assert.equal(catalog.explicit,true);
    assert.deepEqual(JSON.parse(userSetting(testUserId,key)),{accountId:"fixture-account",items:[]});
    assert.deepEqual((await (await routes.google.GET(new Request(url,{headers:{Cookie:sessionCookie}}))).json()).items,[]);
    saveUserSetting(testUserId,key,JSON.stringify([{id:"other/calendar",name:"Senas antrinis"}]));
    catalog=await (await calendarCatalogs.google.GET(new Request("http://localhost:3000/api/google/calendars",{headers:{Cookie:sessionCookie}}))).json();assert.deepEqual(catalog.enabled,["other/calendar"]);assert.equal(catalog.explicit,true);
    assert.deepEqual(JSON.parse(userSetting(testUserId,key)),{accountId:"fixture-account",items:[{id:"other/calendar",name:"Senas antrinis"}]});
    const items=(await (await routes.google.GET(new Request(url,{headers:{Cookie:sessionCookie}}))).json()).items;assert.ok(items.length);assert.ok(items.every(item=>item.calendarId==="other/calendar"));
  } finally {
    if(previous===undefined)db.prepare("DELETE FROM user_settings WHERE user_id=? AND key=?").run(testUserId,key);
    else saveUserSetting(testUserId,key,previous);
  }
});

test("Microsoft legacy primary selection creates in the live opaque default calendar",async()=>{
  const key="microsoft_enabled_calendars",previous=userSetting(testUserId,key),url="http://localhost:3000/api/microsoft/events",before=calendarUpstreamWrites.length;
  try {
    saveUserSetting(testUserId,key,JSON.stringify({accountId:"fixture-account",items:[{id:"primary"}]}));
    const catalog=await (await calendarCatalogs.microsoft.GET(new Request("http://localhost:3000/api/microsoft/calendars",{headers:{Cookie:sessionCookie}}))).json();assert.deepEqual(catalog.enabled,["opaque-default"]);assert.equal(catalog.defaultAlias,true);
    const response=await routes.microsoft.POST(new Request(url,{method:"POST",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify({operationId:operationId(),calendarId:"opaque-default",calendarVersion:catalog.version,summary:"Legacy numatytasis",start:"2026-10-24T07:00:00Z",end:"2026-10-24T08:00:00Z",timeZone:"UTC"})}));
    assert.equal(response.status,201);assert.equal(calendarUpstreamWrites.length,before+1);assert.equal(calendarUpstreamWrites.at(-1).path,"/v1.0/me/calendars/opaque-default/events");
  } finally {
    if(previous===undefined)db.prepare("DELETE FROM user_settings WHERE user_id=? AND key=?").run(testUserId,key);
    else saveUserSetting(testUserId,key,previous);
  }
});
for(const provider of ["google","microsoft"])test(`${provider} actual route submits an account-bound RSVP and reloads its status`,async()=>{
  const route=routes[provider],url=`http://localhost:3000/api/${provider}/events`;
  const event=(await (await route.GET(new Request(url,{headers:{Cookie:sessionCookie}}))).json()).items.find(item=>item.canRespond);assert.ok(event);assert.equal(event.editable,false);assert.equal(event.responseStatus,"needsAction");
  const body={id:event.id,calendarId:event.calendarId,connectionId:event.connectionId,version:event.version,responseStatus:"accepted"};
  const put=(value,origin="http://localhost:3000")=>route.PUT(new Request(url,{method:"PUT",headers:{Origin:origin,"Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify(value)}));
  assert.equal((await put(body,"https://attacker.example")).status,403);
  assert.equal((await put({...body,version:"stale"})).status,409);
  const response=await put(body);assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,responseStatus:"accepted"});
  assert.equal((await put(body)).status,200);
  const reloaded=(await (await route.GET(new Request(url,{headers:{Cookie:sessionCookie}}))).json()).items.find(item=>item.key===event.key);assert.equal(reloaded.responseStatus,"accepted");assert.notEqual(reloaded.version,event.version);
  assert.equal((await put({...body,version:reloaded.version,responseStatus:"invalid"})).status,400);
});
test("actual Outlook route protects non-organizer events and requires participant confirmation on time change",async()=>{
  const route=routes.microsoft,url="http://localhost:3000/api/microsoft/events";
  const items=(await (await route.GET(new Request(url,{headers:{Cookie:sessionCookie}}))).json()).items;
  const withAttendees=items.find(e=>e.attendeeCount&&e.editable);
  if(withAttendees){
    // time change with attendees requires confirmAttendees
    const movedInput={...inputFor(withAttendees),start:new Date(Date.parse(withAttendees.start.dateTime)+3600000).toISOString(),end:new Date(Date.parse(withAttendees.end.dateTime)+3600000).toISOString()};
    assert.equal((await routes.microsoft.PATCH(new Request(url,{method:"PATCH",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify(movedInput)}))).status,409);
  }
  const nonEditable=items.find(e=>!e.editable);
  if(nonEditable)assert.equal((await routes.microsoft.PATCH(new Request(url,{method:"PATCH",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify(inputFor(nonEditable))}))).status,403);
});

for(const provider of ["google","microsoft"]) test(`${provider}: same-ID events in different calendars update and delete independently`,async()=>{
  const route=routes[provider],url=`http://localhost:3000/api/${provider}/events`;
  const selected=[{id:"primary"},{id:"other/calendar",name:"Kitas",color:"#123456"}];
  saveUserSetting(testUserId,`${provider}_enabled_calendars`,JSON.stringify({accountId:"fixture-account",items:selected}));
  const items=(await (await route.GET(new Request(url,{headers:{Cookie:sessionCookie}}))).json()).items;
  const target=items.find(e=>e.calendarId==="other/calendar"),original=items.find(e=>e.calendarId==="primary"&&e.id===target.id);
  assert.ok(original);assert.notEqual(target.key,original.key);
  const response=await route.PATCH(new Request(url,{method:"PATCH",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify({...inputFor(target),summary:"Tik antrinis"})}));
  assert.equal(response.status,200);const updated=await response.json();assert.equal(updated.key,target.key);assert.equal(updated.calendarId,"other/calendar");
  const after=(await (await route.GET(new Request(url,{headers:{Cookie:sessionCookie}}))).json()).items;
  assert.deepEqual(after.find(e=>e.key===original.key),original);assert.equal(after.find(e=>e.key===target.key).summary,"Tik antrinis");
  const headers={Origin:"http://localhost:3000",Cookie:sessionCookie};
  assert.equal((await route.DELETE(new Request(url+"?id="+encodeURIComponent(target.id),{method:"DELETE",headers}))).status,400);
  const query=new URLSearchParams({id:updated.id,calendarId:updated.calendarId,connectionId:updated.connectionId,version:updated.version});
  for(const [field,value] of [["version","outdated"],["connectionId","another-account"]]) {
    const stale=new URLSearchParams(query);stale.set(field,value);
    assert.equal((await route.DELETE(new Request(url+"?"+stale,{method:"DELETE",headers}))).status,409);
  }
  assert.equal((await route.DELETE(new Request(url+"?"+query,{method:"DELETE",headers:{Origin:"https://attacker.example",Cookie:sessionCookie}}))).status,403);
  assert.equal((await route.DELETE(new Request(url+"?"+query,{method:"DELETE",headers}))).status,200);
  const remaining=(await (await route.GET(new Request(url,{headers:{Cookie:sessionCookie}}))).json()).items;
  assert.ok(remaining.some(e=>e.key===original.key));assert.ok(!remaining.some(e=>e.key===target.key));
  const primary=[{id:"primary"}];saveUserSetting(testUserId,`${provider}_enabled_calendars`,JSON.stringify({accountId:"fixture-account",items:primary}));
});

for(const provider of ["google","microsoft"])test(`${provider}: explicit empty calendar selection lists no events and remains account-bound`,async()=>{
  const route=routes[provider],catalog=calendarCatalogs[provider],eventsUrl=`http://localhost:3000/api/${provider}/events`,catalogUrl=`http://localhost:3000/api/${provider}/calendars`;
  const catalogResponse=await catalog.GET(new Request(catalogUrl,{headers:{Cookie:sessionCookie}})),snapshot=await catalogResponse.json();assert.equal(catalogResponse.status,200);
  // Simulate account swap by changing provider_account_id in oauth_connections
  multiDb.prepare("UPDATE oauth_connections SET provider_account_id=? WHERE user_id=? AND provider=?").run("different-account",testUserId,provider);
  const stale=await catalog.PATCH(new Request(catalogUrl,{method:"PATCH",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify({enabled:[],version:snapshot.version})}));assert.equal(stale.status,409);
  const staleCreate=await route.POST(new Request(eventsUrl,{method:"POST",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify({operationId:operationId(),calendarId:"primary",calendarVersion:snapshot.version,summary:"Nekurti kitoje paskyroje",start:"2026-10-24T07:00:00Z",end:"2026-10-24T08:00:00Z",timeZone:"UTC"})}));assert.equal(staleCreate.status,409);
  multiDb.prepare("UPDATE oauth_connections SET provider_account_id=? WHERE user_id=? AND provider=?").run("fixture-account",testUserId,provider);
  const response=await catalog.PATCH(new Request(catalogUrl,{method:"PATCH",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify({enabled:[],version:snapshot.version})}));
  assert.equal(response.status,200);assert.deepEqual(JSON.parse(userSetting(testUserId,`${provider}_enabled_calendars`)),{accountId:"fixture-account",items:[]});
  const listed=await route.GET(new Request(eventsUrl,{headers:{Cookie:sessionCookie}}));assert.equal(listed.status,200);assert.deepEqual((await listed.json()).items,[]);
  const before=calendarUpstreamWrites.length,created=await route.POST(new Request(eventsUrl,{method:"POST",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify({operationId:operationId(),calendarId:"primary",calendarVersion:snapshot.version,summary:"Nekurti",start:"2026-10-24T07:00:00Z",end:"2026-10-24T08:00:00Z",timeZone:"UTC"})}));
  assert.equal(created.status,409);assert.equal(calendarUpstreamWrites.length,before);
  saveUserSetting(testUserId,`${provider}_enabled_calendars`,JSON.stringify({accountId:"fixture-account",items:[{id:"primary"}]}));
});

test("Outlook route confirms mirror identity by account and transaction, never by event ID alone",async()=>{
  const source=calendarUpstream.outlook.get("primary").get("outlook-personal");
  const mirror={...structuredClone(source),id:"mirror-shared",showAs:"free",transactionId:"created-by-this-plan",subject:"✓ Darbas",
    bodyPreview:"Dienos planas: pasirenkamas užduoties darbo laikas.",body:{contentType:"text",content:"Dienos planas: pasirenkamas užduoties darbo laikas."},
    isReminderOn:false,isOnlineMeeting:false,onlineMeeting:null,location:{displayName:""},sensitivity:"normal",importance:"normal",hasAttachments:false,categories:[],recurrence:null};
  const defaultCalendar=new Map([[mirror.id,mirror]]),other=calendarUpstream.outlook.get("other/calendar");
  calendarUpstream.outlook.set("opaque-default",defaultCalendar);other.set(mirror.id,structuredClone(mirror));
  const catalogResponse=await microsoftCalendars.GET(new Request("http://localhost:3000/api/microsoft/calendars",{headers:{Cookie:sessionCookie}}));assert.equal(catalogResponse.status,200);const catalog=await catalogResponse.json();
  assert.ok(catalog.items.some(calendar=>calendar.id==="opaque-default"&&calendar.isDefault));
  // microsoft_default_calendar_identity now stored per-user: [accountId, String(conn.id), calendarId]
  assert.deepEqual(JSON.parse(userSetting(testUserId,"microsoft_default_calendar_identity")),["fixture-account",connIds.microsoft,"opaque-default"]);
  const selection=await microsoftCalendars.PATCH(new Request("http://localhost:3000/api/microsoft/calendars",{method:"PATCH",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify({enabled:[{id:"opaque-default"},{id:"other/calendar"}],version:catalog.version})}));
  assert.equal(selection.status,200);assert.equal(JSON.parse(userSetting(testUserId,"microsoft_enabled_calendars")).accountId,"fixture-account");
  db.prepare("DELETE FROM user_settings WHERE user_id=? AND key=?").run(testUserId,"microsoft_default_calendar_identity");
  // task_plans in multi-user schema has user_id NOT NULL — include it in all inserts.
  const insert=db.prepare(`INSERT INTO task_plans(user_id,task_key,scheduled_at,mirror_requested,mirror_account_id,mirror_connection_id,mirror_event_id,mirror_transaction_id) VALUES (?,?,?,1,?,?,?,?)`);
  insert.run(testUserId,"mirror-test",source.start.dateTime+"Z","fixture-account",Number(connIds.microsoft),mirror.id,mirror.transactionId);
  const list=async()=>{
    const response=await routes.microsoft.GET(new Request("http://localhost:3000/api/microsoft/events",{headers:{Cookie:sessionCookie}}));
    assert.equal(response.status,200);return (await response.json()).items.filter(e=>e.id===mirror.id);
  };
  try {
    let events=await list();assert.equal(events.find(e=>e.calendarId==="opaque-default").mirrorTaskKey,"mirror-test");
    assert.equal(events.find(e=>e.calendarId==="other/calendar").mirrorTaskKey,null);
    assert.ok(events.every(e=>!("transactionId" in e)));
    // Simulate account swap: change provider_account_id in oauth_connections
    multiDb.prepare("UPDATE oauth_connections SET provider_account_id=? WHERE user_id=? AND provider=?").run("different-account",testUserId,"microsoft");
    assert.deepEqual(await list(),[]);
    multiDb.prepare("UPDATE oauth_connections SET provider_account_id=? WHERE user_id=? AND provider=?").run("fixture-account",testUserId,"microsoft");
    // Simulate token refresh: increment generation. conn.id is unchanged so
    // connectionId (String(conn.id)) stays the same — mirror identity persists.
    multiDb.prepare("UPDATE oauth_connections SET generation=generation+1 WHERE user_id=? AND provider=?").run(testUserId,"microsoft");
    events=await list();
    assert.equal(events.find(e=>e.calendarId==="opaque-default").mirrorTaskKey,"mirror-test");
    // After catalog GET the stored identity still uses the same conn.id
    assert.deepEqual(JSON.parse(userSetting(testUserId,"microsoft_default_calendar_identity")),["fixture-account",connIds.microsoft,"opaque-default"]);
    // Restore generation
    multiDb.prepare("UPDATE oauth_connections SET generation=generation-1 WHERE user_id=? AND provider=?").run(testUserId,"microsoft");
    for (const change of [{transactionId:undefined},{showAs:"busy"},{isOrganizer:false},{isAllDay:true},{type:"occurrence"},{attendees:[{emailAddress:{address:"guest@example.test"}}]},
      {isReminderOn:true},{location:{displayName:"Kita vieta"}},{bodyPreview:"Pakeistas turinys"},{isOnlineMeeting:true},{onlineMeeting:{joinUrl:"https://teams.example.test"}},
      {sensitivity:"private"},{importance:"high"},{hasAttachments:true},{categories:["Pakeista"]},{recurrence:{pattern:{type:"daily"}}}]) {
      defaultCalendar.set(mirror.id,{...mirror,...change});assert.ok((await list()).every(e=>e.mirrorTaskKey===null),JSON.stringify(change));
    }
    defaultCalendar.set(mirror.id,mirror);
    insert.run(testUserId,"mirror-ambiguous",source.start.dateTime+"Z","fixture-account",Number(connIds.microsoft),mirror.id,mirror.transactionId);
    assert.ok((await list()).every(e=>e.mirrorTaskKey===null));
    db.prepare("DELETE FROM task_plans WHERE task_key=? AND user_id=?").run("mirror-ambiguous",testUserId);
    for (const sql of ["mirror_requested=0","mirror_error='Retry'","scheduled_at=NULL"]) {
      db.prepare(`UPDATE task_plans SET ${sql} WHERE task_key='mirror-test' AND user_id=?`).run(testUserId);
      assert.ok((await list()).every(e=>e.mirrorTaskKey===null));
      db.prepare("UPDATE task_plans SET mirror_requested=1,mirror_error=NULL,scheduled_at=? WHERE task_key='mirror-test' AND user_id=?").run(source.start.dateTime+"Z",testUserId);
    }
    // Mutation responses must clear a formerly confirmed association explicitly.
    const linked=(await list()).find(e=>e.calendarId==="opaque-default");defaultCalendar.set(mirror.id,{...mirror,transactionId:undefined});
    const response=await routes.microsoft.PATCH(new Request("http://localhost:3000/api/microsoft/events",{method:"PATCH",headers:{Origin:"http://localhost:3000","Content-Type":"application/json",Cookie:sessionCookie},body:JSON.stringify(inputFor(linked))}));
    assert.equal(response.status,200);assert.equal((await response.json()).mirrorTaskKey,null);
  } finally {
    calendarUpstream.outlook.delete("opaque-default");other.delete(mirror.id);
    db.prepare("DELETE FROM task_plans WHERE task_key IN ('mirror-test','mirror-ambiguous') AND user_id=?").run(testUserId);
    db.prepare("DELETE FROM user_settings WHERE user_id=? AND key=?").run(testUserId,"microsoft_default_calendar_identity");
    multiDb.prepare("UPDATE oauth_connections SET provider_account_id=? WHERE user_id=? AND provider=?").run("fixture-account",testUserId,"microsoft");
    saveUserSetting(testUserId,"microsoft_enabled_calendars",JSON.stringify({accountId:"fixture-account",items:[{id:"primary"}]}));
  }
});
