import { db } from "@/lib/db-multi";
import { getConnectionById, type OAuthProvider } from "@/lib/oauth-service";

export type CalendarPreference = {
  calendar_id: string;
  enabled: boolean;
  color_override: string | null;
};

export type CalendarSelection = {
  connection_id: number;
  explicit: boolean;
  items: CalendarPreference[];
};

export class CalendarPreferenceError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function calendarId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    /[\u0000-\u001f]/.test(value)
  ) {
    throw new CalendarPreferenceError("Neteisingas kalendoriaus ID.");
  }
  return value;
}

function colorOverride(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new CalendarPreferenceError("Neteisinga kalendoriaus spalva.");
  }
  return value.toLowerCase();
}

function requireConnection(
  userId: number,
  connectionId: number,
  providerAccountId: string,
  provider?: OAuthProvider,
) {
  const connection = getConnectionById(userId, connectionId, provider);
  if (!connection || connection.status !== "active") {
    throw new CalendarPreferenceError("Kalendoriaus paskyra neprijungta.", 409);
  }
  if (connection.provider_account_id !== providerAccountId) {
    throw new CalendarPreferenceError("Kalendoriaus paskyra pasikeitė. Atnaujink duomenis.", 409);
  }
  return connection;
}

export function getCalendarSelection(userId: number, connectionId: number): CalendarSelection {
  if (!getConnectionById(userId, connectionId)) {
    throw new CalendarPreferenceError("Kalendoriaus paskyra nerasta.", 404);
  }
  const state = db.prepare(
    `SELECT explicit FROM calendar_preference_sets
     WHERE user_id = ? AND connection_id = ?`,
  ).get(userId, connectionId) as { explicit: number } | undefined;
  const rows = db.prepare(
    `SELECT calendar_id, enabled, color_override
     FROM calendar_preferences
     WHERE user_id = ? AND connection_id = ?
     ORDER BY calendar_id`,
  ).all(userId, connectionId) as { calendar_id: string; enabled: number; color_override: string | null }[];
  return {
    connection_id: connectionId,
    explicit: state?.explicit === 1,
    items: rows.map((row) => ({
      calendar_id: row.calendar_id,
      enabled: row.enabled === 1,
      color_override: row.color_override,
    })),
  };
}

export function replaceCalendarSelection(
  userId: number,
  connectionId: number,
  providerAccountId: string,
  items: readonly { id: unknown; color_override?: unknown }[],
  provider?: OAuthProvider,
): CalendarSelection {
  requireConnection(userId, connectionId, providerAccountId, provider);
  if (!Array.isArray(items) || items.length > 1000) {
    throw new CalendarPreferenceError("Neteisingas kalendorių sąrašas.");
  }

  const normalized = new Map<string, string | null>();
  for (const item of items) {
    const id = calendarId(item?.id);
    if (normalized.has(id)) throw new CalendarPreferenceError("Kalendorių sąraše yra dublikatų.");
    normalized.set(id, colorOverride(item?.color_override));
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-check ownership after taking the write lock so an account cannot be
    // disconnected between validation and the preference write.
    requireConnection(userId, connectionId, providerAccountId, provider);
    db.prepare(
      "DELETE FROM calendar_preferences WHERE user_id = ? AND connection_id = ?",
    ).run(userId, connectionId);
    const insert = db.prepare(
      `INSERT INTO calendar_preferences
         (user_id, connection_id, calendar_id, enabled, color_override, updated_at)
       VALUES (?, ?, ?, 1, ?, CURRENT_TIMESTAMP)`,
    );
    for (const [id, color] of normalized) insert.run(userId, connectionId, id, color);
    db.prepare(
      `INSERT INTO calendar_preference_sets
         (user_id, connection_id, explicit, updated_at)
       VALUES (?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, connection_id) DO UPDATE SET
         explicit = 1,
         updated_at = excluded.updated_at`,
    ).run(userId, connectionId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getCalendarSelection(userId, connectionId);
}

export function setCalendarEnabled(
  userId: number,
  connectionId: number,
  providerAccountId: string,
  rawCalendarId: unknown,
  enabled: boolean,
  rawColorOverride?: unknown,
  provider?: OAuthProvider,
): CalendarSelection {
  if (typeof enabled !== "boolean") {
    throw new CalendarPreferenceError("Neteisinga kalendoriaus būsena.");
  }
  requireConnection(userId, connectionId, providerAccountId, provider);
  const id = calendarId(rawCalendarId);
  const color = colorOverride(rawColorOverride);

  db.exec("BEGIN IMMEDIATE");
  try {
    requireConnection(userId, connectionId, providerAccountId, provider);
    db.prepare(
      `INSERT INTO calendar_preference_sets
         (user_id, connection_id, explicit, updated_at)
       VALUES (?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, connection_id) DO UPDATE SET
         explicit = 1,
         updated_at = excluded.updated_at`,
    ).run(userId, connectionId);
    if (enabled) {
      db.prepare(
        `INSERT INTO calendar_preferences
           (user_id, connection_id, calendar_id, enabled, color_override, updated_at)
         VALUES (?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, connection_id, calendar_id) DO UPDATE SET
           enabled = 1,
           color_override = excluded.color_override,
           updated_at = excluded.updated_at`,
      ).run(userId, connectionId, id, color);
    } else {
      db.prepare(
        `DELETE FROM calendar_preferences
         WHERE user_id = ? AND connection_id = ? AND calendar_id = ?`,
      ).run(userId, connectionId, id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getCalendarSelection(userId, connectionId);
}
