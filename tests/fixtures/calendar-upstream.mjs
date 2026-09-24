// Explicit Node preload, used only by tests/calendar-smoke.mjs. There is no
// production route or application flag that can enable this fixture.
if(process.env.CALENDAR_TEST_FIXTURE!=="isolated")throw new Error("Test-only preload");
const monday=new Date();monday.setDate(monday.getDate()-((monday.getDay()+6)%7));monday.setHours(0,0,0,0);
const date=(day,hour)=>{const d=new Date(monday);d.setDate(d.getDate()+day);d.setHours(hour);return d.toISOString();};
const google=new Map([["google-personal",{id:"google-personal",summary:"Google bandymas",etag:'"g1"',organizer:{self:true},start:{dateTime:date(0,9),timeZone:"Europe/Vilnius"},end:{dateTime:date(0,10),timeZone:"Europe/Vilnius"},attendees:[],description:"Nepakeisti aprašymo",hangoutLink:"https://meet.google.com/test",htmlLink:"https://calendar.google.com/",reminders:{useDefault:true}}]]);
const msEvent=(id,subject,day,hour,attendees=[])=>({id,subject,"@odata.etag":'W/"m1"',isOrganizer:true,type:"singleInstance",start:{dateTime:date(day,hour).replace(/Z$/,""),timeZone:"UTC"},end:{dateTime:date(day,hour+1).replace(/Z$/,""),timeZone:"UTC"},attendees,body:{contentType:"html",content:"<p>Išsaugoti Teams aprašymą</p>"},showAs:"busy",isReminderOn:true,webLink:"https://outlook.office.com/calendar/"});
const outlook=new Map([["outlook-personal",msEvent("outlook-personal","Outlook bandymas",1,10)],["outlook-meeting",msEvent("outlook-meeting","Susitikimo bandymas",2,14,[{emailAddress:{address:"synthetic@example.test"}}])],["outlook-readonly",{...msEvent("outlook-readonly","Svetimas kvietimas",3,11),isOrganizer:false}]]);
const dayKey=(day)=>{const d=new Date(monday);d.setDate(d.getDate()+day);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;};
google.set("google-all-day",{...structuredClone(google.get("google-personal")),id:"google-all-day",summary:"Visos dienos bandymas",start:{date:dayKey(0)},end:{date:dayKey(2)}});
google.set("google-recurring",{...structuredClone(google.get("google-personal")),id:"google-recurring",summary:"Pasikartojimo bandymas",recurringEventId:"test-series",start:{dateTime:date(0,13)},end:{dateTime:date(0,14)}});
google.set("google-overlap",{...structuredClone(google.get("google-personal")),id:"google-overlap",summary:"Persidengiantis įvykis",start:{dateTime:date(1,9)},end:{dateTime:date(1,11)}});
google.set("google-night",{...structuredClone(google.get("google-personal")),id:"google-night",summary:"Naktinis įvykis",start:{dateTime:date(1,23)},end:{dateTime:date(2,1)}});
let version=1;
google.set("google-short",{...structuredClone(google.get("google-personal")),id:"google-short",summary:"Trumpas",start:{dateTime:new Date(Date.parse(date(1,23))+45*60000).toISOString()},end:{dateTime:date(2,0)}});
google.set("google-invite",{...structuredClone(google.get("google-personal")),id:"google-invite",summary:"Google kvietimas",organizer:{self:false},attendees:[{email:"me@example.test",self:true,responseStatus:"needsAction"},{email:"host@example.test",organizer:true,responseStatus:"accepted"}],start:{dateTime:date(3,15)},end:{dateTime:date(3,16)}});
outlook.set("outlook-readonly",{...outlook.get("outlook-readonly"),responseStatus:{response:"notResponded"},attendees:[{emailAddress:{address:"host@example.test"},status:{response:"accepted"}}]});
export const calendarUpstream={google:new Map([["primary",google],["other/calendar",new Map([["google-personal",{...structuredClone(google.get("google-personal")),summary:"Kitas Google"}]])]]),outlook:new Map([["primary",outlook],["other/calendar",new Map([["outlook-personal",{...structuredClone(outlook.get("outlook-personal")),subject:"Kitas Outlook"}]])]])};
globalThis.fetch=async(input,init={})=>{
  const url=new URL(String(input)),method=init.method || "GET";
  if(url.hostname==="oauth2.googleapis.com" || url.hostname==="login.microsoftonline.com")return Response.json({access_token:"synthetic-access"});
  if(url.hostname!=="www.googleapis.com" && url.hostname!=="graph.microsoft.com")throw new Error("Fixture blocks external network");
  if(url.pathname==="/v1.0/me/todo/lists")return Response.json({value:[{id:"fixture-list",wellknownListName:"defaultList"}]});
  if(url.pathname==="/v1.0/me/todo/lists/fixture-list/tasks")return Response.json({value:[]});
  if(url.pathname==="/v1.0/me/calendars")return Response.json({value:[
    {id:"opaque-default",name:"Pagrindinis",color:"auto",isDefaultCalendar:true,canEdit:true},
    {id:"other/calendar",name:"Kitas",color:"lightBlue",isDefaultCalendar:false,canEdit:true},
  ]});
  if(url.pathname==="/v1.0/me/calendar")return Response.json({id:"opaque-default"});
  const isGoogle=url.hostname==="www.googleapis.com";
  const match=isGoogle ? url.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/(.+))?$/)
    : url.pathname.match(/^\/v1\.0\/me\/calendars\/([^/]+)\/(?:calendarView|events)(?:\/(.+))?$/);
  const defaultOutlook=!isGoogle && (url.pathname==="/v1.0/me/calendarView" || url.pathname.startsWith("/v1.0/me/calendar/events/"));
  if(!match && !defaultOutlook)return Response.json({error:"Fixture endpoint missing"},{status:404});
  const calendarId=match?decodeURIComponent(match[1]):"primary",map=calendarUpstream[isGoogle?"google":"outlook"].get(calendarId);
  if(!map)return Response.json({error:"Missing calendar"},{status:404});
  const encodedId=match?match[2]:url.pathname.startsWith("/v1.0/me/calendar/events/")?url.pathname.slice("/v1.0/me/calendar/events/".length):undefined;
  if(!encodedId && method==="GET")return Response.json({[isGoogle?"items":"value"]:[...map.values()]});
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
      if(Object.keys(body).some(k=>!["start","end","summary","subject"].includes(k)))throw new Error("Fixture caught destructive metadata update");Object.assign(event,body);
    }
    version++;event[isGoogle?"etag":"@odata.etag"]=`"v${version}"`;
  } else if(method!=="GET")return Response.json({error:"Unsupported test operation"},{status:405});
  return Response.json(event);
};
