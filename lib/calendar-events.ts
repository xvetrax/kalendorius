export type CalendarProvider = "google" | "outlook";
export type CalendarEvent = {
  id:string; provider:CalendarProvider; connectionId:string; version:string;
  summary:string; location?:string; start:{dateTime?:string;date?:string}; end:{dateTime?:string;date?:string};
  htmlLink?:string; hangoutLink?:string; editable:boolean; readOnlyReason:string;
  attendeeCount:number; recurring:boolean; allDay:boolean;
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
export function normalizeEvent(provider:CalendarProvider,raw:any,connectionId:string):CalendarEvent {
  const google=provider === "google";
  const allDay=google ? Boolean(raw.start?.date) : Boolean(raw.isAllDay);
  const recurring=google ? Boolean(raw.recurringEventId || raw.recurrence) : Boolean(raw.seriesMasterId || (raw.type && raw.type !== "singleInstance"));
  const version=String((google ? raw.etag : raw["@odata.etag"] || raw.changeKey) || "");
  const owner=google ? raw.organizer?.self === true : raw.isOrganizer === true;
  const special=google && ((raw.eventType && raw.eventType !== "default") || raw.locked);
  const cancelled=google ? raw.status === "cancelled" : raw.isCancelled;
  const readOnlyReason=cancelled ? "Įvykis atšauktas." : !owner ? "Šiame etape redaguojami tik tavo organizuojami įvykiai." : special ? "Šio tipo įvykį redaguok originaliame kalendoriuje." : allDay ? "Visos dienos įvykio redagavimas dar ruošiamas." : recurring ? "Pasikartojančius įvykius kol kas redaguok originaliame kalendoriuje." : !version ? "Nėra įvykio versijos. Atnaujink kalendorių." : "";
  const location:string|undefined=google ? (raw.location || undefined) : (raw.location?.displayName || undefined);
  return {id:raw.id,provider,connectionId,version,summary:(google ? raw.summary : raw.subject) || "Be pavadinimo",
    ...(location ? {location} : {}),
    start:google ? raw.start : {dateTime:graphTime(raw.start)},end:google ? raw.end : {dateTime:graphTime(raw.end)},
    htmlLink:google ? raw.htmlLink : raw.webLink,hangoutLink:google ? raw.hangoutLink : raw.onlineMeeting?.joinUrl,
    editable:!readOnlyReason,readOnlyReason,attendeeCount:raw.attendees?.length || 0,recurring,allDay};
}
export function createCalendarService(provider:CalendarProvider,gateway:Gateway) {
  const google=provider === "google";
  const headers={Prefer:'outlook.timezone="UTC"'};
  function connected(id?:unknown) {
    const current=gateway.connection();
    if (!current || (id !== undefined && id !== current)) throw new CalendarError("Paskyra atjungta arba pasikeitė. Atnaujink kalendorių.",409);
    return current;
  }
  async function list(start:string,end:string) {
    const times=eventTimes(start,end); const connectionId=connected(); const raw:any[]=[];
    let next:string|null=google ? `/calendars/primary/events?${new URLSearchParams({timeMin:times.start,timeMax:times.end,singleEvents:"true",orderBy:"startTime",maxResults:"250"})}` : `/me/calendarView?${new URLSearchParams({startDateTime:times.start,endDateTime:times.end,$orderby:"start/dateTime",$top:"250"})}`;
    const visited=new Set<string>();
    while (next) {
      if (visited.has(next)) throw new CalendarError("Kalendoriaus puslapiavimo klaida.",502);
      visited.add(next);connected(connectionId);
      const page=await gateway.request(next,{headers});connected(connectionId);
      raw.push(...(google ? page.items || [] : page.value || []));
      if (google) {
        const token=page.nextPageToken;
        next=token ? `/calendars/primary/events?${new URLSearchParams({timeMin:times.start,timeMax:times.end,singleEvents:"true",orderBy:"startTime",maxResults:"250",pageToken:token})}` : null;
      } else {
        next=page["@odata.nextLink"] || null;
        if (next) {const url=new URL(next);if (url.origin !== "https://graph.microsoft.com" || url.pathname !== "/v1.0/me/calendarView" || url.username || url.password || url.hash) throw new CalendarError("Nesaugi kalendoriaus puslapiavimo nuoroda.",502);next=url.pathname.slice(5)+url.search;}
      }
    }
    return raw.filter(r=>google ? r.status !== "cancelled" : !r.isCancelled).map(r=>normalizeEvent(provider,r,connectionId));
  }
  async function update(input:Record<string,unknown>) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CalendarError("Neteisingi įvykio duomenys.");
    const allowed=new Set(["id","connectionId","version","start","end","summary","location","confirmAttendees"]);
    if (Object.keys(input).some(key=>!allowed.has(key))) throw new CalendarError("Pateikti nepalaikomi įvykio laukai.");
    if (typeof input.id !== "string" || !input.id || input.id === "." || input.id === ".." || input.id.length>2048 || typeof input.version !== "string" || !input.version || typeof input.connectionId !== "string") throw new CalendarError("Trūksta įvykio ID, paskyros arba versijos.");
    const times=eventTimes(input.start,input.end);
    if (input.summary !== undefined && (typeof input.summary !== "string" || !input.summary.trim() || input.summary.length>1024)) throw new CalendarError("Įvesk pavadinimą iki 1024 simbolių.");
    const connectionId=connected(input.connectionId),key=JSON.stringify([provider,connectionId,input.id]);
    const previous=locks.get(key) || Promise.resolve();
    const operation=previous.catch(()=>{}).then(async ()=>{
      connected(connectionId);
      const base=google ? `/calendars/primary/events/${encodeURIComponent(input.id as string)}` : `/me/events/${encodeURIComponent(input.id as string)}`;
      const raw=await gateway.request(base,{headers});connected(connectionId);
      const current=normalizeEvent(provider,raw,connectionId);
      if (!current.editable) throw new CalendarError(current.readOnlyReason,403);
      if (current.version !== input.version) throw new CalendarError("Įvykis jau pakeistas kitur. Atnaujink kalendorių ir peržiūrėk laiką.",409);
      if (current.attendeeCount && input.confirmAttendees !== true) throw new CalendarError("Laiko pakeitimas išsiųs atnaujinimą dalyviams. Patvirtink pakeitimą.",409);
      const locPatch=input.location !== undefined ? (google ? {location:String(input.location||"").slice(0,1000)||null} : {location:{displayName:String(input.location||"").slice(0,1000)}}) : {};
      const patch=google ? {start:{dateTime:times.start,timeZone:raw.start?.timeZone || "UTC"},end:{dateTime:times.end,timeZone:raw.end?.timeZone || "UTC"},...(input.summary !== undefined ? {summary:input.summary} : {}),...locPatch} : {start:{dateTime:times.start.replace(/Z$/,""),timeZone:"UTC"},end:{dateTime:times.end.replace(/Z$/,""),timeZone:"UTC"},...(input.summary !== undefined ? {subject:input.summary} : {}),...locPatch};
      const updated=await gateway.request(base+(google ? "?sendUpdates=all&conferenceDataVersion=1" : ""),{method:"PATCH",headers:{...headers,...((google || raw["@odata.etag"]) ? {"If-Match":current.version} : {})},body:JSON.stringify(patch)});
      connected(connectionId);
      return normalizeEvent(provider,updated,connectionId);
    });
    locks.set(key,operation);
    try {return await operation;} finally {if (locks.get(key)===operation) locks.delete(key);}
  }
  return {list,update};
}
