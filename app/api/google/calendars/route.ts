import { saveSetting, setting } from "@/lib/db";
import { googleFetch, isGoogleConnected } from "@/lib/google";
import { apiError, assertSameOrigin } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  if (!isGoogleConnected()) return Response.json({ items: [] });
  try {
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
    const stored = setting("google_enabled_calendars");
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
    saveSetting("google_enabled_calendars", JSON.stringify(safe));
    return Response.json({ ok: true });
  } catch (error) { return apiError(error); }
}
