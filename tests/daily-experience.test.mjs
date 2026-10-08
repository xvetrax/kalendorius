import assert from "node:assert/strict";
import {test} from "node:test";
import {buildDailySummary,parseQuickTaskInput} from "../lib/daily-experience.ts";

function task(overrides={}) {
  return {id:1,key:"local:1",source:"local",title:"Užduotis",notes:"",due_at:null,scheduled_at:null,duration_minutes:30,completed:0,project:"Asmeniniai",priority:"normal",tags:"",energy:"medium",schedule_version:0,legacy_schedule:0,mirror_requested:0,mirror_event_id:null,mirror_account_id:null,mirror_connection_id:null,mirror_error:null,...overrides};
}
function event(id,start,end,overrides={}) {
  return {id,key:id,provider:"google",connectionId:"google-a",calendarId:"primary",summary:id,start:{dateTime:start},end:{dateTime:end},allDay:false,editable:true,readOnlyReason:"",attendeeCount:0,recurring:false,canRespond:false,showAs:"busy",visibility:"default",reminder:{mode:"default"},...overrides};
}

test("greitas įvedimas atpažįsta lietuvišką datą, laiką ir trukmę, o kitą tekstą palieka pavadinime",()=>{
  const now=new Date(2026,9,7,10,0);
  const parsed=parseQuickTaskInput("Paruošti ataskaitą rytoj 14:30 45 min",now);
  assert.equal(parsed.title,"Paruošti ataskaitą");
  assert.equal(parsed.durationMinutes,45);
  assert.equal(parsed.date,"2026-10-08");
  assert.equal(parsed.time,"14:30");
  assert.equal(parsed.dueDate,null);
  const instant=new Date(parsed.scheduledAt);
  assert.deepEqual([instant.getFullYear(),instant.getMonth()+1,instant.getDate(),instant.getHours(),instant.getMinutes()],[2026,10,8,14,30]);
  assert.equal(parsed.valid,true);
});

test("savaitės diena be laiko tampa dienos terminu, o nežinoma žyma nekeičia paskyros",()=>{
  const parsed=parseQuickTaskInput("#Svarbu Skambinti pirmadienį 1 val",new Date(2026,9,7,10,0));
  assert.equal(parsed.title,"#Svarbu Skambinti");
  assert.equal(parsed.durationMinutes,60);
  assert.equal(parsed.dueDate,"2026-10-12");
  assert.equal(parsed.scheduledAt,null);
});

test("netinkama trukmė pažymima negaliojančia ir tuščias pavadinimas neišsaugomas",()=>{
  assert.equal(parseQuickTaskInput("Darbas 2 min").valid,false);
  assert.equal(parseQuickTaskInput("rytoj 30 min").valid,false);
});

test("dienos talpa sujungia persidengimus, neįskaičiuoja free ir visos dienos įvykių",()=>{
  const now=new Date(2026,9,7,8,0);
  const events=[
    event("A",new Date(2026,9,7,10,0).toISOString(),new Date(2026,9,7,12,0).toISOString()),
    event("B",new Date(2026,9,7,11,0).toISOString(),new Date(2026,9,7,13,0).toISOString(),{provider:"outlook",connectionId:"ms-b"}),
    event("Laisvas",new Date(2026,9,7,14,0).toISOString(),new Date(2026,9,7,15,0).toISOString(),{showAs:"free"}),
    {id:"all",key:"all",provider:"google",connectionId:"google-a",calendarId:"primary",summary:"Informacija",start:{date:"2026-10-07"},end:{date:"2026-10-08"},allDay:true,editable:true,readOnlyReason:"",attendeeCount:0,recurring:false,canRespond:false,showAs:"busy",visibility:"default",reminder:{mode:"default"}},
  ];
  const tasks=[task({scheduled_at:new Date(2026,9,7,12,30).toISOString(),duration_minutes:60})];
  const summary=buildDailySummary(tasks,events,now);
  assert.equal(summary.calendarBusyMinutes,180);
  assert.equal(summary.plannedTaskMinutes,60);
  assert.equal(summary.remainingMinutes,270);
  assert.equal(summary.allDayEvents.length,1);
  assert.deepEqual(summary.freeGaps.map(gap=>[gap.start.getHours(),gap.start.getMinutes(),gap.end.getHours(),gap.end.getMinutes()]),[[9,0,10,0],[13,30,17,0]]);
});

test("Mano diena apima suplanuotas, šiandienos termino ir vėluojančias užduotis",()=>{
  const now=new Date(2026,9,7,11,0);
  const tasks=[
    task({key:"scheduled",scheduled_at:new Date(2026,9,7,15,0).toISOString()}),
    task({key:"due-google",source:"google",due_date:"2026-10-07",account_id:"g",list_id:"l"}),
    task({key:"overdue",due_at:new Date(2026,9,6,18,0).toISOString()}),
    task({key:"done",due_at:new Date(2026,9,7,18,0).toISOString(),completed:1}),
  ];
  const summary=buildDailySummary(tasks,[],now);
  assert.deepEqual(summary.tasks.map(item=>item.key).sort(),["due-google","scheduled"]);
  assert.deepEqual(summary.overdueTasks.map(item=>item.key),["overdue"]);
});

test("per vidurnaktį trunkanti užduotis užima tik persidengiančią darbo dienos dalį",()=>{
  const now=new Date(2026,9,7,8,0);
  const overnight=task({key:"overnight",scheduled_at:new Date(2026,9,6,23,0).toISOString(),duration_minutes:720});
  const summary=buildDailySummary([overnight],[],now);
  assert.deepEqual(summary.tasks.map(item=>item.key),["overnight"]);
  assert.equal(summary.plannedTaskMinutes,120);
  assert.equal(summary.remainingMinutes,360);
  assert.deepEqual(summary.freeGaps.map(gap=>[gap.start.getHours(),gap.end.getHours()]),[[11,17]]);
});
