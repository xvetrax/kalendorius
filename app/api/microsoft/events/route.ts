import { CalendarError, calendarIdentifier, createCalendarService, eventDates, eventTimes } from "@/lib/calendar-events";
import {isCalendarTimeZone,matchingCalendarTimeZone} from "@/lib/calendar-time-zone";
import { db, saveSetting, setting } from "@/lib/db";
import { OUTLOOK_DEFAULT_CALENDAR_SETTING, outlookDefaultCalendarId, outlookMirrorTaskKey } from "@/lib/outlook-mirror-link";
import { graphFetch, isMicrosoftConnected } from "@/lib/microsoft";
import { apiError, assertSameOrigin } from "@/lib/http";
import { buildOutlookEvent } from "@/lib/planning";
import {calendarSelectionVersion} from "@/lib/calendar-selection";
import {microsoftCalendarCatalog} from "../calendars/route.ts";

export const runtime = "nodejs";
const calendar=createCalendarService("outlook",{
  connection:()=>isMicrosoftConnected() ? setting("microsoft_connection_generation") || "legacy" : null,
  request:graphFetch,
  mirrorTaskKey:(raw,calendarId)=>{
    const accountId=setting("microsoft_account_id"),connectionId=setting("microsoft_connection_generation") || "legacy";
    return outlookMirrorTaskKey(db,accountId,calendarId,outlookDefaultCalendarId(setting(OUTLOOK_DEFAULT_CALENDAR_SETTING),accountId,connectionId),raw);
  },
});
function failure(error:unknown) {return error instanceof CalendarError ? Response.json({error:error.message},{status:error.status}) : apiError(error);}

function enabledCalendars(accountId:string|undefined):{id:string;name?:string;color?:string}[]|undefined {
  const stored=setting("microsoft_enabled_calendars");if (!stored || !accountId) return undefined;
  try {
    const parsed=JSON.parse(stored);
    return parsed?.accountId===accountId && Array.isArray(parsed.items)
      ? parsed.items.map((c:any)=>({id:String(c.id||""),name:c.name||undefined,color:c.color||undefined})).filter((c:{id:string})=>c.id)
      : undefined;
  } catch {return undefined;}
}
async function ensureDefaultCalendarIdentity(accountId:string|undefined,connectionId:string,calendars:{id:string}[]|undefined) {
  if (!accountId || !calendars?.some(calendar=>calendar.id!=="primary")
    || outlookDefaultCalendarId(setting(OUTLOOK_DEFAULT_CALENDAR_SETTING),accountId,connectionId)) return;
  const current=await graphFetch("/me/calendar?$select=id");
  if (!current?.id || !isMicrosoftConnected() || setting("microsoft_account_id")!==accountId
    || (setting("microsoft_connection_generation") || "legacy")!==connectionId)
    throw new CalendarError("Microsoft paskyra pasikeitė. Atnaujink kalendorių.",409);
  saveSetting(OUTLOOK_DEFAULT_CALENDAR_SETTING,JSON.stringify([accountId,connectionId,String(current.id)]));
}
export async function GET(request:Request) {
  if (!isMicrosoftConnected()) return Response.json({items:[]});
  const input=new URL(request.url).searchParams;
  try {
    const accountId=setting("microsoft_account_id"),connectionId=setting("microsoft_connection_generation") || "legacy",version=calendarSelectionVersion("microsoft",accountId,connectionId),catalog=await microsoftCalendarCatalog(),enabled=new Set(catalog.enabled);
    if(catalog.version!==version)throw new CalendarError("Microsoft paskyra pasikeitė. Atnaujink kalendorių.",409);
    const calendars=catalog.explicit ? catalog.items.filter(item=>enabled.has(item.id)).map(item=>({id:item.isDefault&&catalog.defaultAlias?"primary":item.id,name:item.name,color:item.color})) : undefined;
    await ensureDefaultCalendarIdentity(accountId,connectionId,calendars);
    const items=await calendar.list(input.get("timeMin") || new Date().toISOString(),input.get("timeMax") || new Date(Date.now()+7*864e5).toISOString(),calendars,connectionId);
    if(!isMicrosoftConnected()||calendarSelectionVersion("microsoft",setting("microsoft_account_id"),setting("microsoft_connection_generation")||"legacy")!==version)throw new CalendarError("Microsoft paskyra pasikeitė. Atnaujink kalendorių.",409);
    return Response.json({items},{headers:{"Cache-Control":"no-store"}});
  }
  catch(error) {return failure(error);}
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    if(!body||typeof body!=="object"||Array.isArray(body))throw new CalendarError("Neteisingi įvykio duomenys.");
    if (!String(body.summary || "").trim() || !body.start || !body.end) return Response.json({ error: "Trūksta pavadinimo arba laiko" }, { status: 400 });
    const connectionId=isMicrosoftConnected()?setting("microsoft_connection_generation")||"legacy":null,accountId=setting("microsoft_account_id"),calendarId=calendarIdentifier(body.calendarId);
    if(!connectionId||!accountId)throw new CalendarError("Microsoft paskyra neprijungta.",409);
    if(body.calendarVersion!==calendarSelectionVersion("microsoft",accountId,connectionId))throw new CalendarError("Microsoft paskyra arba kalendorių katalogas pasikeitė. Atnaujink kalendorius.",409);
    const enabled=enabledCalendars(accountId);
    const exactSelection=enabled?.some(calendar=>calendar.id===calendarId)??false,legacyDefault=enabled?.some(calendar=>calendar.id==="primary")??false;
    if(enabled&&!exactSelection&&!legacyDefault)throw new CalendarError("Pasirinktas Microsoft kalendorius neįjungtas nustatymuose.",409);
    if(body.allDay){
      if(body.timeZone!==undefined)throw new CalendarError("Visos dienos įvykiui laiko zona nesiunčiama.");
      const dates=eventDates(body.start,body.end);body.start=dates.start;body.end=dates.end;
    }else{
      const times=eventTimes(body.start,body.end),requested=body.timeZone===undefined?"UTC":body.timeZone;
      if(!isCalendarTimeZone(requested))throw new CalendarError("Pasirink galiojančią IANA laiko zoną.");
      body.start=times.start;body.end=times.end;body.timeZone=requested;
      if(requested!=="UTC"){
        const supported=await graphFetch("/me/outlook/supportedTimeZones(TimeZoneStandard=microsoft.graph.timeZoneStandard'Iana')");
        if(!isMicrosoftConnected()||(setting("microsoft_connection_generation")||"legacy")!==connectionId)throw new CalendarError("Microsoft paskyra pasikeitė. Atnaujink kalendorių.",409);
        if(!Array.isArray(supported?.value))throw new CalendarError("Microsoft negrąžino palaikomų laiko zonų.",502);
        const matched=matchingCalendarTimeZone(requested,supported.value.map((item:any)=>item?.alias));
        if(!matched)throw new CalendarError("Microsoft pašto dėžutė nepalaiko pasirinktos laiko zonos.");
        body.timeZone=matched;
      }
    }
    let event:ReturnType<typeof buildOutlookEvent>;
    try{event=buildOutlookEvent(body);}catch(error){throw new CalendarError(error instanceof Error?error.message:"Neteisingas įvykio laikas.");}
    const selected=await graphFetch(`/me/calendars/${encodeURIComponent(calendarId)}?$select=id,canEdit,isDefaultCalendar`);
    if(!isMicrosoftConnected()||setting("microsoft_account_id")!==accountId||(setting("microsoft_connection_generation")||"legacy")!==connectionId)throw new CalendarError("Microsoft paskyra pasikeitė. Atnaujink kalendorių.",409);
    if(selected?.id!==calendarId)throw new CalendarError("Microsoft grąžino kitą kalendorių. Atnaujink kalendorių sąrašą.",502);
    if(enabled&&!exactSelection&&!(legacyDefault&&selected.isDefaultCalendar===true))throw new CalendarError("Pasirinktas Microsoft kalendorius neįjungtas nustatymuose.",409);
    if(enabled===undefined&&selected.isDefaultCalendar!==true)throw new CalendarError("Pasirinktas Microsoft kalendorius neįjungtas nustatymuose.",409);
    if(selected.canEdit!==true)throw new CalendarError("Pasirinktame Microsoft kalendoriuje nėra rašymo teisės.",403);
    const data = await graphFetch(`/me/calendars/${encodeURIComponent(calendarId)}/events`, { method: "POST", body: JSON.stringify(event) });
    if(!isMicrosoftConnected()||setting("microsoft_account_id")!==accountId||(setting("microsoft_connection_generation")||"legacy")!==connectionId)throw new CalendarError("Microsoft paskyra pasikeitė. Atnaujink kalendorių.",409);
    return Response.json(data, { status: 201 });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    await calendar.remove(Object.fromEntries(new URL(request.url).searchParams));
    return Response.json({ ok: true });
  } catch (error) { return failure(error); }
}

export async function PATCH(request:Request) {
  try {assertSameOrigin(request);return Response.json(await calendar.update(await request.json()));}
  catch(error) {return failure(error);}
}

export async function PUT(request:Request) {
  try {assertSameOrigin(request);return Response.json(await calendar.respond(await request.json()));}
  catch(error) {return failure(error);}
}
