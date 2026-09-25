import { CalendarError, createCalendarService, eventDates, eventTimes } from "@/lib/calendar-events";
import {isCalendarTimeZone} from "@/lib/calendar-time-zone";
import { setting } from "@/lib/db";
import crypto from "node:crypto";
import { googleFetch, isGoogleConnected } from "@/lib/google";
import { apiError, assertSameOrigin } from "@/lib/http";

export const runtime = "nodejs";
const calendar=createCalendarService("google",{connection:()=>isGoogleConnected() ? setting("google_connection_generation") || "legacy" : null,request:googleFetch});
function failure(error:unknown) {return error instanceof CalendarError ? Response.json({error:error.message},{status:error.status}) : apiError(error);}

function enabledCalendars(key:string):{id:string;name?:string;color?:string}[]|undefined {
  const stored=setting(key);if (!stored) return undefined;
  try {
    const parsed=JSON.parse(stored);if (!Array.isArray(parsed)) return undefined;
    return parsed.map((c:any)=>typeof c==="string"?{id:c}:{id:String(c.id||""),name:c.name||undefined,color:c.color||undefined}).filter(c=>c.id);
  } catch {return undefined;}
}
export async function GET(request:Request) {
  if (!isGoogleConnected()) return Response.json({items:[]});
  const input=new URL(request.url).searchParams;
  try {return Response.json({items:await calendar.list(input.get("timeMin") || new Date().toISOString(),input.get("timeMax") || new Date(Date.now()+7*864e5).toISOString(),enabledCalendars("google_enabled_calendars"))},{headers:{"Cache-Control":"no-store"}});}
  catch(error) {return failure(error);}
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    if(!body||typeof body!=="object"||Array.isArray(body))throw new CalendarError("Neteisingi įvykio duomenys.");
    if (!String(body.summary || "").trim() || !body.start || !body.end) return Response.json({ error: "Trūksta pavadinimo arba laiko" }, { status: 400 });
    const connectionId=isGoogleConnected()?setting("google_connection_generation")||"legacy":null;
    if(!connectionId)throw new CalendarError("Google paskyra neprijungta.",409);
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
    if(!isGoogleConnected()||(setting("google_connection_generation")||"legacy")!==connectionId)throw new CalendarError("Google paskyra pasikeitė. Atnaujink kalendorių.",409);
    const data = await googleFetch("/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all", { method: "POST", body: JSON.stringify(event) });
    if(!isGoogleConnected()||(setting("google_connection_generation")||"legacy")!==connectionId)throw new CalendarError("Google paskyra pasikeitė. Atnaujink kalendorių.",409);
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
