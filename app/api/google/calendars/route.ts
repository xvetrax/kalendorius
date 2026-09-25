import { saveSetting, setting } from "@/lib/db";
import { googleFetch, isGoogleConnected } from "@/lib/google";
import { apiError, assertSameOrigin } from "@/lib/http";
import {calendarSelectionVersion} from "@/lib/calendar-selection";

export const runtime = "nodejs";

export async function googleCalendarCatalog() {
    const accountId=setting("google_account_id"),connectionId=setting("google_connection_generation")||"legacy";
    let next: string | null = "/users/me/calendarList?maxResults=250";
    const items: {id:string;name:string;color?:string;primary?:boolean;writable:boolean}[] = [];
    const visited = new Set<string>();
    while (next) {
      if (visited.has(next)) break;
      visited.add(next);
      const page = await googleFetch(next);
      for (const cal of page.items || []) {
        items.push({id:String(cal.id),name:String(cal.summary||cal.id),color:cal.backgroundColor||undefined,primary:Boolean(cal.primary),writable:cal.accessRole==="owner"||cal.accessRole==="writer"});
      }
      const token = page.nextPageToken;
      next = token ? `/users/me/calendarList?maxResults=250&pageToken=${encodeURIComponent(token)}` : null;
    }
    if(!isGoogleConnected()||setting("google_account_id")!==accountId||(setting("google_connection_generation")||"legacy")!==connectionId)
      throw Object.assign(new Error("Google paskyra pasikeitė. Atnaujink kalendorius."),{status:409});
    const stored = setting("google_enabled_calendars");
    let enabled=items.filter(item=>item.primary).map(item=>item.id),explicit=false;
    try {
      const parsed=stored?JSON.parse(stored):null,live=new Set(items.map(item=>item.id));
      const selected=parsed?.accountId===accountId&&Array.isArray(parsed.items) ? parsed.items
        : accountId&&Array.isArray(parsed) ? parsed : null;
      if(selected){
        explicit=true;
        const safe=selected.map((item:any)=>typeof item==="string"?{id:item}:{id:String(item?.id||""),...(item?.name?{name:String(item.name).slice(0,200)}:{}),...(item?.color?{color:String(item.color).slice(0,30)}:{})}).filter((item:{id:string})=>item.id&&item.id.length<=1024);
        enabled=safe.map((item:{id:string})=>item.id).filter((id:string)=>live.has(id));
        if(Array.isArray(parsed))saveSetting("google_enabled_calendars",JSON.stringify({accountId,items:safe}));
      }
    } catch {}
    return {items,enabled,explicit,version:calendarSelectionVersion("google",accountId,connectionId)};
}

export async function GET() {
  if (!isGoogleConnected()) return Response.json({ items: [],enabled:[],version:"" });
  try {
    return Response.json(await googleCalendarCatalog(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    const accountId=setting("google_account_id"),connectionId=setting("google_connection_generation")||"legacy";
    if(!isGoogleConnected()||!accountId)return Response.json({error:"Google paskyra neprijungta."},{status:401});
    const version=calendarSelectionVersion("google",accountId,connectionId);
    if(body.version!==version)return Response.json({error:"Google paskyra arba kalendorių katalogas pasikeitė. Atnaujink kalendorius."},{status:409});
    if (!Array.isArray(body.enabled) || body.enabled.some((c: unknown) => typeof (c as any)?.id !== "string" || !(c as any).id || (c as any).id.length > 1024))
      return Response.json({ error: "Neteisingas kalendorių sąrašas." }, { status: 400 });
    const safe = (body.enabled as any[]).map((c: any) => ({id:String(c.id),...(c.name?{name:String(c.name).slice(0,200)}:{}),...(c.color?{color:String(c.color).slice(0,30)}:{})}));
    saveSetting("google_enabled_calendars", JSON.stringify({accountId,items:safe}));
    return Response.json({ ok: true,version });
  } catch (error) { return apiError(error); }
}
