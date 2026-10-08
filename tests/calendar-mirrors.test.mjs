import assert from "node:assert/strict";
import {test} from "node:test";
import {visibleCalendarEvents} from "../lib/calendar-mirrors.ts";
import {outlookDefaultCalendarId} from "../lib/outlook-mirror-link.ts";

const task={key:"local:1",title:"Darbas",scheduled_at:"2026-09-23T08:00:00Z",duration_minutes:30,completed:0,mirror_requested:1,mirror_event_id:"shared"};
const event={key:'["outlook","account","calendar-a","shared"]',id:"shared",provider:"outlook",calendarId:"calendar-a",connectionId:"account",mirrorTaskKey:task.key,summary:"✓ Darbas",start:{dateTime:"2026-09-23T08:00:00Z"},end:{dateTime:"2026-09-23T08:30:00Z"},allDay:false,recurring:false,attendeeCount:0};
test("default Outlook calendar identity is bound to the account and connection",()=>{
  const stored=JSON.stringify(["account-a","connection-a","opaque-calendar"]);
  assert.equal(outlookDefaultCalendarId(stored,"account-a","connection-a"),"opaque-calendar");
  assert.equal(outlookDefaultCalendarId(stored,"account-b","connection-a"),undefined);
  assert.equal(outlookDefaultCalendarId(stored,"account-a","connection-b"),undefined);
  assert.equal(outlookDefaultCalendarId("not-json","account-a","connection-a"),undefined);
});
test("only a confirmed mirror with the displayed task's current time is suppressed",()=>{
  const foreign={...event,key:"calendar-b",calendarId:"calendar-b",mirrorTaskKey:null};
  assert.deepEqual(visibleCalendarEvents([event,foreign],[task]),[foreign]);
  assert.deepEqual(visibleCalendarEvents([event],[]),[event]);
  assert.deepEqual(visibleCalendarEvents([event],[{...task,scheduled_at:"2026-09-23T11:00:00Z"}]),[event]);
  assert.deepEqual(visibleCalendarEvents([event],[{...task,duration_minutes:60}]),[event]);
});
test("incomplete, stale and ambiguous mirror evidence never suppresses an event",()=>{
  for(const change of [{completed:1},{stale:true},{mirror_requested:0},{mirror_error:"Retry"},{mirror_event_id:"different"},{key:"other-task"},{scheduled_at:null},{scheduled_at:"invalid"},{title:"Renamed"}]) {
    assert.deepEqual(visibleCalendarEvents([event],[{...task,...change}]),[event],JSON.stringify(change));
  }
  for(const change of [{mirrorTaskKey:null},{provider:"google"},{allDay:true},{recurring:true},{attendeeCount:1},{end:{dateTime:"2026-09-23T09:00:00Z"}}]){
    const changed={...event,...change};assert.deepEqual(visibleCalendarEvents([changed],[task]),[changed]);
  }
  const duplicate={...event,key:"another-calendar",calendarId:"calendar-b"};
  assert.deepEqual(visibleCalendarEvents([event,duplicate],[task]),[event,duplicate]);
});
