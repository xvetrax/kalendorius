import { randomUUID } from "node:crypto";
import { db } from "./db-multi.ts";
import { deletePushSubscription, PushNotificationError, readStoredPushSubscription, sendStoredPush, type StoredPushSubscription } from "./push-notifications.ts";

const LEASE_MS = 30_000;
const STALE_SENDING_MS = 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 30_000;
const RESTORE_PAUSE_MS = 5 * 60_000;

type Delivery = {
  id: number;
  job_id: number;
  user_id: number;
  subscription_id: number;
  scenario: "focus_end";
  expires_at: string;
  attempt_count: number;
};

type Send = (subscription: StoredPushSubscription, payload: { v: 1; type: "focus_end" }) => Promise<unknown>;

function transaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function finaliseJob(jobId: number) {
  const active = db.prepare(`
    SELECT 1 FROM notification_deliveries
    WHERE job_id = ? AND state IN ('queued', 'leased', 'sending', 'retryable')
    LIMIT 1
  `).get(jobId);
  if (!active) {
    db.prepare(`
      UPDATE notification_jobs SET completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(jobId);
  }
}

function recoverInterrupted(now: Date) {
  const staleSending = new Date(now.getTime() - STALE_SENDING_MS).toISOString();
  const changed = db.prepare(`
    UPDATE notification_deliveries
    SET state = 'ambiguous', lease_owner = NULL, lease_until = NULL,
        last_status_class = 'worker_interrupted', error_code = 'ambiguous_after_restart', updated_at = CURRENT_TIMESTAMP
    WHERE state = 'sending' AND julianday(attempted_at) <= julianday(?)
  `).run(staleSending).changes;
  db.prepare(`
    UPDATE notification_deliveries
    SET state = 'queued', lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE state = 'leased' AND julianday(lease_until) <= julianday(?)
  `).run(now.toISOString());
  db.prepare(`
    UPDATE notification_deliveries
    SET state = 'permanent', lease_owner = NULL, lease_until = NULL,
        last_status_class = 'local', error_code = 'subscription_missing', updated_at = CURRENT_TIMESTAMP
    WHERE subscription_id IS NULL AND state IN ('queued', 'leased', 'retryable')
  `).run();
  db.prepare(`
    UPDATE notification_deliveries
    SET state = 'permanent', lease_owner = NULL, lease_until = NULL,
        last_status_class = 'expired', error_code = 'job_expired', updated_at = CURRENT_TIMESTAMP
    WHERE state IN ('queued', 'leased', 'retryable')
      AND job_id IN (SELECT id FROM notification_jobs WHERE julianday(expires_at) <= julianday(?))
  `).run(now.toISOString());
  if (changed) {
    const jobs = db.prepare("SELECT DISTINCT job_id FROM notification_deliveries WHERE state = 'ambiguous'").all() as { job_id: number }[];
    for (const job of jobs) finaliseJob(job.job_id);
  }
  const terminalJobs = db.prepare(`
    SELECT j.id FROM notification_jobs j
    WHERE j.completed_at IS NULL AND j.expanded_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM notification_deliveries d
        WHERE d.job_id = j.id AND d.state IN ('queued', 'leased', 'sending', 'retryable')
      )
  `).all() as { id: number }[];
  for (const job of terminalJobs) finaliseJob(job.id);
  const inFlight = Number((db.prepare("SELECT COUNT(*) AS count FROM notification_deliveries WHERE state = 'sending'").get() as { count: number }).count);
  db.prepare("UPDATE notification_runtime SET in_flight = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1").run(inFlight);
  db.prepare(`
    DELETE FROM notification_jobs
    WHERE (cancelled_at IS NOT NULL AND julianday(cancelled_at) <= julianday(?, '-7 days'))
       OR (completed_at IS NOT NULL AND julianday(completed_at) <= julianday(?, '-7 days'))
  `).run(now.toISOString(), now.toISOString());
}

function expandDueJobs(now: Date) {
  const jobs = db.prepare(`
    SELECT j.id, j.user_id
    FROM notification_jobs j
    JOIN users u ON u.id = j.user_id AND u.status = 'active'
    JOIN notification_preferences p ON p.user_id = j.user_id AND p.scenario = j.scenario AND p.enabled = 1
    WHERE j.scenario = 'focus_end'
      AND j.cancelled_at IS NULL AND j.completed_at IS NULL AND j.expanded_at IS NULL
      AND julianday(j.run_at) <= julianday(?)
    ORDER BY j.run_at, j.id
    LIMIT 20
  `).all(now.toISOString()) as { id: number; user_id: number }[];
  for (const job of jobs) {
    transaction(() => {
      const current = db.prepare(`
        SELECT j.id, j.user_id, j.expires_at
        FROM notification_jobs j
        JOIN users u ON u.id = j.user_id AND u.status = 'active'
        JOIN notification_preferences p ON p.user_id = j.user_id AND p.scenario = j.scenario AND p.enabled = 1
        WHERE j.id = ? AND j.cancelled_at IS NULL AND j.completed_at IS NULL AND j.expanded_at IS NULL
      `).get(job.id) as { id: number; user_id: number; expires_at: string } | undefined;
      if (!current) return;
      if (Date.parse(current.expires_at) <= now.getTime()) {
        db.prepare("UPDATE notification_jobs SET completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(job.id);
        return;
      }
      db.prepare(`
        INSERT OR IGNORE INTO notification_deliveries (job_id, subscription_id, state, next_attempt_at)
        SELECT ?, id, 'queued', ? FROM push_subscriptions WHERE user_id = ?
      `).run(job.id, now.toISOString(), current.user_id);
      db.prepare("UPDATE notification_jobs SET expanded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(job.id);
      finaliseJob(job.id);
    });
  }
}

function claimDelivery(workerId: string, now: Date): Delivery | null {
  return transaction(() => {
    const runtime = db.prepare("SELECT paused FROM notification_runtime WHERE id = 1").get() as { paused: number };
    if (runtime.paused) return null;
    const row = db.prepare(`
      SELECT d.id, d.job_id, j.user_id, d.subscription_id, j.scenario, j.expires_at, d.attempt_count
      FROM notification_deliveries d
      JOIN notification_jobs j ON j.id = d.job_id
      JOIN users u ON u.id = j.user_id AND u.status = 'active'
      JOIN notification_preferences p ON p.user_id = j.user_id AND p.scenario = j.scenario AND p.enabled = 1
      JOIN push_subscriptions s ON s.id = d.subscription_id AND s.user_id = j.user_id
      WHERE d.state IN ('queued', 'retryable')
        AND (d.next_attempt_at IS NULL OR julianday(d.next_attempt_at) <= julianday(?))
        AND j.cancelled_at IS NULL AND j.completed_at IS NULL
        AND julianday(j.expires_at) > julianday(?)
      ORDER BY COALESCE(d.next_attempt_at, j.run_at), d.id
      LIMIT 1
    `).get(now.toISOString(), now.toISOString()) as Delivery | undefined;
    if (!row) return null;
    const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
    const updated = db.prepare(`
      UPDATE notification_deliveries
      SET state = 'leased', lease_owner = ?, lease_until = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND state IN ('queued', 'retryable')
    `).run(workerId, leaseUntil, row.id);
    return updated.changes ? row : null;
  });
}

function beginSend(delivery: Delivery, workerId: string, now: Date) {
  return transaction(() => {
    const runtime = db.prepare("SELECT paused FROM notification_runtime WHERE id = 1").get() as { paused: number };
    if (runtime.paused) return false;
    const updated = db.prepare(`
      UPDATE notification_deliveries
      SET state = 'sending', attempt_count = attempt_count + 1, attempted_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND state = 'leased' AND lease_owner = ?
    `).run(now.toISOString(), delivery.id, workerId);
    if (!updated.changes) return false;
    db.prepare("UPDATE notification_runtime SET in_flight = in_flight + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1").run();
    return true;
  });
}

function finishSend(delivery: Delivery, state: "accepted" | "retryable" | "permanent" | "ambiguous", now: Date, statusClass: string, errorCode: string | null, nextAttemptAt: string | null) {
  transaction(() => {
    db.prepare(`
      UPDATE notification_deliveries
      SET state = ?, lease_owner = NULL, lease_until = NULL, next_attempt_at = ?,
          accepted_at = CASE WHEN ? = 'accepted' THEN ? ELSE accepted_at END,
          last_status_class = ?, error_code = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND state = 'sending'
    `).run(state, nextAttemptAt, state, now.toISOString(), statusClass, errorCode, delivery.id);
    db.prepare("UPDATE notification_runtime SET in_flight = MAX(0, in_flight - 1), updated_at = CURRENT_TIMESTAMP WHERE id = 1").run();
    finaliseJob(delivery.job_id);
  });
}

function statusCode(error: unknown) {
  const value = Number((error as { statusCode?: unknown })?.statusCode || 0);
  return Number.isSafeInteger(value) ? value : 0;
}

export async function processNotificationTick(options: {
  workerId?: string;
  now?: Date;
  send?: Send;
} = {}) {
  const now = options.now ?? new Date();
  const workerId = options.workerId ?? randomUUID();
  const send = options.send ?? sendStoredPush;
  db.prepare(`
    UPDATE notification_runtime
    SET heartbeat_at = ?, worker_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(now.toISOString(), workerId);
  db.prepare(`
    UPDATE notification_runtime
    SET paused = 0, pause_until = NULL, pause_owner = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1 AND paused = 1
      AND (pause_until IS NULL OR julianday(pause_until) <= julianday(?))
  `).run(now.toISOString());
  const runtime = db.prepare("SELECT paused FROM notification_runtime WHERE id = 1").get() as { paused: number };
  if (runtime.paused) return { processed: false, reason: "paused" as const };
  transaction(() => recoverInterrupted(now));
  expandDueJobs(now);
  const delivery = claimDelivery(workerId, now);
  if (!delivery) return { processed: false, reason: "idle" as const };
  const subscription = readStoredPushSubscription(delivery.subscription_id, delivery.user_id);
  if (!subscription || !beginSend(delivery, workerId, now)) {
    if (!subscription) {
      db.prepare("UPDATE notification_deliveries SET state = 'permanent', lease_owner = NULL, lease_until = NULL, error_code = 'subscription_missing', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(delivery.id);
      finaliseJob(delivery.job_id);
    }
    return { processed: false, reason: "stale" as const };
  }
  try {
    await send(subscription, { v: 1, type: "focus_end" });
    finishSend(delivery, "accepted", options.now ? new Date(options.now) : new Date(), "accepted", null, null);
    db.prepare(`
      UPDATE push_subscriptions
      SET last_push_accepted_at = CURRENT_TIMESTAMP, failure_count = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(delivery.subscription_id, delivery.user_id);
    return { processed: true, state: "accepted" as const, deliveryId: delivery.id };
  } catch (error) {
    const code = statusCode(error);
    const finishedAt = options.now ? new Date(options.now) : new Date();
    if (error instanceof PushNotificationError && error.code) {
      const corrupt = error.code === "subscription_corrupt";
      finishSend(delivery, "permanent", finishedAt, "local", error.code, null);
      if (corrupt) deletePushSubscription(delivery.user_id, delivery.subscription_id);
      return { processed: true, state: "permanent" as const, deliveryId: delivery.id };
    }
    if (code === 404 || code === 410) {
      finishSend(delivery, "permanent", finishedAt, String(code), "subscription_gone", null);
      deletePushSubscription(delivery.user_id, delivery.subscription_id);
      return { processed: true, state: "permanent" as const, deliveryId: delivery.id };
    }
    const attempt = delivery.attempt_count + 1;
    const canRetry = (code === 429 || code >= 500) && attempt < MAX_ATTEMPTS;
    const nextAttempt = new Date(finishedAt.getTime() + RETRY_BASE_MS * 2 ** (attempt - 1));
    if (canRetry && nextAttempt.getTime() < Date.parse(delivery.expires_at)) {
      finishSend(delivery, "retryable", finishedAt, String(code), "provider_rejected", nextAttempt.toISOString());
      return { processed: true, state: "retryable" as const, deliveryId: delivery.id };
    }
    const ambiguous = code === 0;
    finishSend(delivery, ambiguous ? "ambiguous" : "permanent", finishedAt, code ? String(code) : "network", ambiguous ? "unknown_acceptance" : "provider_rejected", null);
    db.prepare("UPDATE push_subscriptions SET failure_count = failure_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?")
      .run(delivery.subscription_id, delivery.user_id);
    return { processed: true, state: ambiguous ? "ambiguous" as const : "permanent" as const, deliveryId: delivery.id };
  }
}

export function pauseNotificationWorker(now = Date.now()) {
  const owner = randomUUID();
  db.prepare(`
    UPDATE notification_runtime
    SET paused = 1, pause_until = ?, pause_owner = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(new Date(now + RESTORE_PAUSE_MS).toISOString(), owner);
  return owner;
}

export function resumeNotificationWorker(owner: string, incrementGeneration = false) {
  db.prepare(`
    UPDATE notification_runtime
    SET paused = 0, pause_until = NULL, pause_owner = NULL,
        generation = generation + ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1 AND pause_owner = ?
  `).run(incrementGeneration ? 1 : 0, owner);
}
