import { CalendarError, calendarIdentifier, createCalendarService, eventDates, eventTimes } from "@/lib/calendar-events";
import {isCalendarTimeZone} from "@/lib/calendar-time-zone";
import { setting } from "@/lib/db";
import crypto from "node:crypto";
import { googleFetch, isGoogleConnected } from "@/lib/google";
import { apiError, assertSameOrigin } from "@/lib/http";
import {calendarSelectionVersion} from "@/lib/calendar-selection";
import {googleCalendarCatalog} from "../calendars/route.ts";

export const runtime = "nodejs";
const calendar=createCalendarService("google",{connection:()=>isGoogleConnected() ? setting("google_connection_generation") || "legacy" : null,request:googleFetch});
function failure(error:unknown) {return error instanceof CalendarError ? Response.json({error:error.message},{status:error.status}) : apiError(error);}

function enabledCalendars(accountId:string|undefined):{id:string;name?:string;color?:string}[]|undefined {
  const stored=setting("google_enabled_calendars");if (!stored || !accountId) return undefined;
  try {
    const parsed=JSON.parse(stored),items=Array.isArray(parsed)?parsed:parsed?.accountId===accountId&&Array.isArray(parsed.items)?parsed.items:null;
    if(!items)return undefined;
    return items.map((c:any)=>typeof c==="string"?{id:c}:{id:String(c.id||""),name:c.name||undefined,color:c.color||undefined}).filter((c:{id:string})=>c.id);
  } catch {return undefined;}
}
export async function GET(request:Request) {
  if (!isGoogleConnected()) return Response.json({items:[]});
  const input=new URL(request.url).searchParams;
  try {
    const accountId=setting("google_account_id"),connectionId=setting("google_connection_generation")||"legacy",version=calendarSelectionVersion("google",accountId,connectionId);
    const catalog=await googleCalendarCatalog(),enabled=new Set(catalog.enabled);
    if(catalog.version!==version)throw new CalendarError("Google paskyra pasikeitė. Atnaujink kalendorių.",409);
    const calendars=catalog.explicit ? catalog.items.filter(item=>enabled.has(item.id)).map(item=>({id:item.id,name:item.name,color:item.color})) : undefined;
    const items=await calendar.list(input.get("timeMin") || new Date().toISOString(),input.get("timeMax") || new Date(Date.now()+7*864e5).toISOString(),calendars,connectionId);
    if(!isGoogleConnected()||calendarSelectionVersion("google",setting("google_account_id"),setting("google_connection_generation")||"legacy")!==version)throw new CalendarError("Google paskyra pasikeitė. Atnaujink kalendorių.",409);
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
    const connectionId=isGoogleConnected()?setting("google_connection_generation")||"legacy":null,accountId=setting("google_account_id"),calendarId=calendarIdentifier(body.calendarId);
    if(!connectionId||!accountId)throw new CalendarError("Google paskyra neprijungta.",409);
    if(body.calendarVersion!==calendarSelectionVersion("google",accountId,connectionId))throw new CalendarError("Google paskyra arba kalendorių katalogas pasikeitė. Atnaujink kalendorius.",409);
    const enabled=enabledCalendars(accountId);
    if(enabled&&!enabled.some(calendar=>calendar.id===calendarId))throw new CalendarError("Pasirinktas Google kalendorius neįjungtas nustatymuose.",409);
    const common: Record<string, unknown> = {
      summary: String(body.summary).trim(), description: String(body.description || ""),
      ...(body.location ? { location: String(body.location).slice(0, 1000) } : {}),
      ...(body.showAs === "free" ? { transparency: "transparent" } : {}),
      ...(body.visibility === "private" ? { visibility: "private" } : {}),
    };
    let event: Record<string, unknown>;
    if (body.allDay) {
      if(body.timeZone!==undefined)throw new CalendarError("Visos dienos įvykiui laiko zona nesiunčiama.");
      const dates=eventDates(body.start,body.end);
      event = { ...common, start: { date: dates.start }, end: { date: dates.end } };
    } else {
      const times=eventTimes(body.start,body.end),timeZone=body.timeZone===undefined?"UTC":body.timeZone;
      if(!isCalendarTimeZone(timeZone))throw new CalendarError("Pasirink galiojančią IANA laiko zoną.");
      const mins = Number(body.reminderMinutes);
      const reminders = Number.isFinite(mins) && mins >= 0 ? { useDefault: false, overrides: [{ method: "popup", minutes: mins }] } : { useDefault: true };
      event = { ...common, start: { dateTime: times.start, timeZone }, end: { dateTime: times.end, timeZone }, attendees: String(body.attendees || "").split(",").map((email) => email.trim()).filter(Boolean).map((email) => ({ email })), reminders };
      if (body.addMeet) event.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
    }
    const selected=await googleFetch(`/users/me/calendarList/${encodeURIComponent(calendarId)}`);
    if(!isGoogleConnected()||setting("google_account_id")!==accountId||(setting("google_connection_generation")||"legacy")!==connectionId)throw new CalendarError("Google paskyra pasikeitė. Atnaujink kalendorių.",409);
    if(selected?.id!==calendarId)throw new CalendarError("Google grąžino kitą kalendorių. Atnaujink kalendorių sąrašą.",502);
    if(enabled===undefined&&selected.primary!==true)throw new CalendarError("Pasirinktas Google kalendorius neįjungtas nustatymuose.",409);
    if(selected.accessRole!=="owner"&&selected.accessRole!=="writer")throw new CalendarError("Pasirinktame Google kalendoriuje nėra rašymo teisės.",403);
    const data = await googleFetch(`/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`, { method: "POST", body: JSON.stringify(event) });
    if(!isGoogleConnected()||setting("google_account_id")!==accountId||(setting("google_connection_generation")||"legacy")!==connectionId)throw new CalendarError("Google paskyra pasikeitė. Atnaujink kalendorių.",409);
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
