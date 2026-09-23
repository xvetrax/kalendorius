import { deleteSettings, saveSetting, setting } from "@/lib/db";
import { graphFetch, isMicrosoftConnected } from "@/lib/microsoft";
import { apiError, assertSameOrigin } from "@/lib/http";
import { OUTLOOK_DEFAULT_CALENDAR_SETTING } from "@/lib/outlook-mirror-link";

export const runtime = "nodejs";

const outlookColors: Record<string, string> = {
  lightBlue: "#74b7e8", lightGreen: "#57a55a", lightOrange: "#e8975b",
  lightGray: "#9e9e9e", lightYellow: "#e8c85b", lightTeal: "#4db6ac",
  lightPink: "#e87494", lightBrown: "#a07850", lightRed: "#e85b5b",
  lightMagenta: "#b04db6", auto: "#0078d4",
};

export async function GET() {
  if (!isMicrosoftConnected()) return Response.json({ items: [] });
  try {
    const accountId=setting("microsoft_account_id"),connectionId=setting("microsoft_connection_generation") || "legacy";
    const items: {id:string;name:string;color?:string;isDefault?:boolean;writable:boolean}[] = [];
    let next: string | null = "/me/calendars?$top=50&$select=id,name,color,isDefaultCalendar,canEdit";
    const visited = new Set<string>();
    while (next) {
      if (visited.has(next)) break;
      visited.add(next);
      const page = await graphFetch(next);
      for (const cal of page.value || []) {
        items.push({id:String(cal.id),name:String(cal.name||cal.id),color:outlookColors[cal.color]||undefined,isDefault:Boolean(cal.isDefaultCalendar),writable:Boolean(cal.canEdit)});
      }
      const link = page["@odata.nextLink"] || null;
      if (link) {
        const url = new URL(link);
        if (url.origin !== "https://graph.microsoft.com" || url.username || url.password || url.hash) break;
        next = url.pathname.slice(5) + url.search;
      } else next = null;
    }
    if (!isMicrosoftConnected() || setting("microsoft_account_id")!==accountId || (setting("microsoft_connection_generation") || "legacy")!==connectionId)
      return Response.json({error:"Microsoft paskyra pasikeitė. Atnaujink kalendorius."},{status:409});
    const primary=items.find(item=>item.isDefault);
    if (primary && accountId) saveSetting(OUTLOOK_DEFAULT_CALENDAR_SETTING,JSON.stringify([accountId,connectionId,primary.id]));
    else deleteSettings(OUTLOOK_DEFAULT_CALENDAR_SETTING);
    const stored = setting("microsoft_enabled_calendars");
    let enabled:string[]|null=null;
    try {const parsed=stored ? JSON.parse(stored) : null;if(parsed?.accountId===accountId&&Array.isArray(parsed.items))enabled=parsed.items.map((item:any)=>String(item.id||"")).filter(Boolean);} catch {}
    return Response.json({ items, enabled }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    const accountId=setting("microsoft_account_id");
    if (!isMicrosoftConnected() || !accountId) return Response.json({error:"Microsoft paskyra neprijungta."},{status:401});
    if (!Array.isArray(body.enabled) || body.enabled.some((c: unknown) => typeof (c as any)?.id !== "string" || !(c as any).id || (c as any).id.length > 1024))
      return Response.json({ error: "Neteisingas kalendorių sąrašas." }, { status: 400 });
    const safe = (body.enabled as any[]).map((c: any) => ({id:String(c.id),...(c.name?{name:String(c.name).slice(0,200)}:{}),...(c.color?{color:String(c.color).slice(0,30)}:{})}));
    saveSetting("microsoft_enabled_calendars", JSON.stringify({accountId,items:safe}));
    return Response.json({ ok: true });
  } catch (error) { return apiError(error); }
}
