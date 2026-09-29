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
import { graphFetchForUser } from "@/lib/microsoft";
import { apiError, assertSameOrigin } from "@/lib/http";
import { buildOutlookEvent } from "@/lib/planning";
import { calendarSelectionVersion } from "@/lib/calendar-selection";
import { getConnection, getConnectionById, listConnections, type OAuthConnectionRow } from "@/lib/oauth-service";
import { db } from "@/lib/db";
import { microsoftCalendarCatalogForConnection, outlookDefaultCalendarSetting } from "../calendars/route.ts";
import { allSettledLimited, calendarAccountError } from "@/lib/calendar-multi";

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
      const c = getConnectionById(userId, conn.id, "microsoft");
      return c && c.id === conn.id && c.status === "active" ? connectionId : null;
    },
    request: (path: string, init?: RequestInit) =>
      graphFetchForUser(userId, conn, path, init),
    mirrorTaskKey: (raw: any, calendarId: string) => {
      const defaultCalSetting = userSetting(userId, outlookDefaultCalendarSetting(connectionId)) || userSetting(userId, OUTLOOK_DEFAULT_CALENDAR_SETTING);
      const defaultCalId = outlookDefaultCalendarId(defaultCalSetting, accountId, connectionId);
      return outlookMirrorTaskKey(db, userId, conn.id, accountId, calendarId, defaultCalId, raw);
    },
  });
}

function microsoftConnection(userId:number,raw:unknown){
  if(raw!==undefined&&raw!==null&&raw!==""){const id=Number(raw);return Number.isSafeInteger(id)?getConnectionById(userId,id,"microsoft"):null;}
  return getConnection(userId,"microsoft");
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
    outlookDefaultCalendarId(userSetting(userId, outlookDefaultCalendarSetting(connectionId)) || userSetting(userId, OUTLOOK_DEFAULT_CALENDAR_SETTING), accountId, connectionId)
  )
    return;

  const current = await graphFetchForUser(userId, conn, "/me/calendar?$select=id");
  const afterConn = getConnectionById(userId, conn.id, "microsoft");
  if (!current?.id || !afterConn || afterConn.id !== conn.id) {
    throw new CalendarError("Microsoft paskyra pasikeitė. Atnaujink kalendorių.", 409);
  }

  const { saveUserSetting } = await import("@/lib/db");
  saveUserSetting(
    userId,
    outlookDefaultCalendarSetting(connectionId),
    JSON.stringify([accountId, connectionId, String(current.id)]),
  );
}

export async function GET(request: Request) {
  try {
    const user = requireUserContext(request);
    const input = new URL(request.url).searchParams;
    const seriesId = input.get("seriesId");
    if (seriesId) {
      const connectionId=Number(input.get("connectionId")),conn=Number.isSafeInteger(connectionId)?getConnectionById(user.id,connectionId,"microsoft"):null;
      if(!conn||conn.status!=="active")throw new CalendarError("Pasirink konkrečią Microsoft paskyrą.",409);
      return Response.json(await makeMicrosoftCalendarService(user.id,conn).series(Object.fromEntries(input)));
    }
    const connections=listConnections(user.id,"microsoft").filter(conn=>conn.status==="active");
    if(!connections.length)return Response.json({items:[],errors:[],loadedConnectionIds:[]});
    const settled=await allSettledLimited(connections,3,async conn=>{
      const catalog=await microsoftCalendarCatalogForConnection(user.id,conn),enabled=new Set(catalog.enabled);
      // A legacy "primary" selection aliases the live default calendar; list it
      // through the /me/calendarView default path (id "primary") so its events
      // keep the "primary" calendar identity older clients expect.
      const calendars=catalog.explicit?catalog.items.filter(item=>enabled.has(item.id)).map(item=>({id:item.isDefault&&catalog.defaultAlias?"primary":item.id,name:item.name,color:item.color})):undefined;
      const defaultColor=!catalog.explicit?catalog.items.find(item=>item.isDefault)?.color:undefined;
      await ensureDefaultCalendarIdentity(user.id,conn,conn.provider_account_id,String(conn.id),calendars);
      const rawItems=await makeMicrosoftCalendarService(user.id,conn).list(input.get("timeMin")||new Date().toISOString(),input.get("timeMax")||new Date(Date.now()+7*864e5).toISOString(),calendars,String(conn.id));
      const items=defaultColor?rawItems.map(event=>event.calendarColor?event:{...event,calendarColor:defaultColor}):rawItems;
      if(!getConnectionById(user.id,conn.id,"microsoft"))throw new CalendarError("Microsoft paskyra pasikeitė. Atnaujink kalendorių.",409);
      return {connectionId:String(conn.id),items};
    });
    const loaded=settled.flatMap(result=>result.status==="fulfilled"?[result.value]:[]),errors=settled.flatMap((result,index)=>result.status==="rejected"?[calendarAccountError(connections[index],result.reason)]:[]);
    if(!loaded.length&&connections.length===1)throw (settled[0] as PromiseRejectedResult).reason;
    return Response.json({items:loaded.flatMap(result=>result.items),errors,loadedConnectionIds:loaded.map(result=>result.connectionId),activeConnectionIds:connections.map(conn=>String(conn.id))},{headers:{"Cache-Control":"no-store"}});
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

    const conn = microsoftConnection(user.id, body.connectionId);
    if (!conn || conn.status !== "active") {
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

    const createCatalog=await microsoftCalendarCatalogForConnection(user.id,conn);
    if (body.calendarVersion !== createCatalog.version) {
      throw new CalendarError(
        "Microsoft paskyra arba kalendorių katalogas pasikeitė. Atnaujink kalendorius.",
        409,
      );
    }

    // Validate the timezone / all-day payload before the enabled-calendar
    // check so malformed requests are rejected with 400 even when the target
    // calendar is not in the current selection.
    if (body.allDay) {
      if (body.timeZone !== undefined) {
        throw new CalendarError("Visos dienos įvykiui laiko zona nesiunčiama.");
      }
    } else if (!isCalendarTimeZone(body.timeZone === undefined ? "UTC" : body.timeZone)) {
      throw new CalendarError("Pasirink galiojančią IANA laiko zoną.");
    }

    // A live but non-writable calendar is a permission error regardless of the
    // enabled selection; report 403 before the enabled (409) check.
    const liveCalendar = createCatalog.items.find((item) => item.id === calendarId);
    if (liveCalendar && !liveCalendar.writable) {
      throw new CalendarError("Pasirinktame Microsoft kalendoriuje nėra rašymo teisės.", 403);
    }

    // Resolve and validate the timezone / all-day payload (including the
    // supported-timezone lookup and the ambiguous-hour fold check inside
    // buildOutlookEvent) before the enabled check so malformed requests are
    // rejected with 400 even when the target calendar is not in the selection.
    if (body.allDay) {
      const dates = eventDates(body.start, body.end);
      body.start = dates.start;
      body.end = dates.end;
    } else {
      const times = eventTimes(body.start, body.end);
      const requested = body.timeZone === undefined ? "UTC" : body.timeZone;
      body.start = times.start;
      body.end = times.end;
      body.timeZone = requested;
      if (requested !== "UTC") {
        const supported = await graphFetchForUser(
          user.id,
          conn,
          "/me/outlook/supportedTimeZones(TimeZoneStandard=microsoft.graph.timeZoneStandard'Iana')",
        );
        const afterConn = getConnectionById(user.id, conn.id, "microsoft");
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

    if (!createCatalog.enabled.includes(calendarId)) {
      throw new CalendarError("Pasirinktas Microsoft kalendorius neįjungtas nustatymuose.", 409);
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

    const afterConn = getConnectionById(user.id, conn.id, "microsoft");
    if (!afterConn || afterConn.id !== conn.id) {
      throw new CalendarError("Microsoft paskyra pasikeitė. Atnaujink kalendorių.", 409);
    }

    if (selected?.id !== calendarId) {
      throw new CalendarError("Microsoft grąžino kitą kalendorių. Atnaujink kalendorių sąrašą.", 502);
    }
    if (!createCatalog.enabled.includes(calendarId)) {
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

    const finalConn = getConnectionById(user.id, conn.id, "microsoft");
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
    const input=Object.fromEntries(new URL(request.url).searchParams);
    const conn = microsoftConnection(user.id, input.connectionId);
    if (!conn) throw new CalendarError("Microsoft paskyra neprijungta.", 409);
    const calendar = makeMicrosoftCalendarService(user.id, conn);
    await calendar.remove(input);
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
    const body = await request.json();
    const conn = microsoftConnection(user.id, body?.connectionId);
    if (!conn) throw new CalendarError("Microsoft paskyra neprijungta.", 409);
    const calendar = makeMicrosoftCalendarService(user.id, conn);
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
    const body=await request.json();
    const conn = microsoftConnection(user.id, body?.connectionId);
    if (!conn) throw new CalendarError("Microsoft paskyra neprijungta.", 409);
    const calendar = makeMicrosoftCalendarService(user.id, conn);
    return Response.json(await calendar.respond(body));
  } catch (error) {
    if (error instanceof Response) return error;
    return failure(error);
  }
}
