import assert from "node:assert/strict";
import test from "node:test";
import {buildOfflineDaySnapshot,OFFLINE_PLAN_TTL_MS} from "../lib/offline-day-plan.ts";

const day="2026-10-07",now=Date.parse("2026-10-07T08:00:00Z");
const task={id:1,key:"local:1",source:"local",title:"Paruošti planą",notes:"privati pastaba",due_at:null,due_date:null,scheduled_at:"2026-10-07T09:00:00Z",duration_minutes:45,completed:0,project:"Darbas",priority:"normal",tags:"",energy:"",schedule_version:1,legacy_schedule:0,mirror_requested:0,mirror_event_id:null,mirror_account_id:null,mirror_connection_id:null,mirror_error:null};
const event={id:"event-1",key:"event-1",provider:"google",connectionId:"google-1",version:'"v1"',calendarId:"primary",calendarName:"Darbas",accountLabel:"darbas@example.test",summary:"Komandos susitikimas",description:"slaptas aprašymas",location:"slapta vieta",start:{dateTime:"2026-10-07T10:00:00Z"},end:{dateTime:"2026-10-07T11:00:00Z"},editable:true,readOnlyReason:"",attendeeCount:1,attendees:[{email:"kolega@example.test",responseStatus:"accepted"}],recurring:false,allDay:false,canRespond:false,showAs:"busy",visibility:"default",reminder:{mode:"default"},timeZone:"UTC",htmlLink:"https://calendar.google.com/secret"};

test("offline kopija išrenka tik vienos dienos planą ir galioja 48 valandas",()=>{
  const other={...task,id:2,key:"local:2",title:"Kita diena",scheduled_at:"2026-10-08T09:00:00Z"};
  const snapshot=buildOfflineDaySnapshot({userId:7,day,tasks:[task,other],events:[event],now});
  assert.equal(snapshot.userKey,"user:7");
  assert.equal(snapshot.day,day);
  assert.equal(snapshot.expiresAt-snapshot.capturedAt,OFFLINE_PLAN_TTL_MS);
  assert.deepEqual(snapshot.items.map(item=>item.title),["Paruošti planą","Komandos susitikimas"]);
});

test("offline kopijoje nėra aprašymų, dalyvių, nuorodų ar tiekėjo ID",()=>{
  const snapshot=buildOfflineDaySnapshot({userId:7,day,tasks:[task],events:[event],now});
  const serialized=JSON.stringify(snapshot);
  for(const privateValue of ["privati pastaba","slaptas aprašymas","slapta vieta","kolega@example.test","calendar.google.com/secret","google-1","event-1"]){
    assert.ok(!serialized.includes(privateValue),`neturi būti išsaugota: ${privateValue}`);
  }
});

test("visos dienos ir per vidurnaktį trunkantys įrašai patenka į abi paliestas dienas",()=>{
  const overnight={...event,id:"overnight",key:"overnight",summary:"Naktinis darbas",start:{dateTime:"2026-10-07T22:00:00+03:00"},end:{dateTime:"2026-10-08T02:00:00+03:00"}};
  const allDay={...event,id:"all-day",key:"all-day",summary:"Išvyka",allDay:true,start:{date:"2026-10-07"},end:{date:"2026-10-09"}};
  for(const selected of ["2026-10-07","2026-10-08"]){
    const snapshot=buildOfflineDaySnapshot({userId:7,day:selected,tasks:[],events:[overnight,allDay],now});
    assert.deepEqual(new Set(snapshot.items.map(item=>item.title)),new Set(["Naktinis darbas","Išvyka"]));
  }
});

test("atliktos ir kitai dienai skirtos užduotys į offline planą nepatenka",()=>{
  const completed={...task,completed:1},due={...task,id:3,key:"local:3",scheduled_at:null,due_date:"2026-10-08",title:"Rytojaus terminas"};
  assert.deepEqual(buildOfflineDaySnapshot({userId:7,day,tasks:[completed,due],events:[],now}).items,[]);
});
