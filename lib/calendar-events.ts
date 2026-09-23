export type CalendarProvider = "google" | "outlook";
export type CalendarEvent = {
  id:string; key:string; provider:CalendarProvider; connectionId:string; version:string;
  calendarId:string; calendarName?:string; calendarColor?:string;
  summary:string; description?:string; location?:string; start:{dateTime?:string;date?:string}; end:{dateTime?:string;date?:string};
  htmlLink?:string; hangoutLink?:string; editable:boolean; readOnlyReason:string;
  attendeeCount:number; attendees?:{email:string;name?:string;self?:boolean;responseStatus:string}[]; recurring:boolean; allDay:boolean;
};
export class CalendarError extends Error {
  status:number;
  constructor(message:string,status=400) {super(message);this.status=status;}
}
type Gateway = {connection:()=>string|null;request:(path:string,init?:RequestInit)=>Promise<any>};
const locks=new Map<string,Promise<unknown>>();
function instant(value:unknown) {
  if (typeof value !== "string" || !/(Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) throw new CalendarError("Pateik teisingą laiką su laiko zona.");
  return new Date(value).toISOString();
}
export function eventTimes(start:unknown,end:unknown) {
  const from=instant(start),to=instant(end);
  if (Date.parse(to)<=Date.parse(from)) throw new CalendarError("Pabaiga turi būti vėliau už pradžią.");
  return {start:from,end:to};
}
function graphTime(value:any) {
  const raw=value?.dateTime;
  if (!raw) return undefined;
  if (/(Z|[+-]\d{2}:\d{2})$/i.test(raw)) return raw;
  // All Graph reads in this adapter request UTC explicitly.
  if (value.timeZone !== "UTC") throw new CalendarError("Nepavyko nustatyti Outlook įvykio laiko zonos.",502);
  return `${raw}Z`;
}
function identifier(value:unknown,label:string) {
  if (typeof value!=="string" || !value || value==="." || value===".." || value.length>2048 || /[\u0000-\u001f]/.test(value)) throw new CalendarError(`Trūksta arba neteisingas ${label}.`);
  return value;
}
export function calendarEventKey(provider:CalendarProvider,connectionId:string,calendarId:string,id:string) {
  return JSON.stringify([provider,connectionId,calendarId,id]);
}
export function normalizeEvent(provider:CalendarProvider,raw:any,connectionId:string,calendarId="primary",calendarName?:string,calendarColor?:string):CalendarEvent {
  const google=provider === "google";
  const allDay=google ? Boolean(raw.start?.date) : Boolean(raw.isAllDay);
  const recurringMaster=google ? Boolean(raw.recurrence && !raw.recurringEventId) : raw.type === "seriesMaster";
  const recurringInstance=google ? Boolean(raw.recurringEventId) : Boolean(raw.seriesMasterId || (raw.type === "occurrence" || raw.type === "exception"));
  const recurring=recurringMaster || recurringInstance;
  const version=String((google ? raw.etag : raw["@odata.etag"] || raw.changeKey) || "");
  const owner=google ? raw.organizer?.self === true : raw.isOrganizer === true;
  const special=google && ((raw.eventType && raw.eventType !== "default") || raw.locked);
  const cancelled=google ? raw.status === "cancelled" : raw.isCancelled;
  const readOnlyReason=cancelled ? "Įvykis atšauktas." : !owner ? "Šiame etape redaguojami tik tavo organizuojami įvykiai." : special ? "Šio tipo įvykį redaguok originaliame kalendoriuje." : allDay ? "Visos dienos įvykio redagavimas dar ruošiamas." : recurringMaster ? "Pasikartojančių įvykių serija redaguojama originaliame kalendoriuje." : !version ? "Nėra įvykio versijos. Atnaujink kalendorių." : "";
  const location:string|undefined=google ? (raw.location || undefined) : (raw.location?.displayName || undefined);
  const description:string|undefined=google ? (raw.description || undefined) : (raw.body?.content || undefined);
  const rawAttendees:any[]=Array.isArray(raw.attendees) ? raw.attendees : [];
  const attendees=rawAttendees.length ? rawAttendees.map((a:any)=>google
    ? {email:String(a.email||""),name:a.displayName||undefined,self:Boolean(a.self),responseStatus:a.responseStatus||"needsAction"}
    : {email:String(a.emailAddress?.address||""),name:a.emailAddress?.name||undefined,self:false,responseStatus:a.status?.response==="accepted"?"accepted":a.status?.response==="declined"?"declined":a.status?.response==="tentativelyAccepted"?"tentative":"needsAction"}) : undefined;
  return {id:raw.id,key:calendarEventKey(provider,connectionId,calendarId,raw.id),provider,connectionId,version,calendarId,...(calendarName ? {calendarName} : {}),...(calendarColor ? {calendarColor} : {}),summary:(google ? raw.summary : raw.subject) || "Be pavadinimo",
    ...(description ? {description} : {}),
    ...(location ? {location} : {}),
    start:google ? raw.start : {dateTime:graphTime(raw.start)},end:google ? raw.end : {dateTime:graphTime(raw.end)},
    htmlLink:google ? raw.htmlLink : raw.webLink,hangoutLink:google ? raw.hangoutLink : raw.onlineMeeting?.joinUrl,
    editable:!readOnlyReason,readOnlyReason,attendeeCount:rawAttendees.length,
    ...(attendees ? {attendees} : {}),
    recurring,allDay};
}
export function createCalendarService(provider:CalendarProvider,gateway:Gateway) {
  const google=provider === "google";
  const headers={Prefer:'outlook.timezone="UTC"'};
  function connected(id?:unknown) {
    const current=gateway.connection();
    if (!current || (id !== undefined && id !== current)) throw new CalendarError("Paskyra atjungta arba pasikeitė. Atnaujink kalendorių.",409);
    return current;
  }
  function eventPath(calendarId:string,eventId:string) {
    const calendar=encodeURIComponent(calendarId),event=encodeURIComponent(eventId);
    return google ? `/calendars/${calendar}/events/${event}` : calendarId==="primary" ? `/me/calendar/events/${event}` : `/me/calendars/${calendar}/events/${event}`;
  }
  async function listOne(start:string,end:string,calId:string|null,calName:string|undefined,calColor:string|undefined,connectionId:string) {
    const raw:any[]=[];
    const calEnc=calId && (google || calId!=="primary") ? encodeURIComponent(calId) : null;
    const basePath=google
      ? `/calendars/${calEnc || "primary"}/events`
      : calEnc ? `/me/calendars/${calEnc}/calendarView` : `/me/calendarView`;
    const expectedOutlookPath=google ? null : calEnc ? `/v1.0/me/calendars/${calEnc}/calendarView` : "/v1.0/me/calendarView";
    let next:string|null=google
      ? `${basePath}?${new URLSearchParams({timeMin:start,timeMax:end,singleEvents:"true",orderBy:"startTime",maxResults:"250"})}`
      : `${basePath}?${new URLSearchParams({startDateTime:start,endDateTime:end,$orderby:"start/dateTime",$top:"250"})}`;
    const visited=new Set<string>();
    while (next) {
      if (visited.has(next)) throw new CalendarError("Kalendoriaus puslapiavimo klaida.",502);
      visited.add(next);connected(connectionId);
      const page=await gateway.request(next,{headers});connected(connectionId);
      raw.push(...(google ? page.items || [] : page.value || []));
      if (google) {
        const token=page.nextPageToken;
        next=token ? `${basePath}?${new URLSearchParams({timeMin:start,timeMax:end,singleEvents:"true",orderBy:"startTime",maxResults:"250",pageToken:token})}` : null;
      } else {
        next=page["@odata.nextLink"] || null;
        if (next) {const url=new URL(next);if (url.origin !== "https://graph.microsoft.com" || url.pathname !== expectedOutlookPath || url.username || url.password || url.hash) throw new CalendarError("Nesaugi kalendoriaus puslapiavimo nuoroda.",502);next=url.pathname.slice(5)+url.search;}
      }
    }
    return raw.filter(r=>google ? r.status !== "cancelled" : !r.isCancelled).map(r=>normalizeEvent(provider,r,connectionId,calId||"primary",calName,calColor));
  }
  async function list(start:string,end:string,calendars?:{id:string;name?:string;color?:string}[]) {
    const times=eventTimes(start,end); const connectionId=connected();
    if (!calendars?.length) return listOne(times.start,times.end,google ? "primary" : null,undefined,undefined,connectionId);
    const pages=await Promise.all(calendars.map(c=>listOne(times.start,times.end,c.id,c.name,c.color,connectionId)));
    return pages.flat();
  }
  async function update(input:Record<string,unknown>) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CalendarError("Neteisingi įvykio duomenys.");
    const allowed=new Set(["id","calendarId","connectionId","version","start","end","summary","description","location","attendees","confirmAttendees"]);
    if (Object.keys(input).some(key=>!allowed.has(key))) throw new CalendarError("Pateikti nepalaikomi įvykio laukai.");
    const eventId=identifier(input.id,"įvykio ID"),calendarId=identifier(input.calendarId,"kalendoriaus ID");
    if (typeof input.version !== "string" || !input.version || typeof input.connectionId !== "string") throw new CalendarError("Trūksta įvykio ID, paskyros arba versijos.");
    const times=eventTimes(input.start,input.end);
    if (input.summary !== undefined && (typeof input.summary !== "string" || !input.summary.trim() || input.summary.length>1024)) throw new CalendarError("Įvesk pavadinimą iki 1024 simbolių.");
    if (input.attendees !== undefined) {
      if (!Array.isArray(input.attendees)) throw new CalendarError("Neteisingas dalyvių sąrašas.");
      const emails=(input.attendees as any[]).map(a=>typeof a?.email==="string" ? a.email.toLowerCase().trim() : "");
      if (emails.some(e=>!e||!e.includes("@")||e.length>256)) throw new CalendarError("Neteisingas dalyvio el. paštas.");
    }
    const connectionId=connected(input.connectionId),key=calendarEventKey(provider,connectionId,calendarId,eventId);
    const previous=locks.get(key) || Promise.resolve();
    const operation=previous.catch(()=>{}).then(async ()=>{
      connected(connectionId);
      const base=eventPath(calendarId,eventId);
      const raw=await gateway.request(base,{headers});connected(connectionId);
      if (raw?.id!==eventId) throw new CalendarError("Tiekėjas grąžino kito įvykio duomenis. Atnaujink kalendorių.",502);
      const current=normalizeEvent(provider,raw,connectionId,calendarId);
      if (!current.editable) throw new CalendarError(current.readOnlyReason,403);
      if (current.version !== input.version) throw new CalendarError("Įvykis jau pakeistas kitur. Atnaujink kalendorių ir peržiūrėk laiką.",409);
      const curStart=current.start.dateTime ? new Date(current.start.dateTime).getTime() : NaN;
      const curEnd=current.end.dateTime ? new Date(current.end.dateTime).getTime() : NaN;
      const timeChanged=!Number.isNaN(curStart)&&(curStart!==new Date(times.start).getTime()||curEnd!==new Date(times.end).getTime());
      if (timeChanged && current.attendeeCount && input.confirmAttendees !== true) throw new CalendarError("Laiko pakeitimas išsiųs atnaujinimą dalyviams. Patvirtink pakeitimą.",409);
      const locPatch=input.location !== undefined ? (google ? {location:String(input.location||"").slice(0,1000)||null} : {location:{displayName:String(input.location||"").slice(0,1000)}}) : {};
      const descPatch=input.description !== undefined ? (google ? {description:String(input.description||"").slice(0,10000)} : {body:{contentType:"text",content:String(input.description||"").slice(0,10000)}}) : {};
      const attendeePatch=input.attendees !== undefined ? (google
        ? {attendees:(input.attendees as any[]).map(a=>({email:String(a.email).toLowerCase().trim()}))}
        : {attendees:(input.attendees as any[]).map(a=>({emailAddress:{address:String(a.email).toLowerCase().trim()},type:"required"}))}) : {};
      const patch=google ? {start:{dateTime:times.start,timeZone:raw.start?.timeZone || "UTC"},end:{dateTime:times.end,timeZone:raw.end?.timeZone || "UTC"},...(input.summary !== undefined ? {summary:input.summary} : {}),...locPatch,...descPatch,...attendeePatch} : {start:{dateTime:times.start.replace(/Z$/,""),timeZone:"UTC"},end:{dateTime:times.end.replace(/Z$/,""),timeZone:"UTC"},...(input.summary !== undefined ? {subject:input.summary} : {}),...locPatch,...descPatch,...attendeePatch};
      const updated=await gateway.request(base+(google ? "?sendUpdates=all&conferenceDataVersion=1" : ""),{method:"PATCH",headers:{...headers,...((google || raw["@odata.etag"]) ? {"If-Match":current.version} : {})},body:JSON.stringify(patch)});
      connected(connectionId);
      if (updated?.id!==eventId) throw new CalendarError("Tiekėjas nepatvirtino pasirinkto įvykio pakeitimo. Atnaujink kalendorių.",502);
      return normalizeEvent(provider,updated,connectionId,calendarId);
    });
    locks.set(key,operation);
    try {return await operation;} finally {if (locks.get(key)===operation) locks.delete(key);}
  }
  async function remove(input:Record<string,unknown>) {
    const id=identifier(input.id,"įvykio ID"),calendarId=identifier(input.calendarId,"kalendoriaus ID");
    if (typeof input.connectionId!=="string" || typeof input.version!=="string" || !input.version) throw new CalendarError("Trūksta paskyros arba įvykio versijos.");
    const connectionId=connected(input.connectionId),key=calendarEventKey(provider,connectionId,calendarId,id);
    const operation=(locks.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{
      connected(connectionId);
      const base=eventPath(calendarId,id),raw=await gateway.request(base,{headers});connected(connectionId);
      if(raw?.id!==id) throw new CalendarError("Tiekėjas grąžino kito įvykio duomenis.",502);
      const current=normalizeEvent(provider,raw,connectionId,calendarId);
      if(!current.editable) throw new CalendarError(current.readOnlyReason,403);
      if(current.version!==input.version) throw new CalendarError("Įvykis jau pakeistas kitur. Atnaujink kalendorių.",409);
      await gateway.request(base+(google?"?sendUpdates=all":""),{method:"DELETE",headers:{...headers,"If-Match":current.version}});
      connected(connectionId);
    });
    locks.set(key,operation);
    try {await operation;} finally {if(locks.get(key)===operation) locks.delete(key);}
  }
  return {list,update,remove};
}
