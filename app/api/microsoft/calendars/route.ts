import { saveSetting, setting } from "@/lib/db";
import { graphFetch, isMicrosoftConnected } from "@/lib/microsoft";
import { apiError, assertSameOrigin } from "@/lib/http";

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
    const stored = setting("microsoft_enabled_calendars");
    const enabled: string[] = stored ? JSON.parse(stored) : null;
    return Response.json({ items, enabled }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    if (!Array.isArray(body.enabled) || body.enabled.some((c: unknown) => typeof (c as any)?.id !== "string" || !(c as any).id || (c as any).id.length > 1024))
      return Response.json({ error: "Neteisingas kalendorių sąrašas." }, { status: 400 });
    const safe = (body.enabled as any[]).map((c: any) => ({id:String(c.id),...(c.name?{name:String(c.name).slice(0,200)}:{}),...(c.color?{color:String(c.color).slice(0,30)}:{})}));
    saveSetting("microsoft_enabled_calendars", JSON.stringify(safe));
    return Response.json({ ok: true });
  } catch (error) { return apiError(error); }
}
