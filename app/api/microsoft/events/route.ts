import { CalendarError, createCalendarService } from "@/lib/calendar-events";
import { db, saveSetting, setting } from "@/lib/db";
import { OUTLOOK_DEFAULT_CALENDAR_SETTING, outlookDefaultCalendarId, outlookMirrorTaskKey } from "@/lib/outlook-mirror-link";
import { graphFetch, isMicrosoftConnected } from "@/lib/microsoft";
import { apiError, assertSameOrigin } from "@/lib/http";
import { buildOutlookEvent } from "@/lib/planning";

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
    const accountId=setting("microsoft_account_id"),connectionId=setting("microsoft_connection_generation") || "legacy",calendars=enabledCalendars(accountId);
    await ensureDefaultCalendarIdentity(accountId,connectionId,calendars);
    return Response.json({items:await calendar.list(input.get("timeMin") || new Date().toISOString(),input.get("timeMax") || new Date(Date.now()+7*864e5).toISOString(),calendars)},{headers:{"Cache-Control":"no-store"}});
  }
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

export async function PUT(request:Request) {
  try {assertSameOrigin(request);return Response.json(await calendar.respond(await request.json()));}
  catch(error) {return failure(error);}
}
