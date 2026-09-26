import { requireUserContext } from "@/lib/db-multi";
import { saveUserSetting, userSetting, deleteUserSettings } from "@/lib/db";
import { graphFetchForUser, isMicrosoftConnectedForUser } from "@/lib/microsoft";
import { apiError, assertSameOrigin } from "@/lib/http";
import { OUTLOOK_DEFAULT_CALENDAR_SETTING } from "@/lib/outlook-mirror-link";
import { calendarSelectionVersion } from "@/lib/calendar-selection";
import { getConnection } from "@/lib/oauth-service";

export const runtime = "nodejs";

const outlookColors: Record<string, string> = {
  lightBlue: "#74b7e8",
  lightGreen: "#57a55a",
  lightOrange: "#e8975b",
  lightGray: "#9e9e9e",
  lightYellow: "#e8c85b",
  lightTeal: "#4db6ac",
  lightPink: "#e87494",
  lightBrown: "#a07850",
  lightRed: "#e85b5b",
  lightMagenta: "#b04db6",
  auto: "#0078d4",
};

export async function microsoftCalendarCatalog(userId: number) {
  const conn = getConnection(userId, "microsoft");
  if (!conn || conn.status !== "active") {
    throw Object.assign(new Error("Microsoft paskyra neprijungta."), { status: 409 });
  }

  const accountId = conn.provider_account_id;
  const connectionId = String(conn.id);

  const items: { id: string; name: string; color?: string; isDefault?: boolean; writable: boolean }[] = [];
  let next: string | null =
    "/me/calendars?$top=50&$select=id,name,color,isDefaultCalendar,canEdit";
  const visited = new Set<string>();
  while (next) {
    if (visited.has(next)) break;
    visited.add(next);
    const page = await graphFetchForUser(userId, conn, next);
    for (const cal of page.value || []) {
      items.push({
        id: String(cal.id),
        name: String(cal.name || cal.id),
        color: outlookColors[cal.color] || undefined,
        isDefault: Boolean(cal.isDefaultCalendar),
        writable: Boolean(cal.canEdit),
      });
    }
    const link = page["@odata.nextLink"] || null;
    if (link) {
      const url = new URL(link);
      if (
        url.origin !== "https://graph.microsoft.com" ||
        url.username ||
        url.password ||
        url.hash
      )
        break;
      next = url.pathname.slice(5) + url.search;
    } else {
      next = null;
    }
  }

  // Verify connection still belongs to this user
  const after = getConnection(userId, "microsoft");
  if (!after || after.id !== conn.id) {
    throw Object.assign(
      new Error("Microsoft paskyra pasikeitė. Atnaujink kalendorius."),
      { status: 409 },
    );
  }

  // Track default calendar in per-user settings
  const primary = items.find((item) => item.isDefault);
  if (primary && accountId) {
    saveUserSetting(
      userId,
      OUTLOOK_DEFAULT_CALENDAR_SETTING,
      JSON.stringify([accountId, connectionId, primary.id]),
    );
  } else {
    deleteUserSettings(userId, OUTLOOK_DEFAULT_CALENDAR_SETTING);
  }

  const stored = userSetting(userId, "microsoft_enabled_calendars");
  let enabled = items.filter((item) => item.isDefault).map((item) => item.id);
  let explicit = false;
  let defaultAlias = false;

  try {
    const parsed = stored ? JSON.parse(stored) : null;
    const live = new Set(items.map((item) => item.id));
    const defaultId = items.find((item) => item.isDefault)?.id;
    if (parsed?.accountId === accountId && Array.isArray(parsed.items)) {
      explicit = true;
      defaultAlias = parsed.items.some((item: any) => String(item.id || "") === "primary");
      enabled = parsed.items
        .map((item: any) =>
          String(item.id || "") === "primary" && defaultId ? defaultId : String(item.id || ""),
        )
        .filter((id: string) => live.has(id));
    }
  } catch {}

  return {
    items,
    enabled,
    explicit,
    defaultAlias,
    version: calendarSelectionVersion("microsoft", accountId, connectionId),
  };
}

export async function GET(request: Request) {
  try {
    const user = requireUserContext(request);
    if (!isMicrosoftConnectedForUser(user.id)) {
      return Response.json({ items: [], enabled: [], version: "" });
    }
    return Response.json(await microsoftCalendarCatalog(user.id), {
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

    const conn = getConnection(user.id, "microsoft");
    if (!isMicrosoftConnectedForUser(user.id) || !conn) {
      return Response.json({ error: "Microsoft paskyra neprijungta." }, { status: 401 });
    }

    const accountId = conn.provider_account_id;
    const connectionId = String(conn.id);
    const version = calendarSelectionVersion("microsoft", accountId, connectionId);

    if (body.version !== version) {
      return Response.json(
        {
          error: "Microsoft paskyra arba kalendorių katalogas pasikeitė. Atnaujink kalendorius.",
        },
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
      "microsoft_enabled_calendars",
      JSON.stringify({ accountId, items: safe }),
    );
    return Response.json({ ok: true, version });
  } catch (error) {
    if (error instanceof Response) return error;
    return apiError(error);
  }
}
