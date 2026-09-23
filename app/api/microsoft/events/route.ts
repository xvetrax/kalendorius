import { CalendarError, createCalendarService } from "@/lib/calendar-events";
import { setting } from "@/lib/db";
import { graphFetch, isMicrosoftConnected } from "@/lib/microsoft";
import { apiError, assertSameOrigin } from "@/lib/http";
import { buildOutlookEvent } from "@/lib/planning";

export const runtime = "nodejs";
const calendar=createCalendarService("outlook",{connection:()=>isMicrosoftConnected() ? setting("microsoft_connection_generation") || "legacy" : null,request:graphFetch});
function failure(error:unknown) {return error instanceof CalendarError ? Response.json({error:error.message},{status:error.status}) : apiError(error);}

function enabledCalendars(key:string):{id:string;name?:string;color?:string}[]|undefined {
  const stored=setting(key);if (!stored) return undefined;
  try {
    const parsed=JSON.parse(stored);if (!Array.isArray(parsed)) return undefined;
    return parsed.map((c:any)=>typeof c==="string"?{id:c}:{id:String(c.id||""),name:c.name||undefined,color:c.color||undefined}).filter(c=>c.id);
  } catch {return undefined;}
}
export async function GET(request:Request) {
  if (!isMicrosoftConnected()) return Response.json({items:[]});
  const input=new URL(request.url).searchParams;
  try {return Response.json({items:await calendar.list(input.get("timeMin") || new Date().toISOString(),input.get("timeMax") || new Date(Date.now()+7*864e5).toISOString(),enabledCalendars("microsoft_enabled_calendars"))},{headers:{"Cache-Control":"no-store"}});}
  catch(error) {return failure(error);}
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    if (!String(body.summary || "").trim() || !body.start || !body.end) return Response.json({ error: "Trūksta pavadinimo arba laiko" }, { status: 400 });
    const event = buildOutlookEvent(body);
    if (new Date(String(body.end)) <= new Date(String(body.start))) return Response.json({ error: "Pabaiga turi būti vėliau už pradžią" }, { status: 400 });
    const data = await graphFetch("/me/events", { method: "POST", body: JSON.stringify(event) });
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
