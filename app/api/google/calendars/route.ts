import { requireUserContext } from "@/lib/db-multi";
import { googleFetchForUser } from "@/lib/google";
import { apiError, assertSameOrigin } from "@/lib/http";
import { calendarSelectionVersion } from "@/lib/calendar-selection";
import { getCalendarSelection, replaceCalendarSelection, CalendarPreferenceError } from "@/lib/calendar-preferences";
import { listConnections, getConnectionById, type OAuthConnectionRow } from "@/lib/oauth-service";
import { allSettledLimited, calendarAccountError, calendarAccountLabel } from "@/lib/calendar-multi";
import { resolveLegacyCalendarSelection, writeLegacyCalendarSelection } from "@/lib/calendar-legacy";

export const runtime = "nodejs";
type Item = { id: string; name: string; color?: string; primary?: boolean; writable: boolean };

export async function googleCalendarCatalogForConnection(userId: number, connection: OAuthConnectionRow) {
  let next: string | null = "/users/me/calendarList?maxResults=250";
  const items: Item[] = [], visited = new Set<string>();
  while (next) {
    if (visited.has(next)) break;
    visited.add(next);
    const page = await googleFetchForUser(userId, connection, next);
    for (const cal of page.items || []) items.push({ id: String(cal.id), name: String(cal.summary || cal.id), color: cal.backgroundColor || undefined, primary: Boolean(cal.primary), writable: cal.accessRole === "owner" || cal.accessRole === "writer" });
    next = page.nextPageToken ? `/users/me/calendarList?maxResults=250&pageToken=${encodeURIComponent(page.nextPageToken)}` : null;
  }
  const current = getConnectionById(userId, connection.id, "google");
  if (!current || current.status !== "active" || current.provider_account_id !== connection.provider_account_id) throw Object.assign(new Error("Google paskyra pasikeitė. Atnaujink kalendorius."), { status: 409 });
  const overlay = resolveLegacyCalendarSelection(userId, connection.id, connection.provider_account_id, "google");
  const selection = overlay?.selection ?? getCalendarSelection(userId, connection.id), live = new Set(items.map(item => item.id));
  const enabled = selection.explicit ? selection.items.filter(item => item.enabled && live.has(item.calendar_id)).map(item => item.calendar_id) : items.filter(item => item.primary).map(item => item.id);
  return { provider: "google" as const, connectionId: String(connection.id), accountId: connection.provider_account_id, email: connection.provider_email, label: calendarAccountLabel(connection), colorKey: connection.color_key, items, enabled, explicit: selection.explicit, version: calendarSelectionVersion("google", connection.provider_account_id, String(connection.id),selection) };
}

export async function googleCalendarCatalog(userId: number) {
  const active = listConnections(userId, "google").filter(c => c.status === "active");
  if (active.length !== 1) throw Object.assign(new Error("Pasirink konkrečią Google paskyrą."), { status: 409 });
  return googleCalendarCatalogForConnection(userId, active[0]);
}

export async function GET(request: Request) {
  try {
    const user = requireUserContext(request), connections = listConnections(user.id, "google").filter(c => c.status === "active");
    if (!connections.length) return Response.json({ accounts: [], items: [], enabled: [], errors: [], version: "" });
    const settled = await allSettledLimited(connections, 3, connection => googleCalendarCatalogForConnection(user.id, connection));
    const accounts = settled.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    const errors = settled.flatMap((result, index) => result.status === "rejected" ? [calendarAccountError(connections[index], result.reason)] : []);
    if (!accounts.length && connections.length === 1) throw (settled[0] as PromiseRejectedResult).reason;
    const sole = accounts.length === 1 ? accounts[0] : null;
    return Response.json({ accounts, items: sole?.items ?? [], enabled: sole?.enabled ?? [], explicit: sole?.explicit ?? false, version: sole?.version ?? "", errors }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { if (error instanceof Response) return error; return apiError(error); }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const user = requireUserContext(request), body = await request.json(), active = listConnections(user.id, "google").filter(c => c.status === "active");
    const connectionId = Number(body.connectionId ?? (active.length === 1 ? active[0].id : NaN));
    const connection = Number.isSafeInteger(connectionId) ? getConnectionById(user.id, connectionId, "google") : null;
    if (!connection || connection.status !== "active") return Response.json({ error: "Google paskyra neprijungta." }, { status: 409 });
    if (!Array.isArray(body.enabled)) return Response.json({ error: "Neteisingas kalendorių sąrašas." }, { status: 400 });
    // Resolve the version from the catalog so a legacy overlay and the client
    // agree on the current selection version.
    const catalog = await googleCalendarCatalogForConnection(user.id, connection), live = new Set(catalog.items.map(item => item.id));
    if (body.version !== catalog.version) return Response.json({ error: "Google paskyra arba kalendorių katalogas pasikeitė. Atnaujink kalendorius." }, { status: 409 });
    if (body.enabled.some((item:any) => typeof item?.id !== "string" || !live.has(item.id))) return Response.json({error:"Kalendorius šiai paskyrai nepriklauso."},{status:409});
    const selection = replaceCalendarSelection(user.id, connection.id, connection.provider_account_id, body.enabled.map((item:any) => ({id:item.id, color_override:item.color_override})), "google");
    writeLegacyCalendarSelection(user.id, "google", connection.provider_account_id, selection.items.filter(item=>item.enabled).map(item=>({id:item.calendar_id})));
    return Response.json({ ok: true, connectionId: String(connection.id), version:calendarSelectionVersion("google",connection.provider_account_id,String(connection.id),selection), enabled: selection.items.filter(item=>item.enabled).map(item=>item.calendar_id) });
  } catch (error) { if (error instanceof Response) return error; if (error instanceof CalendarPreferenceError) return Response.json({error:error.message},{status:error.status}); return apiError(error); }
}
