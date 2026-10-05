import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const temp = mkdtempSync(path.join(tmpdir(), "planner-notification-worker-"));
const dbFile = path.join(temp, "worker.db");
process.env.DATABASE_PATH = dbFile;
process.env.MULTI_USER_DATABASE_PATH = dbFile;
process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.APP_ORIGIN = "http://localhost:3000";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    return next(specifier.startsWith("@/")
      ? pathToFileURL(path.resolve(import.meta.dirname, "..", `${specifier.slice(2)}.ts`)).href
      : specifier, context);
  },
});

const { db, createSession, SESSION_COOKIE, DATABASE_SCHEMA_VERSION } = await import("../lib/db-multi.ts");
const jobs = await import("../lib/notification-jobs.ts");
const worker = await import("../lib/notification-worker.ts");
const push = await import("../lib/push-notifications.ts");
const preferencesRoute = await import("../app/api/notifications/preferences/route.ts");
const focusRoute = await import("../app/api/notifications/focus/route.ts");

function insertUser(email) {
  return Number(db.prepare("INSERT INTO users (display_name, primary_email, role, status) VALUES (?, ?, 'member', 'active')").run(email, email).lastInsertRowid);
}

const userA = insertUser("worker-a@example.test");
const userB = insertUser("worker-b@example.test");
const sessionA = createSession(userA);
const sessionB = createSession(userB);
const cookieA = `${SESSION_COOKIE}=${sessionA.rawToken}`;
const cookieB = `${SESSION_COOKIE}=${sessionB.rawToken}`;

function request(pathname, { method = "GET", cookie = cookieA, body, origin = "http://localhost:3000" } = {}) {
  const headers = { cookie };
  if (method !== "GET") headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost:3000${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function sample(suffix) {
  return push.parsePushSubscription({
    endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`,
    expirationTime: null,
    keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
    deviceName: `Chrome ${suffix}`,
  });
}

function enable(userId) {
  jobs.updateFocusPreference(userId, true);
}

beforeEach(() => {
  db.exec(`
    DELETE FROM notification_deliveries;
    DELETE FROM notification_jobs;
    DELETE FROM notification_preferences;
    DELETE FROM push_subscriptions;
    UPDATE notification_runtime SET paused = 0, in_flight = 0, pause_until = NULL, pause_owner = NULL, heartbeat_at = NULL, worker_id = NULL WHERE id = 1;
  `);
});

after(() => {
  db.close();
  hooks.deregister();
  rmSync(temp, { recursive: true, force: true });
});

test("schema v5 sukuria patvarų pranešimų registrą", () => {
  assert.equal(DATABASE_SCHEMA_VERSION, 5);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 5);
  for (const table of ["notification_preferences", "notification_jobs", "notification_deliveries", "notification_runtime"]) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  }
});

test("nuostatos ir fokusavimo API yra apsaugoti nuo CSRF ir atskirti pagal naudotoją", async () => {
  const forbidden = await preferencesRoute.PATCH(request("/api/notifications/preferences", { method: "PATCH", origin: "https://evil.example", body: { focusEndEnabled: true } }));
  assert.equal(forbidden.status, 403);
  const enabled = await preferencesRoute.PATCH(request("/api/notifications/preferences", { method: "PATCH", body: { focusEndEnabled: true } }));
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).focusEnd.enabled, true);
  assert.equal(jobs.getNotificationPreferences(userB).focusEnd.enabled, false);

  const now = Date.parse("2026-10-05T10:00:00.000Z");
  const operationId = "11111111-1111-4111-8111-111111111111";
  const first = jobs.scheduleFocusEnd(userA, operationId, new Date(now + 60_000).toISOString(), now);
  const repeated = jobs.scheduleFocusEnd(userA, operationId, new Date(now + 60_000).toISOString(), now);
  assert.equal(first.jobId, repeated.jobId);
  assert.throws(
    () => jobs.scheduleFocusEnd(userA, operationId, new Date(now + 90_000).toISOString(), now),
    (error) => error instanceof jobs.NotificationJobError && error.status === 409,
  );
  assert.equal(db.prepare("SELECT run_at FROM notification_jobs WHERE id = ?").get(first.jobId).run_at, new Date(now + 60_000).toISOString());
  assert.equal(jobs.cancelFocusEnd(userB, operationId).cancelled, true);
  assert.equal(db.prepare("SELECT cancelled_at FROM notification_jobs WHERE id = ?").get(first.jobId).cancelled_at, null);

  const racedOperation = "99999999-9999-4999-8999-999999999999";
  assert.equal(jobs.cancelFocusEnd(userA, racedOperation).cancelled, true);
  assert.deepEqual(
    jobs.scheduleFocusEnd(userA, racedOperation, new Date(now + 90_000).toISOString(), now),
    { scheduled: false, reason: "cancelled" },
  );
  assert.ok(db.prepare("SELECT cancelled_at FROM notification_jobs WHERE user_id = ? AND source_key = ?").get(userA, racedOperation).cancelled_at);

  const apiOperation = "22222222-2222-4222-8222-222222222222";
  const apiScheduled = await focusRoute.POST(request("/api/notifications/focus", {
    method: "POST",
    body: { operationId: apiOperation, endsAt: new Date(Date.now() + 60_000).toISOString() },
  }));
  assert.equal(apiScheduled.status, 200);
  const foreignCancel = await focusRoute.DELETE(request("/api/notifications/focus", { method: "DELETE", cookie: cookieB, body: { operationId: apiOperation } }));
  assert.equal(foreignCancel.status, 200);
  assert.equal((await foreignCancel.json()).cancelled, true);
});

test("workeris išplečia vieną darbą į visus įrenginius ir kiekvieną siunčia vieną kartą", async () => {
  enable(userA);
  push.savePushSubscription(userA, sample("fanout-a"));
  push.savePushSubscription(userA, sample("fanout-b"));
  const start = Date.parse("2026-10-05T11:00:00.000Z");
  jobs.scheduleFocusEnd(userA, "33333333-3333-4333-8333-333333333333", new Date(start + 5_000).toISOString(), start);
  const sent = [];
  const send = async (subscription, payload) => { sent.push({ id: subscription.id, payload }); };
  const due = new Date(start + 6_000);
  assert.equal((await worker.processNotificationTick({ workerId: "one", now: due, send })).state, "accepted");
  assert.equal((await worker.processNotificationTick({ workerId: "two", now: due, send })).state, "accepted");
  assert.equal((await worker.processNotificationTick({ workerId: "three", now: due, send })).processed, false);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((item) => item.payload), [{ v: 1, type: "focus_end" }, { v: 1, type: "focus_end" }]);
  assert.equal(new Set(sent.map((item) => item.id)).size, 2);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM notification_deliveries WHERE state = 'accepted'").get().count, 2);
});

test("du workeriai negali paimti tos pačios pristatymo eilutės", async () => {
  enable(userA);
  push.savePushSubscription(userA, sample("concurrent"));
  const start = Date.parse("2026-10-05T12:00:00.000Z");
  jobs.scheduleFocusEnd(userA, "44444444-4444-4444-8444-444444444444", new Date(start + 5_000).toISOString(), start);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let sends = 0;
  const send = async () => { sends += 1; await gate; };
  const due = new Date(start + 6_000);
  const first = worker.processNotificationTick({ workerId: "concurrent-a", now: due, send });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await worker.processNotificationTick({ workerId: "concurrent-b", now: due, send });
  assert.equal(second.processed, false);
  release();
  await first;
  assert.equal(sends, 1);
});

test("aiškus 503 kartojamas, o neaiški nutrūkusi siunta nebekartojama", async () => {
  enable(userA);
  push.savePushSubscription(userA, sample("retry"));
  const start = Date.parse("2026-10-05T13:00:00.000Z");
  jobs.scheduleFocusEnd(userA, "55555555-5555-4555-8555-555555555555", new Date(start + 5_000).toISOString(), start);
  const due = new Date(start + 6_000);
  const rejected = Object.assign(new Error("rejected"), { statusCode: 503 });
  const first = await worker.processNotificationTick({ workerId: "retry-a", now: due, send: async () => { throw rejected; } });
  assert.equal(first.state, "retryable");
  const accepted = await worker.processNotificationTick({ workerId: "retry-b", now: new Date(due.getTime() + 31_000), send: async () => undefined });
  assert.equal(accepted.state, "accepted");

  push.savePushSubscription(userA, sample("ambiguous"));
  jobs.scheduleFocusEnd(userA, "66666666-6666-4666-8666-666666666666", new Date(start + 10_000).toISOString(), start);
  const ambiguous = await worker.processNotificationTick({ workerId: "ambiguous", now: new Date(start + 11_000), send: async () => { throw new Error("timeout"); } });
  assert.equal(ambiguous.state, "ambiguous");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM notification_deliveries WHERE state = 'retryable'").get().count, 0);
});

test("404 pašalina nebegaliojančią prenumeratą, o išjungimas atšaukia laukiančius darbus", async () => {
  enable(userA);
  const subscriptionId = push.savePushSubscription(userA, sample("gone"));
  const start = Date.parse("2026-10-05T14:00:00.000Z");
  jobs.scheduleFocusEnd(userA, "77777777-7777-4777-8777-777777777777", new Date(start + 5_000).toISOString(), start);
  const gone = Object.assign(new Error("gone"), { statusCode: 410 });
  assert.equal((await worker.processNotificationTick({ workerId: "gone", now: new Date(start + 6_000), send: async () => { throw gone; } })).state, "permanent");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM push_subscriptions WHERE id = ?").get(subscriptionId).count, 0);

  jobs.scheduleFocusEnd(userA, "88888888-8888-4888-8888-888888888888", new Date(start + 20_000).toISOString(), start);
  jobs.updateFocusPreference(userA, false);
  assert.ok(db.prepare("SELECT cancelled_at FROM notification_jobs WHERE source_key = ?").get("88888888-8888-4888-8888-888888888888").cancelled_at);
});

test("vietinė konfigūracijos klaida nėra laikoma neaiškia siunta, o sugadinta prenumerata pašalinama", async () => {
  enable(userA);
  const configuredSubscription = push.savePushSubscription(userA, sample("local-config"));
  const start = Date.parse("2026-10-05T15:00:00.000Z");
  jobs.scheduleFocusEnd(userA, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", new Date(start + 5_000).toISOString(), start);
  const configurationError = new push.PushNotificationError("missing", 409, "push_not_configured");
  const configurationResult = await worker.processNotificationTick({
    workerId: "local-config",
    now: new Date(start + 6_000),
    send: async () => { throw configurationError; },
  });
  assert.equal(configurationResult.state, "permanent");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM push_subscriptions WHERE id = ?").get(configuredSubscription).count, 1);
  assert.equal(db.prepare("SELECT error_code FROM notification_deliveries ORDER BY id DESC LIMIT 1").get().error_code, "push_not_configured");
  push.deletePushSubscription(userA, configuredSubscription);

  const corruptSubscription = push.savePushSubscription(userA, sample("corrupt"));
  jobs.scheduleFocusEnd(userA, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", new Date(start + 10_000).toISOString(), start);
  const corruptError = new push.PushNotificationError("corrupt", 409, "subscription_corrupt");
  const corruptResult = await worker.processNotificationTick({
    workerId: "corrupt",
    now: new Date(start + 11_000),
    send: async () => { throw corruptError; },
  });
  assert.equal(corruptResult.state, "permanent");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM push_subscriptions WHERE id = ?").get(corruptSubscription).count, 0);
});

test("pasenusi pauzė atsistato, o dingusios prenumeratos ir pasenusios eilės užbaigiamos", async () => {
  enable(userA);
  const start = Date.parse("2026-10-05T16:00:00.000Z");
  const subscriptionId = push.savePushSubscription(userA, sample("recovery"));
  const missingJob = jobs.scheduleFocusEnd(userA, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", new Date(start + 5_000).toISOString(), start);
  db.prepare("UPDATE notification_jobs SET expanded_at = ? WHERE id = ?").run(new Date(start + 5_000).toISOString(), missingJob.jobId);
  db.prepare("INSERT INTO notification_deliveries (job_id, subscription_id, state, next_attempt_at) VALUES (?, ?, 'queued', ?)")
    .run(missingJob.jobId, subscriptionId, new Date(start + 5_000).toISOString());
  push.deletePushSubscription(userA, subscriptionId);

  const expiredSubscription = push.savePushSubscription(userA, sample("expired"));
  const expiredJob = jobs.scheduleFocusEnd(userA, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", new Date(start + 10_000).toISOString(), start);
  db.prepare("UPDATE notification_jobs SET expanded_at = ?, expires_at = ? WHERE id = ?")
    .run(new Date(start + 10_000).toISOString(), new Date(start + 11_000).toISOString(), expiredJob.jobId);
  db.prepare("INSERT INTO notification_deliveries (job_id, subscription_id, state, next_attempt_at) VALUES (?, ?, 'queued', ?)")
    .run(expiredJob.jobId, expiredSubscription, new Date(start + 10_000).toISOString());

  const pauseOwner = worker.pauseNotificationWorker(start);
  assert.equal((await worker.processNotificationTick({ workerId: "paused", now: new Date(start + 12_000), send: async () => undefined })).reason, "paused");
  assert.ok(db.prepare("SELECT pause_owner FROM notification_runtime WHERE id = 1").get().pause_owner === pauseOwner);
  assert.equal((await worker.processNotificationTick({ workerId: "recovered", now: new Date(start + 5 * 60_000 + 1), send: async () => undefined })).processed, false);
  assert.equal(db.prepare("SELECT paused FROM notification_runtime WHERE id = 1").get().paused, 0);
  assert.equal(db.prepare("SELECT state FROM notification_deliveries WHERE job_id = ?").get(missingJob.jobId).state, "permanent");
  assert.equal(db.prepare("SELECT error_code FROM notification_deliveries WHERE job_id = ?").get(missingJob.jobId).error_code, "subscription_missing");
  assert.equal(db.prepare("SELECT error_code FROM notification_deliveries WHERE job_id = ?").get(expiredJob.jobId).error_code, "job_expired");
  assert.ok(db.prepare("SELECT completed_at FROM notification_jobs WHERE id = ?").get(missingJob.jobId).completed_at);
  assert.ok(db.prepare("SELECT completed_at FROM notification_jobs WHERE id = ?").get(expiredJob.jobId).completed_at);
});

test("vieno naudotojo aktyvūs darbai ir naujų operacijų tempas yra ribojami", () => {
  enable(userA);
  const start = Date.now();
  for (let index = 0; index < 10; index += 1) {
    const suffix = String(index).padStart(12, "0");
    jobs.scheduleFocusEnd(userA, `eeeeeeee-eeee-4eee-8eee-${suffix}`, new Date(start + 60_000 + index).toISOString(), start);
  }
  assert.throws(
    () => jobs.scheduleFocusEnd(userA, "eeeeeeee-eeee-4eee-8eee-999999999999", new Date(start + 120_000).toISOString(), start),
    (error) => error instanceof jobs.NotificationJobError && error.status === 429,
  );

  db.prepare("DELETE FROM notification_jobs WHERE user_id = ?").run(userA);
  for (let index = 0; index < 60; index += 1) {
    const suffix = String(index).padStart(12, "0");
    jobs.cancelFocusEnd(userA, `ffffffff-ffff-4fff-8fff-${suffix}`);
  }
  assert.throws(
    () => jobs.cancelFocusEnd(userA, "ffffffff-ffff-4fff-8fff-999999999999"),
    (error) => error instanceof jobs.NotificationJobError && error.status === 429,
  );
});
