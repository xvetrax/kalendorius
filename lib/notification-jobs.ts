import { db } from "./db-multi.ts";

export type NotificationScenario = "focus_end" | "task_start" | "morning_plan" | "evening_close";

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

export function getNotificationPreferences(userId: number) {
  const focus = focusPreference(userId);
  return {
    focusEnd: { enabled: Boolean(focus.enabled) },
  };
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
