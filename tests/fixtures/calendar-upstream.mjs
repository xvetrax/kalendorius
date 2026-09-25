// Explicit Node preload, used only by tests/calendar-smoke.mjs. There is no
// production route or application flag that can enable this fixture.
import {zonedInstant} from "../../lib/calendar-time-zone.ts";
if(process.env.CALENDAR_TEST_FIXTURE!=="isolated")throw new Error("Test-only preload");
const monday=new Date();monday.setDate(monday.getDate()-((monday.getDay()+6)%7));monday.setHours(0,0,0,0);
const date=(day,hour)=>{const d=new Date(monday);d.setDate(d.getDate()+day);d.setHours(hour);return d.toISOString();};
const google=new Map([["google-personal",{id:"google-personal",summary:"Google bandymas",etag:'"g1"',organizer:{self:true},start:{dateTime:date(0,9),timeZone:"Europe/Vilnius"},end:{dateTime:date(0,10),timeZone:"Europe/Vilnius"},attendees:[],description:"Nepakeisti aprašymo",hangoutLink:"https://meet.google.com/test",htmlLink:"https://calendar.google.com/",transparency:"opaque",visibility:"default",reminders:{useDefault:true}}]]);
const msEvent=(id,subject,day,hour,attendees=[])=>({id,subject,"@odata.etag":'W/"m1"',isOrganizer:true,type:"singleInstance",start:{dateTime:date(day,hour).replace(/Z$/,""),timeZone:"UTC"},end:{dateTime:date(day,hour+1).replace(/Z$/,""),timeZone:"UTC"},originalStartTimeZone:"Europe/Vilnius",originalEndTimeZone:"Europe/Vilnius",attendees,body:{contentType:"html",content:"<p>Išsaugoti Teams aprašymą</p>"},showAs:"busy",sensitivity:"normal",isReminderOn:true,reminderMinutesBeforeStart:15,webLink:"https://outlook.office.com/calendar/"});
const outlook=new Map([["outlook-personal",msEvent("outlook-personal","Outlook bandymas",1,10)],["outlook-meeting",msEvent("outlook-meeting","Susitikimo bandymas",2,14,[{emailAddress:{address:"synthetic@example.test"}}])],["outlook-readonly",{...msEvent("outlook-readonly","Svetimas kvietimas",3,11),isOrganizer:false}]]);
const dayKey=(day)=>{const d=new Date(monday);d.setDate(d.getDate()+day);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;};
google.set("google-all-day",{...structuredClone(google.get("google-personal")),id:"google-all-day",summary:"Visos dienos bandymas",start:{date:dayKey(0)},end:{date:dayKey(2)}});
outlook.set("outlook-all-day",{...msEvent("outlook-all-day","Outlook visos dienos bandymas",4,0),isAllDay:true,start:{dateTime:`${dayKey(4)}T00:00:00`,timeZone:"UTC"},end:{dateTime:`${dayKey(5)}T00:00:00`,timeZone:"UTC"}});
google.set("google-recurring",{...structuredClone(google.get("google-personal")),id:"google-recurring",summary:"Pasikartojimo bandymas",recurringEventId:"test-series",start:{dateTime:date(0,13)},end:{dateTime:date(0,14)}});
google.set("test-series",{...structuredClone(google.get("google-personal")),id:"test-series",summary:"Pasikartojimo serija",recurrence:["RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;COUNT=10"],start:{dateTime:date(0,13),timeZone:"Europe/Vilnius"},end:{dateTime:date(0,14),timeZone:"Europe/Vilnius"}});
google.set("google-overlap",{...structuredClone(google.get("google-personal")),id:"google-overlap",summary:"Persidengiantis įvykis",start:{dateTime:date(1,9)},end:{dateTime:date(1,11)}});
google.set("google-night",{...structuredClone(google.get("google-personal")),id:"google-night",summary:"Naktinis įvykis",start:{dateTime:date(1,23)},end:{dateTime:date(2,1)}});
let version=1;
const outlookSeries=msEvent("outlook-series","Outlook pasikartojimo serija",1,12);Object.assign(outlookSeries,{type:"seriesMaster",recurrence:{pattern:{type:"weekly",interval:1,month:0,dayOfMonth:0,daysOfWeek:["tuesday"],firstDayOfWeek:"sunday",index:"first"},range:{type:"numbered",startDate:dayKey(1),endDate:"0001-01-01",numberOfOccurrences:10,recurrenceTimeZone:"UTC"}}});outlook.set(outlookSeries.id,outlookSeries);
outlook.set("outlook-recurring",{...msEvent("outlook-recurring","Outlook pasikartojimo bandymas",1,12),type:"occurrence",seriesMasterId:"outlook-series"});
google.set("google-short",{...structuredClone(google.get("google-personal")),id:"google-short",summary:"Trumpas",start:{dateTime:new Date(Date.parse(date(1,23))+45*60000).toISOString()},end:{dateTime:date(2,0)}});
google.set("google-invite",{...structuredClone(google.get("google-personal")),id:"google-invite",summary:"Google kvietimas",organizer:{self:false},attendees:[{email:"me@example.test",self:true,responseStatus:"needsAction"},{email:"host@example.test",organizer:true,responseStatus:"accepted"}],start:{dateTime:date(3,15)},end:{dateTime:date(3,16)}});
outlook.set("outlook-readonly",{...outlook.get("outlook-readonly"),responseStatus:{response:"notResponded"},attendees:[{emailAddress:{address:"host@example.test"},status:{response:"accepted"}}]});
export const calendarUpstream={google:new Map([["primary",google],["other/calendar",new Map([["google-personal",{...structuredClone(google.get("google-personal")),summary:"Kitas Google"}]])]]),outlook:new Map([["primary",outlook],["opaque-default",outlook],["other/calendar",new Map([["outlook-personal",{...structuredClone(outlook.get("outlook-personal")),subject:"Kitas Outlook"}]])]])};
export const calendarUpstreamWrites=[];
const ambiguousCreates=new Set(),outlookTransactions=new Map();
globalThis.fetch=async(input,init={})=>{
  const url=new URL(String(input)),method=init.method || "GET";
  if(url.hostname==="oauth2.googleapis.com" || url.hostname==="login.microsoftonline.com")return Response.json({access_token:"synthetic-access"});
  if(url.hostname!=="www.googleapis.com" && url.hostname!=="graph.microsoft.com")throw new Error("Fixture blocks external network");
  if(url.pathname==="/v1.0/me/todo/lists")return Response.json({value:[{id:"fixture-list",wellknownListName:"defaultList"}]});
  if(url.pathname==="/v1.0/me/todo/lists/fixture-list/tasks")return Response.json({value:[]});
  if(url.pathname==="/v1.0/me/calendars")return Response.json({value:[
    {id:"opaque-default",name:"Pagrindinis",color:"auto",isDefaultCalendar:true,canEdit:true},
    {id:"other/calendar",name:"Kitas",color:"lightBlue",isDefaultCalendar:false,canEdit:true},
    {id:"readonly",name:"Tik skaityti",color:"lightGray",isDefaultCalendar:false,canEdit:false},
  ]});
  if(url.pathname==="/calendar/v3/users/me/calendarList")return Response.json({items:[
    {id:"primary",summary:"Pagrindinis",backgroundColor:"#4285f4",primary:true,accessRole:"owner"},
    {id:"other/calendar",summary:"Kitas",backgroundColor:"#34a853",accessRole:"writer"},
    {id:"readonly",summary:"Tik skaityti",backgroundColor:"#9aa0a6",accessRole:"reader"},
  ]});
  const googleCalendar=url.pathname.match(/^\/calendar\/v3\/users\/me\/calendarList\/(.+)$/);
  if(googleCalendar){const id=decodeURIComponent(googleCalendar[1]);return ["primary","other/calendar","readonly"].includes(id)?Response.json({id,primary:id==="primary",accessRole:id==="readonly"?"reader":id==="primary"?"owner":"writer"}):Response.json({error:"Missing calendar"},{status:404});}
  const outlookCalendar=url.pathname.match(/^\/v1\.0\/me\/calendars\/([^/]+)$/);
  if(outlookCalendar){const id=decodeURIComponent(outlookCalendar[1]);return ["primary","opaque-default","other/calendar","readonly"].includes(id)?Response.json({id,canEdit:id!=="readonly",isDefaultCalendar:id==="primary"||id==="opaque-default"}):Response.json({error:"Missing calendar"},{status:404});}
  if(url.pathname.startsWith("/v1.0/me/outlook/supportedTimeZones"))return Response.json({value:[{alias:"Europe/Vilnius",displayName:"Europe/Vilnius"},{alias:"Europe/London",displayName:"Europe/London"},{alias:"Europe/Kiev",displayName:"Europe/Kiev"}]});
  if(url.pathname==="/v1.0/me/calendar")return Response.json({id:"opaque-default"});
  const isGoogle=url.hostname==="www.googleapis.com";
  const match=isGoogle ? url.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/(.+))?$/)
    : url.pathname.match(/^\/v1\.0\/me\/calendars\/([^/]+)\/(?:calendarView|events)(?:\/(.+))?$/);
  const defaultOutlook=!isGoogle && (url.pathname==="/v1.0/me/events" || url.pathname==="/v1.0/me/calendarView" || url.pathname.startsWith("/v1.0/me/calendar/events/"));
  if(!match && !defaultOutlook)return Response.json({error:"Fixture endpoint missing"},{status:404});
  const calendarId=match?decodeURIComponent(match[1]):"primary",map=calendarUpstream[isGoogle?"google":"outlook"].get(calendarId);
  if(!map)return Response.json({error:"Missing calendar"},{status:404});
  const encodedId=match?match[2]:url.pathname.startsWith("/v1.0/me/calendar/events/")?url.pathname.slice("/v1.0/me/calendar/events/".length):undefined;
  if(!encodedId && method==="GET")return Response.json({[isGoogle?"items":"value"]:[...map.values()].filter(event=>isGoogle?!event.recurrence||event.recurringEventId:event.type!=="seriesMaster")});
  if(!encodedId&&method==="POST"){
    const body=JSON.parse(init.body),transactionKey=`${calendarId}:${body.transactionId||""}`;calendarUpstreamWrites.push({provider:isGoogle?"google":"outlook",path:url.pathname,body:structuredClone(body)});
    if(isGoogle&&map.has(body.id))return Response.json({error:{errors:[{reason:"duplicate"}]}},{status:409});
    if(!isGoogle&&body.transactionId&&outlookTransactions.has(transactionKey))return Response.json(map.get(outlookTransactions.get(transactionKey)),{status:201});
    const id=isGoogle?body.id:`created-outlook-${++version}`;if(isGoogle)version++;
    const created=isGoogle?{etag:`"v${version}"`,organizer:{self:true},...body}:{id,"@odata.etag":`W/"v${version}"`,isOrganizer:true,type:body.recurrence?"seriesMaster":"singleInstance",...body,...(!body.isAllDay?{start:{dateTime:zonedInstant(body.start.dateTime.slice(0,16),body.start.timeZone).replace(/Z$/,""),timeZone:"UTC"},end:{dateTime:zonedInstant(body.end.dateTime.slice(0,16),body.end.timeZone).replace(/Z$/,""),timeZone:"UTC"},originalStartTimeZone:body.start.timeZone,originalEndTimeZone:body.end.timeZone}:{})};
    map.set(id,created);if(!isGoogle&&body.transactionId)outlookTransactions.set(transactionKey,id);
    const ambiguousKey=`${isGoogle?"google":"outlook"}:${id}`;if((body.summary==="SIMULATE_AMBIGUOUS_CREATE"||body.subject==="SIMULATE_AMBIGUOUS_CREATE")&&!ambiguousCreates.has(ambiguousKey)){ambiguousCreates.add(ambiguousKey);throw new Error("Simulated lost create response");}
    return Response.json(created,{status:201});
  }
  const actionMatch=!isGoogle&&encodedId?.match(/^(.+)\/(accept|tentativelyAccept|decline)$/),id=decodeURIComponent(actionMatch?.[1]||encodedId||""),event=map.get(id);
  if(!event)return Response.json({error:"Not found"},{status:404});
  if(actionMatch&&method==="POST"){
    const action=actionMatch[2];event.responseStatus={response:action==="accept"?"accepted":action==="tentativelyAccept"?"tentativelyAccepted":"declined"};version++;event["@odata.etag"]=`"v${version}"`;return new Response(null,{status:202});
  }
  if(method==="DELETE") {if(new Headers(init.headers).get("If-Match")!==(isGoogle?event.etag:event["@odata.etag"]))return Response.json({error:"Version changed"},{status:412});map.delete(id);return new Response(null,{status:204});}
  if(method==="PATCH") {
    const match=new Headers(init.headers).get("If-Match"),etag=isGoogle?event.etag:event["@odata.etag"];
    if(match!==etag)return Response.json({error:"Version changed"},{status:412});
    const body=JSON.parse(init.body);
    if(body.summary==="SIMULATE_CONFLICT" || body.subject==="SIMULATE_CONFLICT")return Response.json({error:"simulated"},{status:412});
    if(isGoogle&&body.attendeesOmitted===true){
      const response=body.attendees?.[0],self=event.attendees?.find(attendee=>attendee.self);if(!response||!self||response.email!==self.email)throw new Error("Fixture caught unsafe RSVP update");self.responseStatus=response.responseStatus;
    }else{
      const supported=isGoogle?["start","end","summary","subject","transparency","visibility","reminders","recurrence"]:["start","end","summary","subject","showAs","sensitivity","isReminderOn","reminderMinutesBeforeStart","isAllDay","recurrence"];
      if(Object.keys(body).some(k=>!supported.includes(k)))throw new Error("Fixture caught destructive metadata update");
      if(!isGoogle&&body.isAllDay!==true&&body.start?.timeZone)Object.assign(event,body,{start:{dateTime:zonedInstant(body.start.dateTime.slice(0,16),body.start.timeZone).replace(/Z$/,""),timeZone:"UTC"},end:{dateTime:zonedInstant(body.end.dateTime.slice(0,16),body.end.timeZone).replace(/Z$/,""),timeZone:"UTC"},originalStartTimeZone:body.start.timeZone,originalEndTimeZone:body.end.timeZone});
      else Object.assign(event,body);
    }
    version++;event[isGoogle?"etag":"@odata.etag"]=`"v${version}"`;
  } else if(method!=="GET")return Response.json({error:"Unsupported test operation"},{status:405});
  return Response.json(event);
};
