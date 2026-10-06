import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalCalendarTimeZone, compatibleZonedInstant, zonedLocalInput } from "./calendar-time-zone.ts";
import { db } from "./db-multi.ts";

export type NotificationScenario = "focus_end" | "task_start" | "morning_plan" | "evening_close";
export type DailyRitualScenario = "morning_plan" | "evening_close";

export class NotificationJobError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type PreferenceRow = {
  scenario: NotificationScenario;
  enabled: number;
  lead_minutes: number | null;
  local_time: string | null;
  time_zone: string | null;
  private_content: number;
};

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FOCUS_HORIZON_MS = 26 * 60 * 1000;
const FOCUS_EXPIRY_GRACE_MS = 15 * 60 * 1000;
const MAX_ACTIVE_FOCUS_JOBS = 10;
const MAX_RETAINED_FOCUS_JOBS = 1000;
const MAX_NEW_FOCUS_JOBS_PER_MINUTE = 60;
const RETENTION_DAYS = 7;
const DEFAULT_TASK_START_LEAD_MINUTES = 10;
const TASK_START_LEAD_MINUTES = new Set([0, 5, 10, 15, 30, 60, 1440]);
const TASK_START_EXPIRY_GRACE_MS = 15 * 60 * 1000;
const DAILY_RITUAL_EXPIRY_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MORNING_TIME = "08:00";
const DEFAULT_EVENING_TIME = "18:00";
const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export type TaskStartNotificationHooks = {
  sync(taskKey: string, scheduledAt: string | null, scheduleVersion: number): void;
  cancel(taskKey: string): void;
  move(oldTaskKey: string, newTaskKey: string, scheduledAt: string | null, scheduleVersion: number): void;
};

function focusPreference(userId: number): PreferenceRow {
  return (db.prepare(`
    SELECT scenario, enabled, lead_minutes, local_time, time_zone, private_content
    FROM notification_preferences
    WHERE user_id = ? AND scenario = 'focus_end'
  `).get(userId) as PreferenceRow | undefined) ?? {
    scenario: "focus_end",
    enabled: 0,
    lead_minutes: null,
    local_time: null,
    time_zone: null,
    private_content: 0,
  };
}

function taskStartPreference(database: DatabaseSync, userId: number): PreferenceRow {
  return (database.prepare(`
    SELECT scenario, enabled, lead_minutes, local_time, time_zone, private_content
    FROM notification_preferences
    WHERE user_id = ? AND scenario = 'task_start'
  `).get(userId) as PreferenceRow | undefined) ?? {
    scenario: "task_start",
    enabled: 0,
    lead_minutes: DEFAULT_TASK_START_LEAD_MINUTES,
    local_time: null,
    time_zone: null,
    private_content: 0,
  };
}

function dailyRitualPreference(database: DatabaseSync, userId: number, scenario: DailyRitualScenario): PreferenceRow {
  return (database.prepare(`
    SELECT scenario, enabled, lead_minutes, local_time, time_zone, private_content
    FROM notification_preferences
    WHERE user_id = ? AND scenario = ?
  `).get(userId, scenario) as PreferenceRow | undefined) ?? {
    scenario,
    enabled: 0,
    lead_minutes: null,
    local_time: scenario === "morning_plan" ? DEFAULT_MORNING_TIME : DEFAULT_EVENING_TIME,
    time_zone: null,
    private_content: 0,
  };
}

export function isDailyRitualLocalTime(value: unknown): value is string {
  return typeof value === "string" && LOCAL_TIME.test(value);
}

export function getNotificationPreferences(userId: number) {
  const focus = focusPreference(userId);
  const taskStart = taskStartPreference(db, userId);
  const morning = dailyRitualPreference(db, userId, "morning_plan");
  const evening = dailyRitualPreference(db, userId, "evening_close");
  const morningZone = canonicalCalendarTimeZone(morning.time_zone);
  const eveningZone = canonicalCalendarTimeZone(evening.time_zone);
  return {
    focusEnd: { enabled: Boolean(focus.enabled) },
    taskStart: {
      enabled: Boolean(taskStart.enabled),
      leadMinutes: taskStart.lead_minutes ?? DEFAULT_TASK_START_LEAD_MINUTES,
    },
    dailyRituals: {
      timeZone: morningZone && eveningZone && morningZone === eveningZone
        ? morningZone
        : morningZone || eveningZone,
      morningPlan: {
        enabled: Boolean(morning.enabled),
        localTime: isDailyRitualLocalTime(morning.local_time) ? morning.local_time : DEFAULT_MORNING_TIME,
      },
      eveningClose: {
        enabled: Boolean(evening.enabled),
        localTime: isDailyRitualLocalTime(evening.local_time) ? evening.local_time : DEFAULT_EVENING_TIME,
      },
    },
  };
}

function cancelDeliveries(database: DatabaseSync, userId: number, scenario: NotificationScenario, sourcePattern?: string) {
  database.prepare(`
    UPDATE notification_deliveries
    SET state = 'cancelled', lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE job_id IN (
      SELECT id FROM notification_jobs
      WHERE user_id = ? AND scenario = ? ${sourcePattern ? "AND source_key LIKE ?" : ""}
    ) AND state IN ('queued', 'leased', 'retryable')
  `).run(...(sourcePattern ? [userId, scenario, sourcePattern] : [userId, scenario]));
}

function taskSourcePrefix(taskKey: string) {
  return `${createHash("sha256").update(taskKey).digest("hex")}:`;
}

function cancelTaskStartCore(database: DatabaseSync, userId: number, taskKey: string) {
  const pattern = `${taskSourcePrefix(taskKey)}%`;
  database.prepare(`
    UPDATE notification_jobs
    SET cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND scenario = 'task_start' AND source_key LIKE ? AND cancelled_at IS NULL
  `).run(userId, pattern);
  cancelDeliveries(database, userId, "task_start", pattern);
}

function moveTaskStartCore(database: DatabaseSync, userId: number, oldTaskKey: string, newTaskKey: string) {
  if (oldTaskKey === newTaskKey) return;
  const oldPrefix = taskSourcePrefix(oldTaskKey);
  const newPrefix = taskSourcePrefix(newTaskKey);
  database.prepare(`
    UPDATE notification_jobs
    SET source_key = ? || substr(source_key, ?), updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND scenario = 'task_start' AND source_key LIKE ?
  `).run(newPrefix, oldPrefix.length + 1, userId, `${oldPrefix}%`);
}

function syncTaskStartCore(
  database: DatabaseSync,
  userId: number,
  taskKey: string,
  scheduledAt: string | null,
  scheduleVersion: number,
  now: number,
) {
  const preference = taskStartPreference(database, userId);
  if (!preference.enabled || !scheduledAt) {
    cancelTaskStartCore(database, userId, taskKey);
    return;
  }
  const startsAt = Date.parse(scheduledAt);
  if (!Number.isFinite(startsAt)) {
    cancelTaskStartCore(database, userId, taskKey);
    return;
  }
  const leadMinutes = preference.lead_minutes ?? DEFAULT_TASK_START_LEAD_MINUTES;
  // Keep the intended run time stable. When the lead window is already open,
  // the worker sees this past timestamp as immediately due without creating a
  // new generation on every provider refresh.
  const runAt = new Date(startsAt - leadMinutes * 60_000).toISOString();
  const expiresAt = new Date(startsAt + TASK_START_EXPIRY_GRACE_MS).toISOString();
  const prefix = taskSourcePrefix(taskKey);
  const existing = database.prepare(`
    SELECT id FROM notification_jobs
    WHERE user_id = ? AND scenario = 'task_start' AND source_key LIKE ?
      AND cancelled_at IS NULL
      AND run_at = ? AND expires_at = ?
    LIMIT 1
  `).get(userId, `${prefix}%`, runAt, expiresAt);
  if (existing && Date.parse(expiresAt) > now) return;
  if (startsAt <= now) {
    cancelTaskStartCore(database, userId, taskKey);
    return;
  }
  cancelTaskStartCore(database, userId, taskKey);
  const sourceKey = `${prefix}${scheduleVersion}:${leadMinutes}:${randomUUID()}`;
  database.prepare(`
    INSERT INTO notification_jobs
      (user_id, scenario, source_key, run_at, expires_at, created_at, updated_at)
    VALUES (?, 'task_start', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(userId, sourceKey, runAt, expiresAt);
}

function withSavepoint<T>(database: DatabaseSync, action: () => T): T {
  database.exec("SAVEPOINT task_start_notification_sync");
  try {
    const result = action();
    database.exec("RELEASE task_start_notification_sync");
    return result;
  } catch (error) {
    database.exec("ROLLBACK TO task_start_notification_sync");
    database.exec("RELEASE task_start_notification_sync");
    throw error;
  }
}

function scheduledTaskPlans(database: DatabaseSync, userId: number) {
  return database.prepare(`
    SELECT tp.task_key, tp.scheduled_at, tp.schedule_version
    FROM task_plans tp
    WHERE tp.user_id = ? AND tp.scheduled_at IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM tasks t
          WHERE t.user_id = tp.user_id AND 'local:' || t.id = tp.task_key AND t.completed = 0
        )
        OR EXISTS (
          SELECT 1 FROM remote_tasks rt
          WHERE rt.user_id = tp.user_id AND rt.task_key = tp.task_key
        )
      )
  `).all(userId) as { task_key: string; scheduled_at: string; schedule_version: number }[];
}

export function createTaskStartNotificationHooks(
  database: DatabaseSync,
  userId: number,
  clock: () => number = Date.now,
): TaskStartNotificationHooks {
  return {
    sync(taskKey, scheduledAt, scheduleVersion) {
      withSavepoint(database, () => syncTaskStartCore(database, userId, taskKey, scheduledAt, scheduleVersion, clock()));
    },
    cancel(taskKey) {
      withSavepoint(database, () => cancelTaskStartCore(database, userId, taskKey));
    },
    move(oldTaskKey, newTaskKey, scheduledAt, scheduleVersion) {
      withSavepoint(database, () => {
        moveTaskStartCore(database, userId, oldTaskKey, newTaskKey);
        syncTaskStartCore(database, userId, newTaskKey, scheduledAt, scheduleVersion, clock());
      });
    },
  };
}

export function updateTaskStartPreference(userId: number, enabled: boolean, leadMinutes: number) {
  if (!Number.isInteger(leadMinutes) || !TASK_START_LEAD_MINUTES.has(leadMinutes)) {
    throw new NotificationJobError("Pasirink nepalaikomą užduoties priminimo laiką.");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = taskStartPreference(db, userId);
    if (Boolean(current.enabled) === enabled
      && (current.lead_minutes ?? DEFAULT_TASK_START_LEAD_MINUTES) === leadMinutes) {
      db.exec("COMMIT");
      return getNotificationPreferences(userId);
    }
    db.prepare(`
      INSERT INTO notification_preferences (user_id, scenario, enabled, lead_minutes, updated_at)
      VALUES (?, 'task_start', ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, scenario) DO UPDATE SET
        enabled = excluded.enabled,
        lead_minutes = excluded.lead_minutes,
        updated_at = excluded.updated_at
    `).run(userId, enabled ? 1 : 0, leadMinutes);
    db.prepare(`
      UPDATE notification_jobs
      SET cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND scenario = 'task_start' AND completed_at IS NULL
    `).run(userId);
    cancelDeliveries(db, userId, "task_start");
    if (enabled) {
      const plans = scheduledTaskPlans(db, userId);
      const now = Date.now();
      for (const plan of plans) syncTaskStartCore(db, userId, plan.task_key, plan.scheduled_at, plan.schedule_version, now);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getNotificationPreferences(userId);
}

export function rebuildTaskStartNotificationsInTransaction(database: DatabaseSync, now = Date.now()) {
  const users = database.prepare(`
    SELECT user_id FROM notification_preferences
    WHERE scenario = 'task_start' AND enabled = 1
  `).all() as { user_id: number }[];
  for (const { user_id: userId } of users) {
    const plans = scheduledTaskPlans(database, userId);
    for (const plan of plans) syncTaskStartCore(database, userId, plan.task_key, plan.scheduled_at, plan.schedule_version, now);
  }
}

type DailyRitualSetting = { enabled: boolean; localTime: string };

export type DailyRitualPreferencesInput = {
  timeZone: string;
  morningPlan: DailyRitualSetting;
  eveningClose: DailyRitualSetting;
};

type DailyRitualRow = {
  user_id: number;
  scenario: DailyRitualScenario;
  enabled: number;
  local_time: string | null;
  time_zone: string | null;
};

function shiftCalendarDate(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function localDateAt(now: number, timeZone: string) {
  return zonedLocalInput(new Date(now).toISOString(), timeZone).slice(0, 10);
}

function dailyOccurrence(date: string, localTime: string, timeZone: string) {
  return Date.parse(compatibleZonedInstant(`${date}T${localTime}`, timeZone));
}

function cancelDailyRitualCore(database: DatabaseSync, userId: number, scenario: DailyRitualScenario) {
  database.prepare(`
    UPDATE notification_jobs
    SET cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND scenario = ? AND completed_at IS NULL
  `).run(userId, scenario);
  cancelDeliveries(database, userId, scenario);
}

function syncDailyRitualCore(database: DatabaseSync, preference: DailyRitualRow, now: number) {
  if (!preference.enabled || !isDailyRitualLocalTime(preference.local_time)) return;
  const timeZone = canonicalCalendarTimeZone(preference.time_zone);
  if (!timeZone) return;
  const currentDate = localDateAt(now, timeZone);
  const dates = [
    shiftCalendarDate(currentDate, -1),
    currentDate,
    shiftCalendarDate(currentDate, 1),
    shiftCalendarDate(currentDate, 2),
  ];
  for (const date of dates) {
    const runAtMs = dailyOccurrence(date, preference.local_time, timeZone);
    const runAt = new Date(runAtMs).toISOString();
    const expiresAt = new Date(runAtMs + DAILY_RITUAL_EXPIRY_MS).toISOString();
    const existing = database.prepare(`
      SELECT id, cancelled_at, expanded_at, completed_at
      FROM notification_jobs
      WHERE user_id = ? AND scenario = ? AND source_key = ?
    `).get(preference.user_id, preference.scenario, date) as {
      id: number;
      cancelled_at: string | null;
      expanded_at: string | null;
      completed_at: string | null;
    } | undefined;
    if (Date.parse(expiresAt) <= now) continue;
    if (existing?.expanded_at || existing?.completed_at) continue;
    if (existing) {
      if (existing.cancelled_at && runAtMs <= now) continue;
      database.prepare(`
        UPDATE notification_jobs
        SET run_at = ?, expires_at = ?, cancelled_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(runAt, expiresAt, existing.id);
      return;
    }
    // A persisted job may be delivered late inside its grace window after a
    // restart. Never invent a missed occurrence that was not already durable.
    if (runAtMs <= now) continue;
    database.prepare(`
      INSERT INTO notification_jobs
        (user_id, scenario, source_key, run_at, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(preference.user_id, preference.scenario, date, runAt, expiresAt);
    return;
  }
}

export function reconcileDailyRitualJobsInTransaction(
  database: DatabaseSync,
  now = Date.now(),
  userId?: number,
) {
  const rows = database.prepare(`
    SELECT user_id, scenario, enabled, local_time, time_zone
    FROM notification_preferences
    WHERE scenario IN ('morning_plan', 'evening_close') AND enabled = 1
      ${userId === undefined ? "" : "AND user_id = ?"}
    ORDER BY user_id, scenario
  `).all(...(userId === undefined ? [] : [userId])) as DailyRitualRow[];
  for (const row of rows) {
    if (!isDailyRitualLocalTime(row.local_time) || !canonicalCalendarTimeZone(row.time_zone)) continue;
    syncDailyRitualCore(database, row, now);
  }
}

export function rebuildDailyRitualNotificationsInTransaction(database: DatabaseSync, now = Date.now()) {
  reconcileDailyRitualJobsInTransaction(database, now);
}

function consumedCurrentDate(database: DatabaseSync, userId: number, scenario: DailyRitualScenario, timeZone: string, now: number) {
  const sourceKey = localDateAt(now, timeZone);
  return Boolean(database.prepare(`
    SELECT 1 FROM notification_jobs
    WHERE user_id = ? AND scenario = ? AND source_key = ?
      AND (expanded_at IS NOT NULL OR completed_at IS NOT NULL)
    LIMIT 1
  `).get(userId, scenario, sourceKey));
}

function markDailyDateConsumed(database: DatabaseSync, userId: number, scenario: DailyRitualScenario, date: string, now: number) {
  const timestamp = new Date(now).toISOString();
  database.prepare(`
    INSERT INTO notification_jobs
      (user_id, scenario, source_key, run_at, expires_at, cancelled_at, completed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, scenario, source_key) DO UPDATE SET
      cancelled_at = COALESCE(notification_jobs.cancelled_at, excluded.cancelled_at),
      completed_at = COALESCE(notification_jobs.completed_at, excluded.completed_at),
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, scenario, date, timestamp, timestamp, timestamp, timestamp);
}

function parseDailyRitualSetting(value: unknown, label: string): DailyRitualSetting {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NotificationJobError(`Neteisinga ${label} priminimo nuostata.`);
  }
  const setting = value as { enabled?: unknown; localTime?: unknown };
  if (Object.keys(setting).some((key) => key !== "enabled" && key !== "localTime")
    || typeof setting.enabled !== "boolean" || !isDailyRitualLocalTime(setting.localTime)) {
    throw new NotificationJobError(`Neteisinga ${label} priminimo nuostata.`);
  }
  return { enabled: setting.enabled, localTime: setting.localTime };
}

export function updateDailyRitualPreferences(userId: number, value: unknown, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NotificationJobError("Neteisingos dienos ritualų nuostatos.");
  }
  const raw = value as { timeZone?: unknown; morningPlan?: unknown; eveningClose?: unknown };
  if (Object.keys(raw).some((key) => !["timeZone", "morningPlan", "eveningClose"].includes(key))) {
    throw new NotificationJobError("Neteisingos dienos ritualų nuostatos.");
  }
  const timeZone = canonicalCalendarTimeZone(raw.timeZone);
  if (!timeZone) throw new NotificationJobError("Pasirink galiojančią IANA laiko zoną.");
  const settings: [DailyRitualScenario, DailyRitualSetting][] = [
    ["morning_plan", parseDailyRitualSetting(raw.morningPlan, "ryto")],
    ["evening_close", parseDailyRitualSetting(raw.eveningClose, "vakaro")],
  ];

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [scenario, setting] of settings) {
      const current = dailyRitualPreference(db, userId, scenario);
      const currentZone = canonicalCalendarTimeZone(current.time_zone);
      const unchanged = Boolean(current.enabled) === setting.enabled
        && current.local_time === setting.localTime
        && currentZone === timeZone;
      if (unchanged) continue;
      const consumed = currentZone ? consumedCurrentDate(db, userId, scenario, currentZone, now) : false;
      cancelDailyRitualCore(db, userId, scenario);
      db.prepare(`
        INSERT INTO notification_preferences (user_id, scenario, enabled, local_time, time_zone, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, scenario) DO UPDATE SET
          enabled = excluded.enabled,
          local_time = excluded.local_time,
          time_zone = excluded.time_zone,
          updated_at = excluded.updated_at
      `).run(userId, scenario, setting.enabled ? 1 : 0, setting.localTime, timeZone);
      if (consumed) markDailyDateConsumed(db, userId, scenario, localDateAt(now, timeZone), now);
    }
    reconcileDailyRitualJobsInTransaction(db, now, userId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getNotificationPreferences(userId);
}

export function updateFocusPreference(userId: number, enabled: boolean) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO notification_preferences (user_id, scenario, enabled, updated_at)
      VALUES (?, 'focus_end', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, scenario) DO UPDATE SET
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(userId, enabled ? 1 : 0);
    if (!enabled) {
      db.prepare(`
        UPDATE notification_jobs
        SET cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND scenario = 'focus_end' AND completed_at IS NULL
      `).run(userId);
      db.prepare(`
        UPDATE notification_deliveries
        SET state = 'cancelled', lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE job_id IN (
          SELECT id FROM notification_jobs WHERE user_id = ? AND scenario = 'focus_end'
        ) AND state IN ('queued', 'leased', 'retryable')
      `).run(userId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getNotificationPreferences(userId);
}

function validOperationId(value: unknown) {
  return typeof value === "string" && OPERATION_ID.test(value) ? value.toLowerCase() : null;
}

function prepareNewFocusJob(userId: number, now: number, active: boolean) {
  const nowIso = new Date(now).toISOString();
  db.prepare(`
    UPDATE notification_jobs
    SET completed_at = COALESCE(completed_at, ?), updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND scenario = 'focus_end'
      AND cancelled_at IS NULL AND completed_at IS NULL
      AND julianday(expires_at) <= julianday(?)
  `).run(nowIso, userId, nowIso);
  db.prepare(`
    DELETE FROM notification_jobs
    WHERE user_id = ? AND scenario = 'focus_end'
      AND ((cancelled_at IS NOT NULL AND julianday(cancelled_at) <= julianday(?, ?))
        OR (completed_at IS NOT NULL AND julianday(completed_at) <= julianday(?, ?)))
  `).run(userId, nowIso, `-${RETENTION_DAYS} days`, nowIso, `-${RETENTION_DAYS} days`);
  const recent = Number((db.prepare(`
    SELECT COUNT(*) AS count FROM notification_jobs
    WHERE user_id = ? AND scenario = 'focus_end'
      AND julianday(created_at) >= julianday('now', '-1 minute')
  `).get(userId) as { count: number }).count);
  if (recent >= MAX_NEW_FOCUS_JOBS_PER_MINUTE) {
    throw new NotificationJobError("Per daug fokusavimo priminimų. Palauk minutę ir bandyk dar kartą.", 429);
  }
  const retained = Number((db.prepare(`
    SELECT COUNT(*) AS count FROM notification_jobs
    WHERE user_id = ? AND scenario = 'focus_end'
  `).get(userId) as { count: number }).count);
  if (retained >= MAX_RETAINED_FOCUS_JOBS) {
    throw new NotificationJobError("Pasiekta fokusavimo priminimų saugojimo riba.", 429);
  }
  if (active) {
    const activeCount = Number((db.prepare(`
      SELECT COUNT(*) AS count FROM notification_jobs
      WHERE user_id = ? AND scenario = 'focus_end'
        AND cancelled_at IS NULL AND completed_at IS NULL
    `).get(userId) as { count: number }).count);
    if (activeCount >= MAX_ACTIVE_FOCUS_JOBS) {
      throw new NotificationJobError("Per daug aktyvių fokusavimo priminimų.", 429);
    }
  }
}

export function scheduleFocusEnd(userId: number, operationValue: unknown, endsAtValue: unknown, now = Date.now()) {
  const operationId = validOperationId(operationValue);
  const endsAt = typeof endsAtValue === "string" ? Date.parse(endsAtValue) : Number.NaN;
  if (!operationId) throw new NotificationJobError("Neteisingas fokusavimo operacijos identifikatorius.");
  if (!Number.isFinite(endsAt) || endsAt <= now || endsAt > now + MAX_FOCUS_HORIZON_MS) {
    throw new NotificationJobError("Neteisingas fokusavimo sesijos pabaigos laikas.");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const user = db.prepare("SELECT status FROM users WHERE id = ?").get(userId) as { status: string } | undefined;
    if (!user || user.status !== "active") throw new NotificationJobError("Naudotojo paskyra neaktyvi.", 403);
    if (!focusPreference(userId).enabled) {
      db.exec("COMMIT");
      return { scheduled: false, reason: "disabled" as const };
    }
    const runAt = new Date(endsAt).toISOString();
    const expiresAt = new Date(endsAt + FOCUS_EXPIRY_GRACE_MS).toISOString();
    const existing = db.prepare(`
      SELECT id, run_at, cancelled_at, completed_at
      FROM notification_jobs
      WHERE user_id = ? AND scenario = 'focus_end' AND source_key = ?
    `).get(userId, operationId) as { id: number; run_at: string; cancelled_at: string | null; completed_at: string | null } | undefined;
    if (existing?.cancelled_at) {
      db.exec("COMMIT");
      return { scheduled: false, reason: "cancelled" as const };
    }
    if (existing?.completed_at) {
      db.exec("COMMIT");
      return { scheduled: false, reason: "completed" as const };
    }
    if (existing) {
      if (existing.run_at !== runAt) throw new NotificationJobError("Ši fokusavimo operacija jau turi kitą pabaigos laiką.", 409);
      db.exec("COMMIT");
      return { scheduled: true, jobId: existing.id, runAt: existing.run_at };
    }
    prepareNewFocusJob(userId, now, true);
    const inserted = db.prepare(`
      INSERT INTO notification_jobs
        (user_id, scenario, source_key, run_at, expires_at, created_at, updated_at)
      VALUES (?, 'focus_end', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(userId, operationId, runAt, expiresAt);
    db.exec("COMMIT");
    return { scheduled: true, jobId: Number(inserted.lastInsertRowid), runAt };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function cancelFocusEnd(userId: number, operationValue: unknown) {
  const operationId = validOperationId(operationValue);
  if (!operationId) throw new NotificationJobError("Neteisingas fokusavimo operacijos identifikatorius.");
  db.exec("BEGIN IMMEDIATE");
  try {
    const now = new Date().toISOString();
    const existing = db.prepare(`
      SELECT id FROM notification_jobs
      WHERE user_id = ? AND scenario = 'focus_end' AND source_key = ?
    `).get(userId, operationId) as { id: number } | undefined;
    if (!existing) prepareNewFocusJob(userId, Date.now(), false);
    db.prepare(`
      INSERT INTO notification_jobs
        (user_id, scenario, source_key, run_at, expires_at, cancelled_at, created_at, updated_at)
      VALUES (?, 'focus_end', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, scenario, source_key) DO UPDATE SET
        cancelled_at = COALESCE(notification_jobs.cancelled_at, excluded.cancelled_at),
        updated_at = CURRENT_TIMESTAMP
      WHERE notification_jobs.completed_at IS NULL
    `).run(userId, operationId, now, now, now);
    const job = db.prepare(`
      SELECT id FROM notification_jobs
      WHERE user_id = ? AND scenario = 'focus_end' AND source_key = ?
    `).get(userId, operationId) as { id: number };
    if (job) {
      db.prepare(`
        UPDATE notification_deliveries
        SET state = 'cancelled', lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ? AND state IN ('queued', 'leased', 'retryable')
      `).run(job.id);
    }
    db.exec("COMMIT");
    return { cancelled: true };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function cancelPendingNotificationsForUser(userId: number) {
  db.prepare(`
    UPDATE notification_jobs
    SET cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND completed_at IS NULL
  `).run(userId);
  db.prepare(`
    UPDATE notification_deliveries
    SET state = 'cancelled', lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE job_id IN (SELECT id FROM notification_jobs WHERE user_id = ?)
      AND state IN ('queued', 'leased', 'retryable')
  `).run(userId);
}
