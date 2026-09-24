import {test} from "node:test";
import assert from "node:assert/strict";
import {calendarEventKey,createCalendarService,normalizeEvent} from "../lib/calendar-events.ts";
const from="2026-10-25T10:00:00+02:00",to="2026-10-25T11:00:00+02:00";
function fixture(provider) {
  const raw=provider==="google" ? {id:"event/a",summary:"Įvykis",etag:'"v1"',organizer:{self:true},start:{dateTime:"2026-10-24T08:00:00Z",timeZone:"Europe/Vilnius"},end:{dateTime:"2026-10-24T09:00:00Z",timeZone:"Europe/Vilnius"},attendees:[],description:"Keep description",conferenceData:{keep:true},transparency:"opaque",visibility:"default",reminders:{useDefault:true}} : {id:"event/a",subject:"Įvykis","@odata.etag":'W/"v1"',isOrganizer:true,type:"singleInstance",start:{dateTime:"2026-10-24T08:00:00",timeZone:"UTC"},end:{dateTime:"2026-10-24T09:00:00",timeZone:"UTC"},attendees:[],body:{content:"Keep Teams blob",contentType:"html"},isReminderOn:true,reminderMinutesBeforeStart:15,showAs:"busy",sensitivity:"normal"};
  const calls=[],state={connection:"account-a",rejectWrite:false};
  const gateway={connection:()=>state.connection,async request(path,init={}) {
    calls.push({path,...init,body:init.body ? JSON.parse(init.body) : undefined});
    if(init.method==="PATCH") {if(state.rejectWrite)throw Object.assign(new Error("Conflict"),{status:412});Object.assign(raw,JSON.parse(init.body));if(provider==="google")raw.etag='"v2"';else raw["@odata.etag"]='W/"v2"';}
    return structuredClone(raw);
  }};
  const service=createCalendarService(provider,gateway);
  const input={id:raw.id,calendarId:"primary",connectionId:"account-a",version:normalizeEvent(provider,raw,"account-a").version,start:from,end:to};
  return {service,input,calls,raw,state,gateway};
}
for(const provider of ["google","outlook"]) {
  test(`${provider}: moving preserves metadata and uses only time fields with a version precondition`,async()=>{
    const {service,input,calls,raw}=fixture(provider);const before=structuredClone(raw);
    const result=await service.update(input);
    assert.equal(calls.length,2);assert.ok(calls[0].path.endsWith("event%2Fa"));
    assert.deepEqual(Object.keys(calls[1].body).sort(),["end","start"]);
    assert.equal(calls[1].headers["If-Match"],input.version);
    assert.equal(Date.parse(result.start.dateTime),Date.parse(from));
    assert.deepEqual(raw.attendees,before.attendees);assert.deepEqual(raw.body,before.body);assert.deepEqual(raw.conferenceData,before.conferenceData);assert.deepEqual(raw.reminders,before.reminders);assert.equal(raw.showAs,before.showAs);
  });
  test(`${provider}: stale versions and unconfirmed attendee notifications on time change never write`,async()=>{
    const {service,input,calls,raw}=fixture(provider);
    await assert.rejects(service.update({...input,version:"old"}),e=>e.status===409);
    raw.attendees=[{email:"synthetic@example.test"}];
    // time change with attendees requires confirmation
    await assert.rejects(service.update(input),e=>e.status===409);
    assert.ok(calls.every(c=>!c.method));
    await service.update({...input,confirmAttendees:true});assert.equal(calls.filter(c=>c.method==="PATCH").length,1);
  });
  test(`${provider}: attendee-only update skips time-change confirmation; bad email rejected`,async()=>{
    const {service,calls,raw}=fixture(provider);
    // use same start/end as the fixture event to avoid time-change trigger
    const sameStart=provider==="google"?"2026-10-24T08:00:00Z":"2026-10-24T08:00:00Z";
    const sameEnd=provider==="google"?"2026-10-24T09:00:00Z":"2026-10-24T09:00:00Z";
    raw.attendees=[{email:"existing@example.test"}];
    const ver=normalizeEvent(provider,raw,"account-a").version;
    const sameTimeInput={id:raw.id,calendarId:"primary",connectionId:"account-a",version:ver,start:sameStart,end:sameEnd};
    // no confirmAttendees needed when only attendees change
    await service.update({...sameTimeInput,attendees:[{email:"new@example.test"}]});
    assert.equal(calls.filter(c=>c.method==="PATCH").length,1);
    // bad email rejected without write
    const newVer=normalizeEvent(provider,raw,"account-a").version;
    await assert.rejects(service.update({...sameTimeInput,version:newVer,attendees:[{email:"not-an-email"}]}),e=>e.status===400);
    assert.equal(calls.filter(c=>c.method==="PATCH").length,1);
  });
  test(`${provider}: invalid properties and arbitrary fields are rejected before provider access`,async()=>{
    const {service,input,calls}=fixture(provider);
    for(const extra of [{patch:{attendees:[]}},{showAs:"invalid"},{visibility:"secret"},{reminder:{mode:"minutes",minutes:-1}},{reminder:{mode:"minutes",minutes:40321}},{reminder:{mode:"custom"}},{reminder:{mode:"none",minutes:5}},{recurrence:[]},{start:"2026-10-25T10:00"},{end:from},{summary:" "},{attendees:"not-an-array"},{attendees:[{email:"bad"}]}])await assert.rejects(service.update({...input,...extra}),e=>e.status===400);
    if(provider==="outlook")await assert.rejects(service.update({...input,reminder:{mode:"default"}}),e=>e.status===400);
    assert.equal(calls.length,0);
  });
  test(`${provider}: detailed properties map to provider fields and round-trip`,async()=>{
    const {service,raw,calls}=fixture(provider),current=normalizeEvent(provider,raw,"account-a");
    const input={id:raw.id,calendarId:"primary",connectionId:"account-a",version:current.version,start:current.start.dateTime,end:current.end.dateTime,showAs:"free",visibility:"private",reminder:{mode:"minutes",minutes:30}};
    const updated=await service.update(input),write=calls.find(call=>call.method==="PATCH");
    assert.equal(updated.showAs,"free");assert.equal(updated.visibility,"private");assert.deepEqual(updated.reminder,{mode:"minutes",minutes:30});
    if(provider==="google")assert.deepEqual(write.body,{start:{dateTime:new Date(current.start.dateTime).toISOString(),timeZone:"Europe/Vilnius"},end:{dateTime:new Date(current.end.dateTime).toISOString(),timeZone:"Europe/Vilnius"},transparency:"transparent",visibility:"private",reminders:{useDefault:false,overrides:[{method:"popup",minutes:30}]}});
    else assert.deepEqual(write.body,{start:{dateTime:"2026-10-24T08:00:00.000",timeZone:"UTC"},end:{dateTime:"2026-10-24T09:00:00.000",timeZone:"UTC"},showAs:"free",sensitivity:"private",isReminderOn:true,reminderMinutesBeforeStart:30});
  });
  test(`${provider}: account changes, non-owner, all-day, and series master are blocked; instances are editable`,async()=>{
    const {service,input,raw,state,calls}=fixture(provider);
    state.connection="account-b";await assert.rejects(service.update(input),e=>e.status===409);assert.equal(calls.length,0);state.connection="account-a";
    if(provider==="google") raw.organizer.self=false;else raw.isOrganizer=false;
    await assert.rejects(service.update(input),e=>e.status===403);
    // recurring INSTANCE is now editable
    if(provider==="google") {raw.organizer.self=true;raw.recurringEventId="series";}else {raw.isOrganizer=true;raw.type="occurrence";}
    const instanceResult=await service.update(input);assert.ok(instanceResult.recurring);assert.ok(instanceResult.editable);
    // series MASTER is still blocked
    if(provider==="google") {delete raw.recurringEventId;raw.recurrence=["RRULE:FREQ=DAILY"];}else {raw.type="seriesMaster";delete raw.seriesMasterId;}
    await assert.rejects(service.update({...input,version:instanceResult.version}),e=>e.status===403);
    // all-day events are still blocked
    if(provider==="google") {delete raw.recurrence;raw.start={date:"2026-10-25"};raw.end={date:"2026-10-26"};}else {raw.type="singleInstance";raw.isAllDay=true;}
    await assert.rejects(service.update({...input,version:instanceResult.version}),e=>e.status===403);
  });
  test(`${provider}: serial edits cannot apply an older version after the first accepted move`,async()=>{
    const {service,input,calls}=fixture(provider);
    const results=await Promise.allSettled([service.update(input),service.update(input)]);
    assert.equal(results[0].status,"fulfilled");assert.equal(results[1].status,"rejected");assert.equal(results[1].reason.status,409);assert.equal(calls.filter(c=>c.method==="PATCH").length,1);
  });
}
test("Google custom reminders are exposed as read-only and preserved by unrelated edits",async()=>{
  const {service,raw,calls}=fixture("google");raw.reminders={useDefault:false,overrides:[{method:"email",minutes:60},{method:"popup",minutes:10}]};
  const current=normalizeEvent("google",raw,"account-a");assert.deepEqual(current.reminder,{mode:"custom"});
  await service.update({id:raw.id,calendarId:"primary",connectionId:"account-a",version:current.version,start:current.start.dateTime,end:current.end.dateTime,summary:"Naujas pavadinimas"});
  assert.equal(calls.at(-1).body.reminders,undefined);assert.deepEqual(raw.reminders,{useDefault:false,overrides:[{method:"email",minutes:60},{method:"popup",minutes:10}]});
});
for(const provider of ["google","outlook"])test(`${provider}: recurring instance visibility changes are blocked before writing`,async()=>{
  const {service,raw,calls}=fixture(provider);if(provider==="google")raw.recurringEventId="series";else raw.type="occurrence";
  const current=normalizeEvent(provider,raw,"account-a");
  await assert.rejects(service.update({id:raw.id,calendarId:"primary",connectionId:"account-a",version:current.version,start:current.start.dateTime,end:current.end.dateTime,visibility:"private"}),error=>error.status===409);
  assert.equal(calls.filter(call=>call.method).length,0);
});
function rsvpFixture(provider) {
  const raw=provider==="google"
    ? {id:"invite",summary:"Kvietimas",etag:'"r1"',organizer:{self:false},start:{dateTime:"2026-10-24T08:00:00Z"},end:{dateTime:"2026-10-24T09:00:00Z"},attendees:[{email:"me@example.test",self:true,responseStatus:"needsAction"},{email:"host@example.test",organizer:true,responseStatus:"accepted"}]}
    : {id:"invite",subject:"Kvietimas","@odata.etag":'W/"r1"',isOrganizer:false,type:"singleInstance",start:{dateTime:"2026-10-24T08:00:00",timeZone:"UTC"},end:{dateTime:"2026-10-24T09:00:00",timeZone:"UTC"},responseStatus:{response:"notResponded"},attendees:[{emailAddress:{address:"host@example.test"},status:{response:"accepted"}}]};
  const calls=[],state={connection:"account-a"};
  const gateway={connection:()=>state.connection,async request(path,init={}){
    calls.push({path,...init,body:init.body?JSON.parse(init.body):undefined});
    if(provider==="google"&&init.method==="PATCH"){
      if(new Headers(init.headers).get("If-Match")!==raw.etag)throw Object.assign(new Error("Conflict"),{status:412});
      const response=JSON.parse(init.body).attendees[0];raw.attendees.find(attendee=>attendee.self).responseStatus=response.responseStatus;raw.etag='"r2"';
    }
    if(provider==="outlook"&&init.method==="POST"){
      const action=path.split("/").at(-1);raw.responseStatus.response=action==="accept"?"accepted":action==="tentativelyAccept"?"tentativelyAccepted":"declined";raw["@odata.etag"]='W/"r2"';return null;
    }
    return structuredClone(raw);
  }};
  const service=createCalendarService(provider,gateway),event=normalizeEvent(provider,raw,"account-a");
  return {service,raw,calls,state,input:{id:raw.id,calendarId:"primary",connectionId:"account-a",version:event.version},event};
}
for(const provider of ["google","outlook"]) {
  test(`${provider}: attendee RSVP is versioned, provider-specific and retry-safe`,async()=>{
    const {service,raw,calls,input,event}=rsvpFixture(provider);assert.equal(event.editable,false);assert.equal(event.canRespond,true);assert.equal(event.responseStatus,"needsAction");
    const result=await service.respond({...input,responseStatus:"tentative"});assert.deepEqual(result,{ok:true,responseStatus:"tentative"});
    const write=calls.find(call=>call.method);assert.ok(write);
    if(provider==="google"){
      assert.match(write.path,/\?sendUpdates=all$/);assert.equal(write.headers["If-Match"],input.version);
      assert.deepEqual(write.body,{attendeesOmitted:true,attendees:[{email:"me@example.test",responseStatus:"tentative"}]});
    }else{
      assert.match(write.path,/\/tentativelyAccept$/);assert.deepEqual(write.body,{sendResponse:true});
    }
    const current=normalizeEvent(provider,raw,"account-a");assert.equal(current.responseStatus,"tentative");
    await service.respond({...input,responseStatus:"tentative"});assert.equal(calls.filter(call=>call.method).length,1);
  });
  test(`${provider}: RSVP rejects stale, invalid, organizer and changed-account requests before writing`,async()=>{
    const {service,raw,calls,input,state}=rsvpFixture(provider);
    await assert.rejects(service.respond({...input,version:"stale",responseStatus:"accepted"}),error=>error.status===409);
    await assert.rejects(service.respond({...input,responseStatus:"maybe"}),error=>error.status===400);
    if(provider==="google")raw.organizer.self=true;else raw.isOrganizer=true;
    await assert.rejects(service.respond({...input,responseStatus:"declined"}),error=>error.status===403);
    state.connection="account-b";await assert.rejects(service.respond({...input,responseStatus:"accepted"}),error=>error.status===409);
    assert.equal(calls.filter(call=>call.method).length,0);
  });
}
test("event list follows Google tokens and validates Graph nextLink before requesting",async()=>{
  const {raw}=fixture("google");let calls=0;
  const google=createCalendarService("google",{connection:()=>"a",request:async(path)=>{calls++;if(calls===1)return {items:[raw],nextPageToken:"safe & token"};assert.ok(path.includes("pageToken=safe+%26+token"));return {items:[{...raw,id:"second"}]};}});
  assert.equal((await google.list(from,to)).length,2);
  calls=0;
  const outlook=createCalendarService("outlook",{connection:()=>"a",request:async()=>{calls++;return {value:[],"@odata.nextLink":"https://evil.example/v1.0/me/calendarView"};}});
  await assert.rejects(outlook.list(from,to));assert.equal(calls,1);
});

test("calendar identity includes provider, connection, calendar and event without delimiter collisions",()=>{
  const references=[["google","a","b-c","d"],["google","a-b","c","d"],["google","a","b","c-d"],["google","a","b","d"],["outlook","a","b","d"]];
  assert.equal(new Set(references.map(ref=>calendarEventKey(...ref))).size,references.length);
});
for(const provider of ["google","outlook"]) {
  test(`${provider}: missing or invalid calendar identity never reaches the provider`,async()=>{
    const {service,input,calls}=fixture(provider);
    for(const calendarId of [undefined,null,"",[],".","..","a\n", "x".repeat(2049)])await assert.rejects(service.update({...input,calendarId}),error=>error.status===400);
    assert.equal(calls.length,0);
  });
  test(`${provider}: unexpected provider identity is rejected before writing and after an unconfirmed write`,async()=>{
    const {service,input,raw,calls,gateway}=fixture(provider);
    raw.id="foreign";await assert.rejects(service.update(input),error=>error.status===502);assert.equal(calls.length,1);
    raw.id=input.id;const original=gateway.request;gateway.request=async(path,init)=>{const result=await original(path,init);return init?.method==="PATCH"?{...result,id:"foreign"}:result;};
    await assert.rejects(service.update(input),error=>error.status===502);
  });
}
