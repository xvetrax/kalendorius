import {
  CalendarError,
  calendarIdentifier,
  createCalendarService,
  eventDates,
  eventTimes,
} from "@/lib/calendar-events";
import { calendarCreateIdentity, calendarCreateOperationId } from "@/lib/calendar-create";
import { graphCalendarRecurrence, parseCalendarRecurrence } from "@/lib/calendar-recurrence";
import { isCalendarTimeZone, matchingCalendarTimeZone } from "@/lib/calendar-time-zone";
import { requireUserContext } from "@/lib/db-multi";
import { userSetting, reserveCalendarEventCreate } from "@/lib/db";
import {
  OUTLOOK_DEFAULT_CALENDAR_SETTING,
  outlookDefaultCalendarId,
  outlookMirrorTaskKey,
} from "@/lib/outlook-mirror-link";
import { graphFetchForUser, isMicrosoftConnectedForUser } from "@/lib/microsoft";
import { apiError, assertSameOrigin } from "@/lib/http";
import { buildOutlookEvent } from "@/lib/planning";
import { calendarSelectionVersion } from "@/lib/calendar-selection";
import { getConnection, type OAuthConnectionRow } from "@/lib/oauth-service";
import { db } from "@/lib/db";
import { microsoftCalendarCatalog } from "../calendars/route.ts";

export const runtime = "nodejs";

function failure(error: unknown) {
  return error instanceof CalendarError
    ? Response.json({ error: error.message }, { status: error.status })
    : apiError(error);
}

function makeMicrosoftCalendarService(userId: number, conn: OAuthConnectionRow) {
  const connectionId = String(conn.id);
  const accountId = conn.provider_account_id;
  return createCalendarService("outlook", {
    connection: () => {
      const c = getConnection(userId, "microsoft");
      return c && c.id === conn.id && c.status === "active" ? connectionId : null;
    },
    request: (path: string, init?: RequestInit) =>
      graphFetchForUser(userId, conn, path, init),
    mirrorTaskKey: (raw: any, calendarId: string) => {
      const defaultCalSetting = userSetting(userId, OUTLOOK_DEFAULT_CALENDAR_SETTING);
      const defaultCalId = outlookDefaultCalendarId(defaultCalSetting, accountId, connectionId);
      return outlookMirrorTaskKey(db, userId, conn.id, accountId, calendarId, defaultCalId, raw);
    },
  });
}

function enabledCalendars(
  userId: number,
  accountId: string,
): { id: string; name?: string; color?: string }[] | undefined {
  const stored = userSetting(userId, "microsoft_enabled_calendars");
  if (!stored || !accountId) return undefined;
  try {
    const parsed = JSON.parse(stored);
    return parsed?.accountId === accountId && Array.isArray(parsed.items)
      ? parsed.items
          .map((c: any) => ({
            id: String(c.id || ""),
            name: c.name || undefined,
            color: c.color || undefined,
          }))
          .filter((c: { id: string }) => c.id)
      : undefined;
  } catch {
    return undefined;
  }
}

async function ensureDefaultCalendarIdentity(
  userId: number,
  conn: OAuthConnectionRow,
  accountId: string,
  connectionId: string,
  calendars: { id: string }[] | undefined,
) {
  if (
    !accountId ||
    !calendars?.some((calendar) => calendar.id !== "primary") ||
    outlookDefaultCalendarId(userSetting(userId, OUTLOOK_DEFAULT_CALENDAR_SETTING), accountId, connectionId)
  )
    return;

  const current = await graphFetchForUser(userId, conn, "/me/calendar?$select=id");
  const afterConn = getConnection(userId, "microsoft");
  if (!current?.id || !afterConn || afterConn.id !== conn.id) {
    throw new CalendarError("Microsoft paskyra pasikeitė. Atnaujink kalendorių.", 409);
  }

  const { saveUserSetting } = await import("@/lib/db");
  saveUserSetting(
    userId,
    OUTLOOK_DEFAULT_CALENDAR_SETTING,
    JSON.stringify([accountId, connectionId, String(current.id)]),
  );
}

export async function GET(request: Request) {
  try {
    const user = requireUserContext(request);
    if (!isMicrosoftConnectedForUser(user.id)) return Response.json({ items: [] });

    const conn = getConnection(user.id, "microsoft");
    if (!conn) return Response.json({ items: [] });

    const input = new URL(request.url).searchParams;

    const seriesId = input.get("seriesId");
    if (seriesId) {
      const calendar = makeMicrosoftCalendarService(user.id, conn);
      return Response.json(await calendar.series(Object.fromEntries(input)));
    }

    const accountId = conn.provider_account_id;
    const connectionId = String(conn.id);
    const version = calendarSelectionVersion("microsoft", accountId, connectionId);
    const catalog = await microsoftCalendarCatalog(user.id);
    const enabled = new Set(catalog.enabled);

    if (catalog.version !== version) {
      throw new CalendarError("Microsoft paskyra pasikeitė. Atnaujink kalendorių.", 409);
    }

    const calendars = catalog.explicit
      ? catalog.items
          .filter((item) => enabled.has(item.id))
          .map((item) => ({
            id: item.isDefault && catalog.defaultAlias ? "primary" : item.id,
            name: item.name,
            color: item.color,
          }))
      : undefined;

    await ensureDefaultCalendarIdentity(user.id, conn, accountId, connectionId, calendars);

    const calendar = makeMicrosoftCalendarService(user.id, conn);
    const items = await calendar.list(
      input.get("timeMin") || new Date().toISOString(),
      input.get("timeMax") || new Date(Date.now() + 7 * 864e5).toISOString(),
      calendars,
      connectionId,
    );

    const afterConn = getConnection(user.id, "microsoft");
    if (
      !afterConn ||
      afterConn.id !== conn.id ||
      calendarSelectionVersion("microsoft", afterConn.provider_account_id, String(afterConn.id)) !==
        version
    ) {
      throw new CalendarError("Microsoft paskyra pasikeitė. Atnaujink kalendorių.", 409);
    }

    return Response.json({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof Response) return error;
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = requireUserContext(request);
    const body = await request.json();

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new CalendarError("Neteisingi įvykio duomenys.");
    }
    if (!String(body.summary || "").trim() || !body.start || !body.end) {
      return Response.json({ error: "Trūksta pavadinimo arba laiko" }, { status: 400 });
    }

    const conn = getConnection(user.id, "microsoft");
    if (!isMicrosoftConnectedForUser(user.id) || !conn) {
      throw new CalendarError("Microsoft paskyra neprijungta.", 409);
    }

    const connectionId = String(conn.id);
    const accountId = conn.provider_account_id;
    const calendarId = calendarIdentifier(body.calendarId);

    let operationId: string;
    try {
      operationId = calendarCreateOperationId(body.operationId);
    } catch (error) {
      throw new CalendarError(
        error instanceof Error ? error.message : "Neteisingas operacijos ID.",
      );
    }

    if (
      body.calendarVersion !==
      calendarSelectionVersion("microsoft", accountId, connectionId)
    ) {
      throw new CalendarError(
        "Microsoft paskyra arba kalendorių katalogas pasikeitė. Atnaujink kalendorius.",
        409,
      );
    }

    const enabled = enabledCalendars(user.id, accountId);
    const exactSelection = enabled?.some((calendar) => calendar.id === calendarId) ?? false;
    const legacyDefault = enabled?.some((calendar) => calendar.id === "primary") ?? false;
    if (enabled && !exactSelection && !legacyDefault) {
      throw new CalendarError("Pasirinktas Microsoft kalendorius neįjungtas nustatymuose.", 409);
    }

    if (body.allDay) {
      if (body.timeZone !== undefined) {
        throw new CalendarError("Visos dienos įvykiui laiko zona nesiunčiama.");
      }
      const dates = eventDates(body.start, body.end);
      body.start = dates.start;
      body.end = dates.end;
    } else {
      const times = eventTimes(body.start, body.end);
      const requested = body.timeZone === undefined ? "UTC" : body.timeZone;
      if (!isCalendarTimeZone(requested)) {
        throw new CalendarError("Pasirink galiojančią IANA laiko zoną.");
      }
      body.start = times.start;
      body.end = times.end;
      body.timeZone = requested;
      if (requested !== "UTC") {
        const supported = await graphFetchForUser(
          user.id,
          conn,
          "/me/outlook/supportedTimeZones(TimeZoneStandard=microsoft.graph.timeZoneStandard'Iana')",
        );
        const afterConn = getConnection(user.id, "microsoft");
        if (!afterConn || afterConn.id !== conn.id) {
          throw new CalendarError("Microsoft paskyra pasikeitė. Atnaujink kalendorių.", 409);
        }
        if (!Array.isArray(supported?.value)) {
          throw new CalendarError("Microsoft negrąžino palaikomų laiko zonų.", 502);
        }
        const matched = matchingCalendarTimeZone(
          requested,
          supported.value.map((item: any) => item?.alias),
        );
        if (!matched) {
          throw new CalendarError("Microsoft pašto dėžutė nepalaiko pasirinktos laiko zonos.");
        }
        body.timeZone = matched;
      }
    }

    let event: Record<string, unknown>;
    try {
      event = buildOutlookEvent(body);
    } catch (error) {
      throw new CalendarError(
        error instanceof Error ? error.message : "Neteisingas įvykio laikas.",
      );
    }

    const recurrenceContext = {
      startDate: body.allDay
        ? String(body.start)
        : String((event.start as { dateTime: string }).dateTime).slice(0, 10),
      allDay: Boolean(body.allDay),
      ...(!body.allDay
        ? {
            timeZone: String(body.timeZone || "UTC"),
            providerTimeZone: String(body.timeZone || "UTC"),
          }
        : { providerTimeZone: "UTC" }),
    };

    const recurrence =
      body.recurrence === undefined || body.recurrence === null
        ? null
        : parseCalendarRecurrence(body.recurrence, recurrenceContext);
    if (body.recurrence !== undefined && body.recurrence !== null && !recurrence) {
      throw new CalendarError("Neteisinga kartojimo taisyklė.");
    }
    if (recurrence) event.recurrence = graphCalendarRecurrence(recurrence, recurrenceContext);

    const identity = calendarCreateIdentity(
      "outlook",
      accountId,
      connectionId,
      calendarId,
      operationId,
      event,
    );
    event.transactionId = identity.transactionId;

    const selected = await graphFetchForUser(
      user.id,
      conn,
      `/me/calendars/${encodeURIComponent(calendarId)}?$select=id,canEdit,isDefaultCalendar`,
    );

    const afterConn = getConnection(user.id, "microsoft");
    if (!afterConn || afterConn.id !== conn.id) {
      throw new CalendarError("Microsoft paskyra pasikeitė. Atnaujink kalendorių.", 409);
    }

    if (selected?.id !== calendarId) {
      throw new CalendarError("Microsoft grąžino kitą kalendorių. Atnaujink kalendorių sąrašą.", 502);
    }
    if (enabled && !exactSelection && !(legacyDefault && selected.isDefaultCalendar === true)) {
      throw new CalendarError("Pasirinktas Microsoft kalendorius neįjungtas nustatymuose.", 409);
    }
    if (enabled === undefined && selected.isDefaultCalendar !== true) {
      throw new CalendarError("Pasirinktas Microsoft kalendorius neįjungtas nustatymuose.", 409);
    }
    if (selected.canEdit !== true) {
      throw new CalendarError("Pasirinktame Microsoft kalendoriuje nėra rašymo teisės.", 403);
    }

    if (
      !reserveCalendarEventCreate(
        "outlook",
        accountId,
        connectionId,
        calendarId,
        operationId,
        identity.fingerprint,
        user.id,
      )
    ) {
      throw new CalendarError(
        "Ši kūrimo operacija jau pradėta su kitais įvykio duomenimis. Atverk naują įvykio langą.",
        409,
      );
    }

    const data = await graphFetchForUser(
      user.id,
      conn,
      `/me/calendars/${encodeURIComponent(calendarId)}/events`,
      { method: "POST", body: JSON.stringify(event) },
    );

    const finalConn = getConnection(user.id, "microsoft");
    if (!finalConn || finalConn.id !== conn.id) {
      throw new CalendarError("Microsoft paskyra pasikeitė. Atnaujink kalendorių.", 409);
    }

    return Response.json(data, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const user = requireUserContext(request);
    const conn = getConnection(user.id, "microsoft");
    if (!conn) throw new CalendarError("Microsoft paskyra neprijungta.", 409);
    const calendar = makeMicrosoftCalendarService(user.id, conn);
    await calendar.remove(Object.fromEntries(new URL(request.url).searchParams));
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return failure(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const user = requireUserContext(request);
    const conn = getConnection(user.id, "microsoft");
    if (!conn) throw new CalendarError("Microsoft paskyra neprijungta.", 409);
    const calendar = makeMicrosoftCalendarService(user.id, conn);
    const body = await request.json();
    return Response.json(
      body?.scope === "series"
        ? await calendar.updateSeries(body)
        : await calendar.update(body),
    );
  } catch (error) {
    if (error instanceof Response) return error;
    return failure(error);
  }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const user = requireUserContext(request);
    const conn = getConnection(user.id, "microsoft");
    if (!conn) throw new CalendarError("Microsoft paskyra neprijungta.", 409);
    const calendar = makeMicrosoftCalendarService(user.id, conn);
    return Response.json(await calendar.respond(await request.json()));
  } catch (error) {
    if (error instanceof Response) return error;
    return failure(error);
  }
}
