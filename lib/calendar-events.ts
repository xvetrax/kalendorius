import {isCalendarTimeZone,matchingCalendarTimeZone,unambiguousZonedProviderDateTime} from "./calendar-time-zone.ts";
import {calendarRecurrenceWeekdays,graphCalendarRecurrence,googleCalendarRecurrence,parseCalendarRecurrence,parseGoogleCalendarRecurrence,parseGraphCalendarRecurrence,type CalendarRecurrence,type CalendarRecurrenceContext} from "./calendar-recurrence.ts";

export type CalendarProvider = "google" | "outlook";
export type CalendarResponseStatus = "needsAction" | "accepted" | "tentative" | "declined";
export type CalendarVisibility = "default" | "public" | "private" | "personal" | "confidential";
export type CalendarReminder = {mode:"default"|"none"|"minutes"|"custom";minutes?:number};
export type CalendarEvent = {
  id:string; key:string; provider:CalendarProvider; connectionId:string; version:string;
  calendarId:string; calendarName?:string; calendarColor?:string;
  mirrorTaskKey?:string|null;
  summary:string; description?:string; location?:string; start:{dateTime?:string;date?:string}; end:{dateTime?:string;date?:string};
  htmlLink?:string; hangoutLink?:string; editable:boolean; readOnlyReason:string;
  attendeeCount:number; attendees?:{email:string;name?:string;self?:boolean;responseStatus:string}[]; recurring:boolean; allDay:boolean;
  seriesId?:string;
  canRespond:boolean; responseStatus?:CalendarResponseStatus;
  showAs:"free"|"tentative"|"busy"|"oof"|"workingElsewhere"|"unknown"; visibility:CalendarVisibility; reminder:CalendarReminder; timeZone?:string;
};
export class CalendarError extends Error {
  status:number;
  constructor(message:string,status=400) {super(message);this.status=status;}
}
export type CalendarSeriesSnapshot={seriesId:string;version:string;startDate:string;recurrence:CalendarRecurrence|null;supported:boolean;readonlyReason?:string};
type Gateway = {connection:()=>string|null;request:(path:string,init?:RequestInit)=>Promise<any>;mirrorTaskKey?:(raw:any,calendarId:string)=>string|null};
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
function calendarDate(value:unknown) {
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new CalendarError("Pateik teisingą kalendorinę dieną.");
  const parsed=new Date(`${value}T00:00:00Z`);
  if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)throw new CalendarError("Pateik teisingą kalendorinę dieną.");
  return value;
}
export function eventDates(start:unknown,end:unknown) {
  const from=calendarDate(start),to=calendarDate(end);
  if(to<=from)throw new CalendarError("Pabaigos diena turi būti vėliau už pradžios dieną.");
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
function graphDate(value:any) {
  return calendarDate(typeof value?.dateTime==="string"?value.dateTime.slice(0,10):undefined);
}
function identifier(value:unknown,label:string) {
  if (typeof value!=="string" || !value || value==="." || value===".." || value.length>2048 || /[\u0000-\u001f]/.test(value)) throw new CalendarError(`Trūksta arba neteisingas ${label}.`);
  return value;
}
export function calendarIdentifier(value:unknown){return identifier(value,"kalendoriaus ID");}
export function calendarEventKey(provider:CalendarProvider,connectionId:string,calendarId:string,id:string) {
  return JSON.stringify([provider,connectionId,calendarId,id]);
}
function stripHtml(html: string): string {
  const numericEntity=(_:string,value:string,radix=10)=>{const code=Number.parseInt(value,radix);return Number.isInteger(code)&&code>=0&&code<=0x10ffff?String.fromCodePoint(code):"�";};
  return html
    .replace(/<(head|style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g,(match,value)=>numericEntity(match,value))
    .replace(/&#x([0-9a-f]+);/gi,(match,value)=>numericEntity(match,value,16))
    .replace(/\r\n|\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function normalizeEvent(provider:CalendarProvider,raw:any,connectionId:string,calendarId="primary",calendarName?:string,calendarColor?:string):CalendarEvent {
  const google=provider === "google";
  const allDay=google ? Boolean(raw.start?.date) : Boolean(raw.isAllDay);
  const sourceTimeZone=google?raw.start?.timeZone:raw.originalStartTimeZone;
  const timeZone=!allDay?(isCalendarTimeZone(sourceTimeZone)?sourceTimeZone:isCalendarTimeZone(raw.start?.timeZone)?raw.start.timeZone:"UTC"):undefined;
  const recurringMaster=google ? Boolean(raw.recurrence && !raw.recurringEventId) : raw.type === "seriesMaster";
  const recurringInstance=google ? Boolean(raw.recurringEventId) : Boolean(raw.seriesMasterId || (raw.type === "occurrence" || raw.type === "exception"));
  const recurring=recurringMaster || recurringInstance;
  const rawSeriesId=google?raw.recurringEventId:raw.seriesMasterId;
  const seriesId=recurringInstance&&typeof rawSeriesId==="string"&&rawSeriesId?rawSeriesId:recurringMaster?String(raw.id):undefined;
  const version=String((google ? raw.etag : raw["@odata.etag"] || raw.changeKey) || "");
  const owner=google ? raw.organizer?.self === true : raw.isOrganizer === true;
  const special=google && ((raw.eventType && raw.eventType !== "default") || raw.locked);
  const cancelled=google ? raw.status === "cancelled" : raw.isCancelled;
  const readOnlyReason=cancelled ? "Įvykis atšauktas." : !owner ? "Šiame etape redaguojami tik tavo organizuojami įvykiai." : special ? "Šio tipo įvykį redaguok originaliame kalendoriuje." : recurringMaster ? "Pasikartojančių įvykių serija redaguojama originaliame kalendoriuje." : !version ? "Nėra įvykio versijos. Atnaujink kalendorių." : "";
  const location:string|undefined=google ? (raw.location || undefined) : (raw.location?.displayName || undefined);
  const rawDescription=google ? (raw.description || undefined) : (raw.body?.content || undefined);
  const description:string|undefined=rawDescription ? (google ? rawDescription : stripHtml(rawDescription)) : undefined;
  const rawAttendees:any[]=Array.isArray(raw.attendees) ? raw.attendees : [];
  const selfAttendee=google ? rawAttendees.find((attendee:any)=>attendee?.self===true && attendee?.email) : undefined;
  const graphResponse=String(raw.responseStatus?.response || "");
  const responseStatus:CalendarResponseStatus|undefined=google ? (selfAttendee ? (["accepted","tentative","declined"].includes(selfAttendee.responseStatus) ? selfAttendee.responseStatus : "needsAction") : undefined)
    : graphResponse==="accepted" ? "accepted" : graphResponse==="tentativelyAccepted" ? "tentative" : graphResponse==="declined" ? "declined" : ["none","notResponded"].includes(graphResponse) ? "needsAction" : undefined;
  const canRespond=!cancelled&&!special&&!owner&&Boolean(version&&responseStatus);
  const graphShowAs=String(raw.showAs||"busy");
  const showAs=google ? (raw.transparency==="transparent"?"free":"busy") : (["free","tentative","busy","oof","workingElsewhere","unknown"].includes(graphShowAs)?graphShowAs:"unknown") as CalendarEvent["showAs"];
  const graphVisibility=String(raw.sensitivity||"normal");
  const visibility:CalendarVisibility=google ? (["public","private","confidential"].includes(raw.visibility)?raw.visibility:"default") : (["personal","private","confidential"].includes(graphVisibility)?graphVisibility:"default") as CalendarVisibility;
  const googleOverrides=Array.isArray(raw.reminders?.overrides)?raw.reminders.overrides:[];
  const reminder:CalendarReminder=google ? raw.reminders?.useDefault!==false ? {mode:"default"} : googleOverrides.length===0 ? {mode:"none"}
    : googleOverrides.length===1&&googleOverrides[0]?.method==="popup"&&Number.isInteger(googleOverrides[0]?.minutes) ? {mode:"minutes",minutes:googleOverrides[0].minutes} : {mode:"custom"}
    : raw.isReminderOn===false ? {mode:"none"} : raw.isReminderOn===true&&Number.isInteger(raw.reminderMinutesBeforeStart) ? {mode:"minutes",minutes:raw.reminderMinutesBeforeStart} : {mode:"custom"};
  const attendees=rawAttendees.length ? rawAttendees.map((a:any)=>google
    ? {email:String(a.email||""),name:a.displayName||undefined,self:Boolean(a.self),responseStatus:a.responseStatus||"needsAction"}
    : {email:String(a.emailAddress?.address||""),name:a.emailAddress?.name||undefined,self:false,responseStatus:a.status?.response==="accepted"?"accepted":a.status?.response==="declined"?"declined":a.status?.response==="tentativelyAccepted"?"tentative":"needsAction"}) : undefined;
  return {id:raw.id,key:calendarEventKey(provider,connectionId,calendarId,raw.id),provider,connectionId,version,calendarId,...(calendarName ? {calendarName} : {}),...(calendarColor ? {calendarColor} : {}),summary:(google ? raw.summary : raw.subject) || "Be pavadinimo",
    ...(description ? {description} : {}),
    ...(location ? {location} : {}),
    start:google ? raw.start : allDay ? {date:graphDate(raw.start)} : {dateTime:graphTime(raw.start)},end:google ? raw.end : allDay ? {date:graphDate(raw.end)} : {dateTime:graphTime(raw.end)},
    htmlLink:google ? raw.htmlLink : raw.webLink,hangoutLink:google ? raw.hangoutLink : raw.onlineMeeting?.joinUrl,
    editable:!readOnlyReason,readOnlyReason,attendeeCount:rawAttendees.length,
    ...(attendees ? {attendees} : {}),
    recurring,...(seriesId?{seriesId}:{}),allDay,canRespond,...(responseStatus ? {responseStatus} : {}),showAs,visibility,reminder,...(timeZone?{timeZone}:{})};
}
export function createCalendarService(provider:CalendarProvider,gateway:Gateway) {
  const google=provider === "google";
  function normalize(raw:any,connectionId:string,calendarId:string,calendarName?:string,calendarColor?:string) {
    const event=normalizeEvent(provider,raw,connectionId,calendarId,calendarName,calendarColor);
    // Explicit null also clears a previously confirmed link after a PATCH.
    return {...event,mirrorTaskKey:google ? null : gateway.mirrorTaskKey?.(raw,calendarId) ?? null};
  }
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
  function outlookDateTime(value:string,timeZone:string){
    try{return unambiguousZonedProviderDateTime(value,timeZone);}
    catch(error){throw new CalendarError(error instanceof Error?error.message:"Neteisingas Outlook įvykio laikas.");}
  }
  function dateInZone(value:string,timeZone:string){
    const parts=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(value));
    const field=(type:string)=>parts.find(part=>part.type===type)?.value||"";
    return `${field("year")}-${field("month")}-${field("day")}`;
  }
  function seriesContext(raw:any):CalendarRecurrenceContext {
    const allDay=google?Boolean(raw.start?.date):Boolean(raw.isAllDay);
    if(allDay){
      if(google)return {startDate:calendarDate(raw.start?.date),allDay:true};
      const providerWeekStart=calendarRecurrenceWeekdays.includes(raw.recurrence?.pattern?.firstDayOfWeek)?raw.recurrence.pattern.firstDayOfWeek:undefined;
      const providerTimeZone=typeof raw.recurrence?.range?.recurrenceTimeZone==="string"&&raw.recurrence.range.recurrenceTimeZone?raw.recurrence.range.recurrenceTimeZone:"UTC";
      return {startDate:graphDate(raw.start),allDay:true,providerTimeZone,...(providerWeekStart?{providerWeekStart}:{})};
    }
    if(google){
      const timeZone=isCalendarTimeZone(raw.start?.timeZone)?raw.start.timeZone:"UTC";
      return {startDate:dateInZone(instant(raw.start?.dateTime),timeZone),allDay:false,timeZone};
    }
    const timeZone=isCalendarTimeZone(raw.originalStartTimeZone)?raw.originalStartTimeZone:isCalendarTimeZone(raw.start?.timeZone)?raw.start.timeZone:"UTC";
    const rangeStart=raw.recurrence?.range?.startDate;
    const providerWeekStart=calendarRecurrenceWeekdays.includes(raw.recurrence?.pattern?.firstDayOfWeek)?raw.recurrence.pattern.firstDayOfWeek:undefined;
    return {startDate:calendarDate(typeof rangeStart==="string"?rangeStart:String(raw.start?.dateTime||"").slice(0,10)),allDay:false,timeZone,providerTimeZone:typeof raw.recurrence?.range?.recurrenceTimeZone==="string"&&raw.recurrence.range.recurrenceTimeZone?raw.recurrence.range.recurrenceTimeZone:timeZone,...(providerWeekStart?{providerWeekStart}:{})};
  }
  function seriesSnapshot(raw:any,seriesId:string):CalendarSeriesSnapshot {
    const master=google?Boolean(raw.recurrence&&!raw.recurringEventId):raw.type==="seriesMaster";
    if(raw?.id!==seriesId||!master)throw new CalendarError("Pasikartojančio įvykio serija neberasta. Atnaujink kalendorių.",409);
    const version=String((google?raw.etag:raw["@odata.etag"]||raw.changeKey)||"");
    const owner=google?raw.organizer?.self===true:raw.isOrganizer===true;
    const special=google&&((raw.eventType&&raw.eventType!=="default")||raw.locked);
    const context=seriesContext(raw);
    const recurrence=google?parseGoogleCalendarRecurrence(raw.recurrence,context):parseGraphCalendarRecurrence(raw.recurrence,context);
    const readonlyReason=!owner?"Seriją gali keisti tik jos organizatorius.":special?"Šio tipo seriją keisk originaliame kalendoriuje.":!version?"Nėra serijos versijos. Atnaujink kalendorių.":!recurrence?"Šios tiekėjo kartojimo taisyklės programa saugiai pakeisti negali.":undefined;
    return {seriesId,version,startDate:context.startDate,recurrence,supported:Boolean(recurrence),...(readonlyReason?{readonlyReason}:{})};
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
    return raw.filter(r=>google ? r.status !== "cancelled" : !r.isCancelled).map(r=>normalize(r,connectionId,calId||"primary",calName,calColor));
  }
  async function list(start:string,end:string,calendars?:{id:string;name?:string;color?:string}[],expectedConnectionId?:string) {
    const times=eventTimes(start,end); const connectionId=connected(expectedConnectionId);
    if (calendars===undefined) return listOne(times.start,times.end,google ? "primary" : null,undefined,undefined,connectionId);
    if (!calendars.length) return [];
    const pages=await Promise.all(calendars.map(c=>listOne(times.start,times.end,c.id,c.name,c.color,connectionId)));
    return pages.flat();
  }
  async function update(input:Record<string,unknown>) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CalendarError("Neteisingi įvykio duomenys.");
    const allowed=new Set(["id","calendarId","connectionId","version","start","end","allDay","timeZone","summary","description","location","attendees","confirmAttendees","showAs","visibility","reminder"]);
    if (Object.keys(input).some(key=>!allowed.has(key))) throw new CalendarError("Pateikti nepalaikomi įvykio laukai.");
    const eventId=identifier(input.id,"įvykio ID"),calendarId=calendarIdentifier(input.calendarId);
    if (typeof input.version !== "string" || !input.version || typeof input.connectionId !== "string") throw new CalendarError("Trūksta įvykio ID, paskyros arba versijos.");
    if(input.allDay!==undefined&&typeof input.allDay!=="boolean")throw new CalendarError("Neteisingas visos dienos įvykio požymis.");
    const allDayInput=input.allDay===true,dates=allDayInput?eventDates(input.start,input.end):undefined,times=allDayInput?undefined:eventTimes(input.start,input.end);
    if(allDayInput&&input.timeZone!==undefined)throw new CalendarError("Visos dienos įvykiui laiko zona nekeičiama.");
    let requestedTimeZone:string|undefined;
    if(input.timeZone!==undefined){
      if(!isCalendarTimeZone(input.timeZone))throw new CalendarError("Pasirink galiojančią IANA laiko zoną.");
      requestedTimeZone=input.timeZone;
    }
    if (input.summary !== undefined && (typeof input.summary !== "string" || !input.summary.trim() || input.summary.length>1024)) throw new CalendarError("Įvesk pavadinimą iki 1024 simbolių.");
    if (input.attendees !== undefined) {
      if (!Array.isArray(input.attendees)) throw new CalendarError("Neteisingas dalyvių sąrašas.");
      const emails=(input.attendees as any[]).map(a=>typeof a?.email==="string" ? a.email.toLowerCase().trim() : "");
      if (emails.some(e=>!e||!e.includes("@")||e.length>256)) throw new CalendarError("Neteisingas dalyvio el. paštas.");
    }
    const allowedShowAs=google?["free","busy"]:["free","tentative","busy","oof","workingElsewhere","unknown"];
    if(input.showAs!==undefined&&!allowedShowAs.includes(String(input.showAs)))throw new CalendarError("Neteisinga laisvo arba užimto laiko būsena.");
    const allowedVisibility=google?["default","public","private","confidential"]:["default","personal","private","confidential"];
    if(input.visibility!==undefined&&!allowedVisibility.includes(String(input.visibility)))throw new CalendarError("Neteisingas įvykio matomumas.");
    let reminder:Exclude<CalendarReminder,{mode:"custom"}>|undefined;
    if(input.reminder!==undefined){
      if(!input.reminder||typeof input.reminder!=="object"||Array.isArray(input.reminder)||Object.keys(input.reminder).some(key=>!["mode","minutes"].includes(key)))throw new CalendarError("Neteisingas priminimo nustatymas.");
      const value=input.reminder as Record<string,unknown>,mode=value.mode;
      if(mode!=="default"&&mode!=="none"&&mode!=="minutes")throw new CalendarError("Neteisingas priminimo nustatymas.");
      if(mode==="default"&&!google)throw new CalendarError("Outlook įvykiui pasirink priminimo laiką arba jį išjunk.");
      if(mode==="minutes"&&(!Number.isInteger(value.minutes)||Number(value.minutes)<0||Number(value.minutes)>40320))throw new CalendarError("Priminimas turi būti nuo 0 iki 40320 minučių.");
      if(mode!=="minutes"&&value.minutes!==undefined)throw new CalendarError("Neteisingas priminimo nustatymas.");
      reminder=mode==="minutes"?{mode,minutes:Number(value.minutes)}:{mode};
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
      const modeChanged=current.allDay!==allDayInput;
      if(modeChanged&&current.recurring)throw new CalendarError("Pasikartojančio įvykio režimą keisk originaliame kalendoriuje.",409);
      let timeZone=allDayInput?undefined:requestedTimeZone||(!current.allDay?current.timeZone:undefined)||"UTC";
      const rawEndTimeZone=google?raw.end?.timeZone:raw.originalEndTimeZone;
      if(!google&&!allDayInput&&requestedTimeZone&&requestedTimeZone!=="UTC"&&(current.allDay||requestedTimeZone!==current.timeZone)){
        const supported=await gateway.request("/me/outlook/supportedTimeZones(TimeZoneStandard=microsoft.graph.timeZoneStandard'Iana')");connected(connectionId);
        if(!Array.isArray(supported?.value))throw new CalendarError("Microsoft negrąžino palaikomų laiko zonų.",502);
        const matched=matchingCalendarTimeZone(requestedTimeZone,supported.value.map((item:any)=>item?.alias));
        if(!matched)throw new CalendarError("Microsoft pašto dėžutė nepalaiko pasirinktos laiko zonos.");
        timeZone=matched;
      }
      const endTimeZone=allDayInput?undefined:(requestedTimeZone||current.allDay)?timeZone:(isCalendarTimeZone(rawEndTimeZone)?rawEndTimeZone:timeZone);
      if(current.recurring&&input.visibility!==undefined&&input.visibility!==current.visibility)throw new CalendarError("Pasikartojančio įvykio matomumą keisk originaliame kalendoriuje.",409);
      const curStart=current.start.dateTime ? new Date(current.start.dateTime).getTime() : NaN;
      const curEnd=current.end.dateTime ? new Date(current.end.dateTime).getTime() : NaN;
      const timeChanged=modeChanged||(current.allDay ? current.start.date!==dates!.start||current.end.date!==dates!.end : !Number.isNaN(curStart)&&(curStart!==new Date(times!.start).getTime()||curEnd!==new Date(times!.end).getTime()));
      if (timeChanged && current.attendeeCount && input.confirmAttendees !== true) throw new CalendarError("Laiko pakeitimas išsiųs atnaujinimą dalyviams. Patvirtink pakeitimą.",409);
      const locPatch=input.location !== undefined ? (google ? {location:String(input.location||"").slice(0,1000)||null} : {location:{displayName:String(input.location||"").slice(0,1000)}}) : {};
      const descPatch=input.description !== undefined ? (google ? {description:String(input.description||"").slice(0,10000)} : {body:{contentType:"text",content:String(input.description||"").slice(0,10000)}}) : {};
      const attendeePatch=input.attendees !== undefined ? (google
        ? {attendees:(input.attendees as any[]).map(a=>({email:String(a.email).toLowerCase().trim()}))}
        : {attendees:(input.attendees as any[]).map(a=>({emailAddress:{address:String(a.email).toLowerCase().trim()},type:"required"}))}) : {};
      const propertyPatch=google ? {
        ...(input.showAs!==undefined?{transparency:input.showAs==="free"?"transparent":"opaque"}:{}),
        ...(input.visibility!==undefined?{visibility:input.visibility}:{}),
        ...(reminder?{reminders:reminder.mode==="default"?{useDefault:true}:reminder.mode==="none"?{useDefault:false,overrides:[]}:{useDefault:false,overrides:[{method:"popup",minutes:reminder.minutes}]}}:{}),
      } : {
        ...(input.showAs!==undefined?{showAs:input.showAs}:{}),
        ...(input.visibility!==undefined?{sensitivity:input.visibility==="default"?"normal":input.visibility}:{}),
        ...(reminder?reminder.mode==="none"?{isReminderOn:false}:{isReminderOn:true,reminderMinutesBeforeStart:reminder.minutes}:{}),
      };
      const timePatch=allDayInput ? (google ? {start:{date:dates!.start},end:{date:dates!.end}} : {isAllDay:true,start:{dateTime:`${dates!.start}T00:00:00`,timeZone:"UTC"},end:{dateTime:`${dates!.end}T00:00:00`,timeZone:"UTC"}})
        : (google ? {start:{dateTime:times!.start,timeZone:timeZone!},end:{dateTime:times!.end,timeZone:endTimeZone!}} : {...(current.allDay?{isAllDay:false}:{}),start:{dateTime:outlookDateTime(times!.start,timeZone!),timeZone:timeZone!},end:{dateTime:outlookDateTime(times!.end,endTimeZone!),timeZone:endTimeZone!}});
      const patch=google ? {...timePatch,...(input.summary !== undefined ? {summary:input.summary} : {}),...locPatch,...descPatch,...attendeePatch,...propertyPatch} : {...timePatch,...(input.summary !== undefined ? {subject:input.summary} : {}),...locPatch,...descPatch,...attendeePatch,...propertyPatch};
      const updated=await gateway.request(base+(google ? "?sendUpdates=all&conferenceDataVersion=1" : ""),{method:"PATCH",headers:{...headers,...((google || raw["@odata.etag"]) ? {"If-Match":current.version} : {})},body:JSON.stringify(patch)});
      connected(connectionId);
      if (updated?.id!==eventId) throw new CalendarError("Tiekėjas nepatvirtino pasirinkto įvykio pakeitimo. Atnaujink kalendorių.",502);
      return normalize(updated,connectionId,calendarId);
    });
    locks.set(key,operation);
    try {return await operation;} finally {if (locks.get(key)===operation) locks.delete(key);}
  }
  async function series(input:Record<string,unknown>) {
    if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(key=>!["seriesId","calendarId","connectionId"].includes(key)))throw new CalendarError("Neteisinga serijos nuoroda.");
    const seriesId=identifier(input.seriesId,"serijos ID"),calendarId=calendarIdentifier(input.calendarId),connectionId=connected(input.connectionId);
    const raw=await gateway.request(eventPath(calendarId,seriesId),{headers});connected(connectionId);
    return seriesSnapshot(raw,seriesId);
  }
  async function updateSeries(input:Record<string,unknown>) {
    if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(key=>!["scope","seriesId","calendarId","connectionId","version","recurrence"].includes(key)))throw new CalendarError("Neteisingi serijos duomenys.");
    const seriesId=identifier(input.seriesId,"serijos ID"),calendarId=calendarIdentifier(input.calendarId);
    if(input.scope!=="series"||typeof input.version!=="string"||!input.version||typeof input.connectionId!=="string")throw new CalendarError("Trūksta serijos paskyros arba versijos.");
    const connectionId=connected(input.connectionId),key=calendarEventKey(provider,connectionId,calendarId,seriesId),previous=locks.get(key)||Promise.resolve();
    const operation=previous.catch(()=>{}).then(async()=>{
      connected(connectionId);const base=eventPath(calendarId,seriesId),raw=await gateway.request(base,{headers});connected(connectionId);
      const current=seriesSnapshot(raw,seriesId);if(current.readonlyReason)throw new CalendarError(current.readonlyReason,403);
      if(current.version!==input.version)throw new CalendarError("Serija jau pakeista kitur. Atnaujink kartojimo taisyklę.",409);
      const context=seriesContext(raw),recurrence=parseCalendarRecurrence(input.recurrence,context);
      if(!recurrence)throw new CalendarError("Neteisinga kartojimo taisyklė.");
      const providerRecurrence=google?googleCalendarRecurrence(recurrence,context):graphCalendarRecurrence(recurrence,context);
      const updated=await gateway.request(base+(google?"?sendUpdates=all":""),{method:"PATCH",headers:{...headers,"If-Match":current.version},body:JSON.stringify({recurrence:providerRecurrence})});
      connected(connectionId);return seriesSnapshot(updated,seriesId);
    });
    locks.set(key,operation);try{return await operation;}finally{if(locks.get(key)===operation)locks.delete(key);}
  }
  async function remove(input:Record<string,unknown>) {
    const id=identifier(input.id,"įvykio ID"),calendarId=calendarIdentifier(input.calendarId);
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
  async function respond(input:Record<string,unknown>) {
    if (!input || typeof input!=="object" || Array.isArray(input)) throw new CalendarError("Neteisingi dalyvavimo atsakymo duomenys.");
    const allowed=new Set(["id","calendarId","connectionId","version","responseStatus","comment"]);
    if (Object.keys(input).some(key=>!allowed.has(key))) throw new CalendarError("Pateikti nepalaikomi dalyvavimo atsakymo laukai.");
    const id=identifier(input.id,"įvykio ID"),calendarId=calendarIdentifier(input.calendarId);
    if (typeof input.connectionId!=="string" || typeof input.version!=="string" || !input.version) throw new CalendarError("Trūksta paskyros arba įvykio versijos.");
    if (!(["accepted","tentative","declined"] as unknown[]).includes(input.responseStatus)) throw new CalendarError("Pasirink tinkamą dalyvavimo atsakymą.");
    if (input.comment!==undefined && (typeof input.comment!=="string" || input.comment.length>1000)) throw new CalendarError("Atsakymo komentaras per ilgas.");
    const responseStatus=input.responseStatus as Exclude<CalendarResponseStatus,"needsAction">;
    const connectionId=connected(input.connectionId),key=calendarEventKey(provider,connectionId,calendarId,id);
    const operation=(locks.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{
      connected(connectionId);
      const base=eventPath(calendarId,id),raw=await gateway.request(base,{headers});connected(connectionId);
      if(raw?.id!==id) throw new CalendarError("Tiekėjas grąžino kito įvykio duomenis.",502);
      const current=normalizeEvent(provider,raw,connectionId,calendarId);
      if(!current.canRespond) throw new CalendarError("Šiam įvykiui dalyvavimo atsakymo pateikti negalima.",403);
      if(current.responseStatus===responseStatus) return {ok:true as const,responseStatus};
      if(current.version!==input.version) throw new CalendarError("Įvykis jau pakeistas kitur. Atnaujink kalendorių.",409);
      if(google) {
        const self=(Array.isArray(raw.attendees)?raw.attendees:[]).find((attendee:any)=>attendee?.self===true&&typeof attendee?.email==="string"&&attendee.email);
        if(!self) throw new CalendarError("Google negrąžino tavo dalyvio įrašo. Atsakyk originaliame kalendoriuje.",409);
        const updated=await gateway.request(`${base}?sendUpdates=all`,{method:"PATCH",headers:{...headers,"If-Match":current.version},body:JSON.stringify({attendeesOmitted:true,attendees:[{email:self.email,responseStatus}]})});
        connected(connectionId);
        if(updated?.id!==id || normalizeEvent(provider,updated,connectionId,calendarId).responseStatus!==responseStatus) throw new CalendarError("Google nepatvirtino dalyvavimo atsakymo. Atnaujink kalendorių.",502);
      } else {
        const action=responseStatus==="accepted"?"accept":responseStatus==="tentative"?"tentativelyAccept":"decline";
        await gateway.request(`${base}/${action}`,{method:"POST",headers,body:JSON.stringify({sendResponse:true,...(input.comment ? {comment:input.comment} : {})})});
        connected(connectionId);
      }
      return {ok:true as const,responseStatus};
    });
    locks.set(key,operation);
    try{return await operation;}finally{if(locks.get(key)===operation)locks.delete(key);}
  }
  return {list,update,series,updateSeries,remove,respond};
}
