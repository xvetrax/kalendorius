import { CalendarError, createCalendarService } from "@/lib/calendar-events";
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
    if (!String(body.summary || "").trim() || !body.start || !body.end) return Response.json({ error: "Trūksta pavadinimo arba laiko" }, { status: 400 });
    const common: Record<string, unknown> = {
      summary: String(body.summary).trim(), description: String(body.description || ""),
      ...(body.location ? { location: String(body.location).slice(0, 1000) } : {}),
      ...(body.showAs === "free" ? { transparency: "transparent" } : {}),
      ...(body.visibility === "private" ? { visibility: "private" } : {}),
    };
    let event: Record<string, unknown>;
    if (body.allDay) {
      const startDate = String(body.start).slice(0, 10);
      const endDate = String(body.end).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate <= startDate) return Response.json({ error: "Neteisingas įvykio laikas" }, { status: 400 });
      event = { ...common, start: { date: startDate }, end: { date: endDate } };
    } else {
      const start = new Date(String(body.start)); const end = new Date(String(body.end));
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return Response.json({ error: "Neteisingas įvykio laikas" }, { status: 400 });
      const mins = Number(body.reminderMinutes);
      const reminders = Number.isFinite(mins) && mins >= 0 ? { useDefault: false, overrides: [{ method: "popup", minutes: mins }] } : { useDefault: true };
      event = { ...common, start: { dateTime: start.toISOString(), timeZone: "UTC" }, end: { dateTime: end.toISOString(), timeZone: "UTC" }, attendees: String(body.attendees || "").split(",").map((email) => email.trim()).filter(Boolean).map((email) => ({ email })), reminders };
      if (body.addMeet) event.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
    }
    const data = await googleFetch("/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all", { method: "POST", body: JSON.stringify(event) });
    return Response.json(data, { status: 201 });
  } catch (error) { return apiError(error); }
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
