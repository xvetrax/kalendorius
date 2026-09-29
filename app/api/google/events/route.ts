import {
  CalendarError,
  calendarIdentifier,
  createCalendarService,
  eventDates,
  eventTimes,
} from "@/lib/calendar-events";
import { calendarCreateIdentity, calendarCreateOperationId } from "@/lib/calendar-create";
import { googleCalendarRecurrence, parseCalendarRecurrence } from "@/lib/calendar-recurrence";
import { isCalendarTimeZone } from "@/lib/calendar-time-zone";
import { requireUserContext } from "@/lib/db-multi";
import { googleFetchForUser } from "@/lib/google";
import { apiError, assertSameOrigin } from "@/lib/http";
import { calendarSelectionVersion } from "@/lib/calendar-selection";
import { getConnection, getConnectionById, listConnections, type OAuthConnectionRow } from "@/lib/oauth-service";
import { googleCalendarCatalogForConnection } from "../calendars/route.ts";
import { allSettledLimited, calendarAccountError } from "@/lib/calendar-multi";

export const runtime = "nodejs";

function failure(error: unknown) {
  return error instanceof CalendarError
    ? Response.json({ error: error.message }, { status: error.status })
    : apiError(error);
}

function makeGoogleCalendarService(userId: number, conn: OAuthConnectionRow) {
  const connectionId = String(conn.id);
  return createCalendarService("google", {
    connection: () => {
      const c = getConnectionById(userId, conn.id, "google");
      return c && c.id === conn.id && c.status === "active" ? connectionId : null;
    },
    request: (path: string, init?: RequestInit) =>
      googleFetchForUser(userId, conn, path, init),
  });
}

function googleConnection(userId:number,raw:unknown){
  if(raw!==undefined&&raw!==null&&raw!==""){const id=Number(raw);return Number.isSafeInteger(id)?getConnectionById(userId,id,"google"):null;}
  return getConnection(userId,"google");
}

export async function GET(request: Request) {
  try {
    const user = requireUserContext(request);
    const input = new URL(request.url).searchParams;
    const seriesId = input.get("seriesId");
    if (seriesId) {
      const connectionId=Number(input.get("connectionId")),conn=Number.isSafeInteger(connectionId)?getConnectionById(user.id,connectionId,"google"):null;
      if(!conn||conn.status!=="active")throw new CalendarError("Pasirink konkrečią Google paskyrą.",409);
      return Response.json(await makeGoogleCalendarService(user.id,conn).series(Object.fromEntries(input)));
    }
    const connections=listConnections(user.id,"google").filter(conn=>conn.status==="active");
    if(!connections.length)return Response.json({items:[],errors:[],loadedConnectionIds:[]});
    const settled=await allSettledLimited(connections,3,async conn=>{
      const catalog=await googleCalendarCatalogForConnection(user.id,conn),enabled=new Set(catalog.enabled);
      const calendars=catalog.explicit?catalog.items.filter(item=>enabled.has(item.id)).map(item=>({id:item.id,name:item.name,color:item.color})):undefined;
      const primaryColor=!catalog.explicit?catalog.items.find(item=>item.primary)?.color:undefined;
      const rawItems=await makeGoogleCalendarService(user.id,conn).list(input.get("timeMin")||new Date().toISOString(),input.get("timeMax")||new Date(Date.now()+7*864e5).toISOString(),calendars,String(conn.id));
      const items=primaryColor?rawItems.map(event=>event.calendarColor?event:{...event,calendarColor:primaryColor}):rawItems;
      if(!getConnectionById(user.id,conn.id,"google"))throw new CalendarError("Google paskyra pasikeitė. Atnaujink kalendorių.",409);
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

    const conn = googleConnection(user.id, body.connectionId);
    if (!conn || conn.status !== "active") {
      throw new CalendarError("Google paskyra neprijungta.", 409);
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

    const createCatalog=await googleCalendarCatalogForConnection(user.id,conn);
    if (body.calendarVersion !== createCatalog.version) {
      throw new CalendarError(
        "Google paskyra arba kalendorių katalogas pasikeitė. Atnaujink kalendorius.",
        409,
      );
    }

    // Validate the timezone / all-day payload before the enabled-calendar
    // check so malformed requests are rejected with 400 even when the target
    // calendar is not in the current selection.
    if (body.allDay) {
      if (body.timeZone !== undefined)
        throw new CalendarError("Visos dienos įvykiui laiko zona nesiunčiama.");
    } else {
      const timeZone = body.timeZone === undefined ? "UTC" : body.timeZone;
      if (!isCalendarTimeZone(timeZone))
        throw new CalendarError("Pasirink galiojančią IANA laiko zoną.");
    }

    // A live but non-writable calendar is a permission error regardless of the
    // enabled selection; report 403 before the enabled (409) check.
    const liveCalendar = createCatalog.items.find((item) => item.id === calendarId);
    if (liveCalendar && !liveCalendar.writable) {
      throw new CalendarError("Pasirinktame Google kalendoriuje nėra rašymo teisės.", 403);
    }

    if (!createCatalog.enabled.includes(calendarId)) {
      throw new CalendarError("Pasirinktas Google kalendorius neįjungtas nustatymuose.", 409);
    }

    const common: Record<string, unknown> = {
      summary: String(body.summary).trim(),
      description: String(body.description || ""),
      ...(body.location ? { location: String(body.location).slice(0, 1000) } : {}),
      ...(body.showAs === "free" ? { transparency: "transparent" } : {}),
      ...(body.visibility === "private" ? { visibility: "private" } : {}),
    };

    let event: Record<string, unknown>;
    let recurrenceContext: { startDate: string; allDay: boolean; timeZone?: string };

    if (body.allDay) {
      if (body.timeZone !== undefined)
        throw new CalendarError("Visos dienos įvykiui laiko zona nesiunčiama.");
      const dates = eventDates(body.start, body.end);
      recurrenceContext = { startDate: dates.start, allDay: true };
      event = { ...common, start: { date: dates.start }, end: { date: dates.end } };
    } else {
      const times = eventTimes(body.start, body.end);
      const timeZone = body.timeZone === undefined ? "UTC" : body.timeZone;
      if (!isCalendarTimeZone(timeZone))
        throw new CalendarError("Pasirink galiojančią IANA laiko zoną.");
      const mins = Number(body.reminderMinutes);
      const reminders =
        Number.isFinite(mins) && mins >= 0
          ? { useDefault: false, overrides: [{ method: "popup", minutes: mins }] }
          : { useDefault: true };
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(times.start));
      const field = (type: string) =>
        parts.find((part) => part.type === type)?.value || "";
      recurrenceContext = {
        startDate: `${field("year")}-${field("month")}-${field("day")}`,
        allDay: false,
        timeZone,
      };
      event = {
        ...common,
        start: { dateTime: times.start, timeZone },
        end: { dateTime: times.end, timeZone },
        attendees: String(body.attendees || "")
          .split(",")
          .map((email) => email.trim())
          .filter(Boolean)
          .map((email) => ({ email })),
        reminders,
      };
    }

    const recurrence =
      body.recurrence === undefined || body.recurrence === null
        ? null
        : parseCalendarRecurrence(body.recurrence, recurrenceContext);
    if (body.recurrence !== undefined && body.recurrence !== null && !recurrence) {
      throw new CalendarError("Neteisinga kartojimo taisyklė.");
    }
    if (recurrence) event.recurrence = googleCalendarRecurrence(recurrence, recurrenceContext);

    const identity = calendarCreateIdentity("google", accountId, connectionId, calendarId, operationId, {
      event,
      addMeet: Boolean(body.addMeet),
    });
    event = {
      ...event,
      id: identity.googleEventId,
      extendedProperties: {
        private: {
          dienosPlanasOperation: identity.key,
          dienosPlanasPayload: identity.fingerprint,
        },
      },
    };
    if (body.addMeet) {
      event.conferenceData = {
        createRequest: {
          requestId: identity.transactionId,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      };
    }

    const selected = await googleFetchForUser(
      user.id,
      conn,
      `/users/me/calendarList/${encodeURIComponent(calendarId)}`,
    );

    // Verify connection hasn't changed
    const afterConn = getConnectionById(user.id, conn.id, "google");
    if (!afterConn || afterConn.id !== conn.id) {
      throw new CalendarError("Google paskyra pasikeitė. Atnaujink kalendorių.", 409);
    }

    if (selected?.id !== calendarId) {
      throw new CalendarError("Google grąžino kitą kalendorių. Atnaujink kalendorių sąrašą.", 502);
    }
    if (selected.accessRole !== "owner" && selected.accessRole !== "writer") {
      throw new CalendarError("Pasirinktame Google kalendoriuje nėra rašymo teisės.", 403);
    }

    // Reserve the idempotency slot (per-user)
    const { reserveCalendarEventCreate } = await import("@/lib/db");
    if (
      !reserveCalendarEventCreate(
        "google",
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

    let data: any;
    let recovered = false;
    try {
      data = await googleFetchForUser(
        user.id,
        conn,
        `/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`,
        { method: "POST", body: JSON.stringify(event) },
      );
    } catch (createError) {
      try {
        const existing = await googleFetchForUser(
          user.id,
          conn,
          `/calendars/${encodeURIComponent(calendarId)}/events/${identity.googleEventId}`,
        );
        if (
          existing?.extendedProperties?.private?.dienosPlanasOperation !== identity.key ||
          existing?.extendedProperties?.private?.dienosPlanasPayload !== identity.fingerprint
        ) {
          throw new CalendarError("Kūrimo operacijos ID jau panaudotas kitam įvykiui.", 409);
        }
        data = existing;
        recovered = true;
      } catch (readError) {
        if (readError instanceof CalendarError) throw readError;
        throw createError;
      }
    }

    const finalConn = getConnectionById(user.id, conn.id, "google");
    if (!finalConn || finalConn.id !== conn.id) {
      throw new CalendarError("Google paskyra pasikeitė. Atnaujink kalendorių.", 409);
    }

    return Response.json(data, { status: recovered ? 200 : 201 });
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
    const conn = googleConnection(user.id, input.connectionId);
    if (!conn) throw new CalendarError("Google paskyra neprijungta.", 409);
    const calendar = makeGoogleCalendarService(user.id, conn);
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
    const conn = googleConnection(user.id, body?.connectionId);
    if (!conn) throw new CalendarError("Google paskyra neprijungta.", 409);
    const calendar = makeGoogleCalendarService(user.id, conn);
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
    const conn = googleConnection(user.id, body?.connectionId);
    if (!conn) throw new CalendarError("Google paskyra neprijungta.", 409);
    const calendar = makeGoogleCalendarService(user.id, conn);
    return Response.json(await calendar.respond(body));
  } catch (error) {
    if (error instanceof Response) return error;
    return failure(error);
  }
}
