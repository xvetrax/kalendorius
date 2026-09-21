import {test} from "node:test";
import assert from "node:assert/strict";
import {createCalendarService,normalizeEvent} from "../lib/calendar-events.ts";
const from="2026-10-25T10:00:00+02:00",to="2026-10-25T11:00:00+02:00";
function fixture(provider) {
  const raw=provider==="google" ? {id:"event/a",summary:"Įvykis",etag:'"v1"',organizer:{self:true},start:{dateTime:"2026-10-24T08:00:00Z",timeZone:"Europe/Vilnius"},end:{dateTime:"2026-10-24T09:00:00Z",timeZone:"Europe/Vilnius"},attendees:[],description:"Keep description",conferenceData:{keep:true},reminders:{useDefault:true}} : {id:"event/a",subject:"Įvykis","@odata.etag":'W/"v1"',isOrganizer:true,type:"singleInstance",start:{dateTime:"2026-10-24T08:00:00",timeZone:"UTC"},end:{dateTime:"2026-10-24T09:00:00",timeZone:"UTC"},attendees:[],body:{content:"Keep Teams blob",contentType:"html"},isReminderOn:true,showAs:"busy"};
  const calls=[],state={connection:"account-a",rejectWrite:false};
  const gateway={connection:()=>state.connection,async request(path,init={}) {
    calls.push({path,...init,body:init.body ? JSON.parse(init.body) : undefined});
    if(init.method==="PATCH") {if(state.rejectWrite)throw Object.assign(new Error("Conflict"),{status:412});Object.assign(raw,JSON.parse(init.body));if(provider==="google")raw.etag='"v2"';else raw["@odata.etag"]='W/"v2"';}
    return structuredClone(raw);
  }};
  const service=createCalendarService(provider,gateway);
  const input={id:raw.id,connectionId:"account-a",version:normalizeEvent(provider,raw,"account-a").version,start:from,end:to};
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
  test(`${provider}: stale versions and unconfirmed attendee notifications never write`,async()=>{
    const {service,input,calls,raw}=fixture(provider);
    await assert.rejects(service.update({...input,version:"old"}),e=>e.status===409);
    raw.attendees=[{email:"synthetic@example.test"}];
    await assert.rejects(service.update(input),e=>e.status===409);
    assert.ok(calls.every(c=>!c.method));
    await service.update({...input,confirmAttendees:true});assert.equal(calls.filter(c=>c.method==="PATCH").length,1);
  });
  test(`${provider}: client payload cannot overwrite attendees, series, busy status or arbitrary fields`,async()=>{
    const {service,input,calls}=fixture(provider);
    for(const extra of [{patch:{attendees:[]}},{showAs:"free"},{recurrence:[]},{attendees:[]},{start:"2026-10-25T10:00"},{end:from},{summary:" "}])await assert.rejects(service.update({...input,...extra}),e=>e.status===400);
    assert.equal(calls.length,0);
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
test("event list follows Google tokens and validates Graph nextLink before requesting",async()=>{
  const {raw}=fixture("google");let calls=0;
  const google=createCalendarService("google",{connection:()=>"a",request:async(path)=>{calls++;if(calls===1)return {items:[raw],nextPageToken:"safe & token"};assert.ok(path.includes("pageToken=safe+%26+token"));return {items:[{...raw,id:"second"}]};}});
  assert.equal((await google.list(from,to)).length,2);
  calls=0;
  const outlook=createCalendarService("outlook",{connection:()=>"a",request:async()=>{calls++;return {value:[],"@odata.nextLink":"https://evil.example/v1.0/me/calendarView"};}});
  await assert.rejects(outlook.list(from,to));assert.equal(calls,1);
});
