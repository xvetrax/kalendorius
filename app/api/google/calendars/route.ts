import { requireUserContext } from "@/lib/db-multi";
import { saveUserSetting, userSetting } from "@/lib/db";
import { googleFetchForUser, isGoogleConnectedForUser } from "@/lib/google";
import { apiError, assertSameOrigin } from "@/lib/http";
import { calendarSelectionVersion } from "@/lib/calendar-selection";
import { getConnection } from "@/lib/oauth-service";

export const runtime = "nodejs";

export async function googleCalendarCatalog(userId: number) {
  const conn = getConnection(userId, "google");
  if (!conn || conn.status !== "active") {
    throw Object.assign(new Error("Google paskyra neprijungta."), { status: 409 });
  }

  const accountId = conn.provider_account_id;
  const connectionId = String(conn.id);

  let next: string | null = "/users/me/calendarList?maxResults=250";
  const items: { id: string; name: string; color?: string; primary?: boolean; writable: boolean }[] = [];
  const visited = new Set<string>();
  while (next) {
    if (visited.has(next)) break;
    visited.add(next);
    const page = await googleFetchForUser(userId, conn, next);
    for (const cal of page.items || []) {
      items.push({
        id: String(cal.id),
        name: String(cal.summary || cal.id),
        color: cal.backgroundColor || undefined,
        primary: Boolean(cal.primary),
        writable: cal.accessRole === "owner" || cal.accessRole === "writer",
      });
    }
    const token = page.nextPageToken;
    next = token
      ? `/users/me/calendarList?maxResults=250&pageToken=${encodeURIComponent(token)}`
      : null;
  }

  // Verify connection is still the same user's connection
  const after = getConnection(userId, "google");
  if (!after || after.id !== conn.id) {
    throw Object.assign(new Error("Google paskyra pasikeitė. Atnaujink kalendorius."), { status: 409 });
  }

  // Per-user calendar selection stored in user_settings
  const settingKey = `google_enabled_calendars`;
  const stored = userSetting(userId, settingKey);
  let enabled = items.filter((item) => item.primary).map((item) => item.id);
  let explicit = false;
  try {
    const parsed = stored ? JSON.parse(stored) : null;
    const live = new Set(items.map((item) => item.id));
    const selected =
      parsed?.accountId === accountId && Array.isArray(parsed.items)
        ? parsed.items
        : accountId && Array.isArray(parsed)
          ? parsed
          : null;
    if (selected) {
      explicit = true;
      const safe = selected
        .map((item: any) =>
          typeof item === "string"
            ? { id: item }
            : {
                id: String(item?.id || ""),
                ...(item?.name ? { name: String(item.name).slice(0, 200) } : {}),
                ...(item?.color ? { color: String(item.color).slice(0, 30) } : {}),
              },
        )
        .filter((item: { id: string }) => item.id && item.id.length <= 1024);
      enabled = safe
        .map((item: { id: string }) => item.id)
        .filter((id: string) => live.has(id));
      // Migrate old array format to new keyed format
      if (Array.isArray(parsed)) {
        saveUserSetting(userId, settingKey, JSON.stringify({ accountId, items: safe }));
      }
    }
  } catch {}

  return {
    items,
    enabled,
    explicit,
    version: calendarSelectionVersion("google", accountId, connectionId),
  };
}

export async function GET(request: Request) {
  try {
    const user = requireUserContext(request);
    if (!isGoogleConnectedForUser(user.id)) {
      return Response.json({ items: [], enabled: [], version: "" });
    }
    return Response.json(await googleCalendarCatalog(user.id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const user = requireUserContext(request);
    const body = await request.json();

    const conn = getConnection(user.id, "google");
    if (!isGoogleConnectedForUser(user.id) || !conn) {
      return Response.json({ error: "Google paskyra neprijungta." }, { status: 401 });
    }

    const accountId = conn.provider_account_id;
    const connectionId = String(conn.id);
    const version = calendarSelectionVersion("google", accountId, connectionId);

    if (body.version !== version) {
      return Response.json(
        { error: "Google paskyra arba kalendorių katalogas pasikeitė. Atnaujink kalendorius." },
        { status: 409 },
      );
    }

    if (
      !Array.isArray(body.enabled) ||
      body.enabled.some(
        (c: unknown) =>
          typeof (c as any)?.id !== "string" ||
          !(c as any).id ||
          (c as any).id.length > 1024,
      )
    ) {
      return Response.json({ error: "Neteisingas kalendorių sąrašas." }, { status: 400 });
    }

    const safe = (body.enabled as any[]).map((c: any) => ({
      id: String(c.id),
      ...(c.name ? { name: String(c.name).slice(0, 200) } : {}),
      ...(c.color ? { color: String(c.color).slice(0, 30) } : {}),
    }));

    saveUserSetting(
      user.id,
      "google_enabled_calendars",
      JSON.stringify({ accountId, items: safe }),
    );
    return Response.json({ ok: true, version });
  } catch (error) {
    if (error instanceof Response) return error;
    return apiError(error);
  }
}
