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
    DELETE FROM task_plans WHERE user_id IN (${userA}, ${userB});
    DELETE FROM tasks WHERE user_id IN (${userA}, ${userB});
    UPDATE notification_runtime SET paused = 0, in_flight = 0, pause_until = NULL, pause_owner = NULL, heartbeat_at = NULL, worker_id = NULL WHERE id = 1;
  `);
});

after(() => {
  db.close();
  hooks.deregister();
  rmSync(temp, { recursive: true, force: true });
});

test("schema v7 sukuria patvarų pranešimų ir veiksmų registrą", () => {
  assert.equal(DATABASE_SCHEMA_VERSION, 7);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 7);
  for (const table of ["notification_preferences", "notification_jobs", "notification_deliveries", "notification_runtime"]) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  }
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'action_journal'").get());
});

test("nuostatos ir fokusavimo API yra apsaugoti nuo CSRF ir atskirti pagal naudotoją", async () => {
  const forbidden = await preferencesRoute.PATCH(request("/api/notifications/preferences", { method: "PATCH", origin: "https://evil.example", body: { focusEndEnabled: true } }));
  assert.equal(forbidden.status, 403);
  const enabled = await preferencesRoute.PATCH(request("/api/notifications/preferences", { method: "PATCH", body: { focusEndEnabled: true } }));
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).focusEnd.enabled, true);
  assert.equal(jobs.getNotificationPreferences(userB).focusEnd.enabled, false);
  assert.deepEqual(jobs.getNotificationPreferences(userA).taskStart, { enabled: false, leadMinutes: 10 });

  const invalidTaskStart = await preferencesRoute.PATCH(request("/api/notifications/preferences", {
    method: "PATCH",
    body: { taskStartEnabled: true, taskStartLeadMinutes: 7 },
  }));
  assert.equal(invalidTaskStart.status, 400);

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

test("užduoties pradžios nuostata sukuria, pakeičia ir atšaukia vieną aktyvią darbo kartą", async () => {
  const start = Date.parse("2099-11-05T10:00:00.000Z");
  const taskKey = "local:501";
  db.prepare("INSERT INTO tasks (id, user_id, title) VALUES (501, ?, 'Primenama')").run(userA);
  db.prepare("INSERT INTO task_plans (user_id, task_key, scheduled_at, schedule_version) VALUES (?, ?, ?, 1)")
    .run(userA, taskKey, new Date(start).toISOString());
  const enabled = await preferencesRoute.PATCH(request("/api/notifications/preferences", {
    method: "PATCH",
    body: { taskStartEnabled: true, taskStartLeadMinutes: 10 },
  }));
  assert.equal(enabled.status, 200);
  assert.deepEqual((await enabled.json()).taskStart, { enabled: true, leadMinutes: 10 });

  let active = db.prepare(`SELECT id, run_at, expires_at FROM notification_jobs
    WHERE user_id = ? AND scenario = 'task_start' AND cancelled_at IS NULL AND completed_at IS NULL`).all(userA);
  assert.equal(active.length, 1);
  assert.equal(active[0].run_at, "2099-11-05T09:50:00.000Z");
  assert.equal(active[0].expires_at, "2099-11-05T10:15:00.000Z");

  const hooks = jobs.createTaskStartNotificationHooks(db, userA, () => Date.parse("2099-10-05T10:00:00.000Z"));
  hooks.sync(taskKey, "2099-11-05T10:00:00.000Z", 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM notification_jobs WHERE user_id = ? AND scenario = 'task_start'").get(userA).count, 1);

  hooks.sync(taskKey, "2099-11-05T11:00:00.000Z", 2);
  active = db.prepare(`SELECT id, run_at FROM notification_jobs
    WHERE user_id = ? AND scenario = 'task_start' AND cancelled_at IS NULL AND completed_at IS NULL`).all(userA);
  assert.equal(active.length, 1);
  assert.equal(active[0].run_at, "2099-11-05T10:50:00.000Z");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM notification_jobs WHERE user_id = ? AND scenario = 'task_start' AND cancelled_at IS NOT NULL").get(userA).count, 1);

  const disabled = await preferencesRoute.PATCH(request("/api/notifications/preferences", {
    method: "PATCH",
    body: { taskStartEnabled: false, taskStartLeadMinutes: 10 },
  }));
  assert.equal(disabled.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM notification_jobs WHERE user_id = ? AND scenario = 'task_start' AND cancelled_at IS NULL AND completed_at IS NULL").get(userA).count, 0);
});

test("užduoties pradžios workeris siunčia tik fiksuotą privatų payload", async () => {
  push.savePushSubscription(userA, sample("task-start"));
  const startsAt = Date.parse("2099-11-05T12:00:00.000Z");
  jobs.updateTaskStartPreference(userA, true, 5);
  const hooks = jobs.createTaskStartNotificationHooks(db, userA, () => startsAt - 60 * 60_000);
  hooks.sync("local:777", new Date(startsAt).toISOString(), 1);
  const sent = [];
  const result = await worker.processNotificationTick({
    workerId: "task-start",
    now: new Date(startsAt - 4 * 60_000),
    send: async (_subscription, payload) => { sent.push(payload); },
  });
  assert.equal(result.state, "accepted");
  assert.deepEqual(sent, [{ v: 1, type: "task_start" }]);
  hooks.sync("local:777", new Date(startsAt).toISOString(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM notification_jobs WHERE user_id = ? AND scenario = 'task_start'").get(userA).count, 1);
  assert.equal((await worker.processNotificationTick({ workerId: "task-start-repeat", now: new Date(startsAt - 3 * 60_000), send: async () => { throw new Error("must not resend"); } })).processed, false);
});

test("ryto ir vakaro nuostatos atominiu būdu sukuria po vieną vietinės dienos darbą", async () => {
  const now = Date.parse("2026-10-05T04:00:00.000Z"); // 07:00 Europe/Vilnius
  const input = {
    timeZone: "Europe/Vilnius",
    morningPlan: { enabled: true, localTime: "08:00" },
    eveningClose: { enabled: true, localTime: "18:00" },
  };
  const preferences = jobs.updateDailyRitualPreferences(userA, input, now);
  assert.deepEqual(preferences.dailyRituals, { ...input, timeZone: "Europe/Vilnius" });
  assert.deepEqual(jobs.getNotificationPreferences(userB).dailyRituals, {
    timeZone: null,
    morningPlan: { enabled: false, localTime: "08:00" },
    eveningClose: { enabled: false, localTime: "18:00" },
  });
  assert.deepEqual(db.prepare(`
    SELECT scenario, source_key, run_at, expires_at FROM notification_jobs
    WHERE user_id = ? AND scenario IN ('morning_plan', 'evening_close') ORDER BY scenario
  `).all(userA).map((row) => ({ ...row })), [
    { scenario: "evening_close", source_key: "2026-10-05", run_at: "2026-10-05T15:00:00.000Z", expires_at: "2026-10-05T17:00:00.000Z" },
    { scenario: "morning_plan", source_key: "2026-10-05", run_at: "2026-10-05T05:00:00.000Z", expires_at: "2026-10-05T07:00:00.000Z" },
  ]);
  jobs.updateDailyRitualPreferences(userA, input, now);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM notification_jobs WHERE user_id = ?").get(userA).count, 2);

  const invalidZone = await preferencesRoute.PATCH(request("/api/notifications/preferences", {
    method: "PATCH",
    body: { dailyRituals: { ...input, timeZone: "+03:00" } },
  }));
  assert.equal(invalidZone.status, 400);
  const partial = await preferencesRoute.PATCH(request("/api/notifications/preferences", {
    method: "PATCH",
    body: { dailyRituals: { timeZone: "UTC", morningPlan: input.morningPlan } },
  }));
  assert.equal(partial.status, 400);
  const mixed = await preferencesRoute.PATCH(request("/api/notifications/preferences", {
    method: "PATCH",
    body: { focusEndEnabled: true, dailyRituals: input },
  }));
  assert.equal(mixed.status, 400);
  const apiSaved = await preferencesRoute.PATCH(request("/api/notifications/preferences", {
    method: "PATCH",
    cookie: cookieB,
    body: { dailyRituals: input },
  }));
  assert.equal(apiSaved.status, 200);
  assert.deepEqual((await apiSaved.json()).dailyRituals, { ...input, timeZone: "Europe/Vilnius" });
  assert.equal(jobs.getNotificationPreferences(userA).dailyRituals.morningPlan.enabled, true);
});

test("dienos ritualai laikosi DST taisyklės ir proceso laiko zonos", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    jobs.updateDailyRitualPreferences(userA, {
      timeZone: "Europe/Vilnius",
      morningPlan: { enabled: true, localTime: "03:30" },
      eveningClose: { enabled: false, localTime: "18:00" },
    }, Date.parse("2026-03-28T12:00:00.000Z"));
    assert.equal(db.prepare("SELECT run_at FROM notification_jobs WHERE user_id = ? AND scenario = 'morning_plan'").get(userA).run_at, "2026-03-29T01:30:00.000Z");

    jobs.updateDailyRitualPreferences(userB, {
      timeZone: "Europe/Vilnius",
      morningPlan: { enabled: true, localTime: "03:30" },
      eveningClose: { enabled: false, localTime: "18:00" },
    }, Date.parse("2026-10-24T12:00:00.000Z"));
    assert.equal(db.prepare("SELECT run_at FROM notification_jobs WHERE user_id = ? AND scenario = 'morning_plan'").get(userB).run_at, "2026-10-25T00:30:00.000Z");
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

test("ritualo workeris pristato patvarų darbą per dviejų valandų langą tik vieną kartą", async () => {
  push.savePushSubscription(userA, sample("morning-plan"));
  const before = Date.parse("2026-10-05T04:00:00.000Z");
  jobs.updateDailyRitualPreferences(userA, {
    timeZone: "Europe/Vilnius",
    morningPlan: { enabled: true, localTime: "08:00" },
    eveningClose: { enabled: false, localTime: "18:00" },
  }, before);
  const sent = [];
  const due = new Date("2026-10-05T05:30:00.000Z");
  assert.equal((await worker.processNotificationTick({ workerId: "morning-late", now: due, send: async (_subscription, payload) => sent.push(payload) })).state, "accepted");
  assert.deepEqual(sent, [{ v: 1, type: "morning_plan" }]);
  assert.equal((await worker.processNotificationTick({ workerId: "morning-repeat", now: due, send: async () => { throw new Error("must not resend"); } })).processed, false);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM notification_jobs WHERE user_id = ? AND scenario = 'morning_plan' AND source_key = '2026-10-05'").get(userA).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM notification_jobs WHERE user_id = ? AND scenario = 'morning_plan' AND source_key = '2026-10-06' AND cancelled_at IS NULL").get(userA).count, 1);
});

test("pasibaigus ritualo dviejų valandų langui praleistas darbas nebesiunčiamas", async () => {
  push.savePushSubscription(userA, sample("morning-expired"));
  jobs.updateDailyRitualPreferences(userA, {
    timeZone: "UTC",
    morningPlan: { enabled: true, localTime: "08:00" },
    eveningClose: { enabled: false, localTime: "18:00" },
  }, Date.parse("2026-10-05T07:00:00.000Z"));
  let sends = 0;
  const result = await worker.processNotificationTick({
    workerId: "morning-expired",
    now: new Date("2026-10-05T10:00:01.000Z"),
    send: async () => { sends += 1; },
  });
  assert.equal(result.processed, false);
  assert.equal(sends, 0);
  assert.ok(db.prepare("SELECT completed_at FROM notification_jobs WHERE user_id = ? AND scenario = 'morning_plan' AND source_key = '2026-10-05'").get(userA).completed_at);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM notification_jobs WHERE user_id = ? AND scenario = 'morning_plan' AND source_key = '2026-10-06' AND cancelled_at IS NULL").get(userA).count, 1);
});

test("pakeitus jau išplėstą ritualą naujas tos pačios vietinės dienos priminimas nekuriamas", async () => {
  push.savePushSubscription(userA, sample("ritual-change"));
  const input = {
    timeZone: "UTC",
    morningPlan: { enabled: true, localTime: "08:00" },
    eveningClose: { enabled: false, localTime: "18:00" },
  };
  jobs.updateDailyRitualPreferences(userA, input, Date.parse("2026-10-05T07:00:00.000Z"));
  assert.equal((await worker.processNotificationTick({ workerId: "ritual-consumed", now: new Date("2026-10-05T08:01:00.000Z"), send: async () => undefined })).state, "accepted");
  jobs.updateDailyRitualPreferences(userA, {
    ...input,
    timeZone: "America/New_York",
    morningPlan: { enabled: true, localTime: "10:00" },
  }, Date.parse("2026-10-05T08:05:00.000Z"));
  const active = db.prepare(`
    SELECT source_key, run_at FROM notification_jobs
    WHERE user_id = ? AND scenario = 'morning_plan' AND cancelled_at IS NULL AND completed_at IS NULL
  `).all(userA).map((row) => ({ ...row }));
  assert.deepEqual(active, [{ source_key: "2026-10-06", run_at: "2026-10-06T14:00:00.000Z" }]);
});

test("nekintantis 0 min. planas po pradžios neatšaukia dar galiojančio darbo", async () => {
  push.savePushSubscription(userA, sample("task-start-zero"));
  const startsAt = Date.parse("2099-11-05T13:00:00.000Z");
  jobs.updateTaskStartPreference(userA, true, 0);
  jobs.createTaskStartNotificationHooks(db, userA, () => startsAt - 60_000)
    .sync("local:zero", new Date(startsAt).toISOString(), 1);
  jobs.createTaskStartNotificationHooks(db, userA, () => startsAt + 1_000)
    .sync("local:zero", new Date(startsAt).toISOString(), 1);
  const scheduled = db.prepare("SELECT id, cancelled_at FROM notification_jobs WHERE user_id = ? AND scenario = 'task_start'").get(userA);
  assert.equal(scheduled.cancelled_at, null);
  assert.equal((await worker.processNotificationTick({ workerId: "task-start-zero", now: new Date(startsAt + 1_000), send: async () => undefined })).state, "accepted");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM notification_jobs WHERE user_id = ? AND scenario = 'task_start'").get(userA).count, 1);
});

test("Google užduoties perkėlimas išsaugo jau priimtą priminimo kartą", async () => {
  push.savePushSubscription(userA, sample("moved-accepted"));
  jobs.updateTaskStartPreference(userA, true, 5);
  const startsAt = Date.parse("2099-11-06T12:00:00.000Z");
  const oldKey = "google:old-list:accepted";
  const newKey = "google:new-list:accepted";
  const taskHooks = jobs.createTaskStartNotificationHooks(db, userA, () => startsAt - 60 * 60_000);
  taskHooks.sync(oldKey, new Date(startsAt).toISOString(), 1);
  const before = db.prepare("SELECT id, source_key FROM notification_jobs WHERE user_id = ? AND scenario = 'task_start'").get(userA);
  assert.equal((await worker.processNotificationTick({ workerId: "move-accepted", now: new Date(startsAt - 4 * 60_000), send: async () => undefined })).state, "accepted");

  taskHooks.move(oldKey, newKey, new Date(startsAt).toISOString(), 2);
  const after = db.prepare("SELECT id, source_key, completed_at FROM notification_jobs WHERE user_id = ? AND scenario = 'task_start'").get(userA);
  assert.equal(after.id, before.id);
  assert.notEqual(after.source_key, before.source_key);
  assert.ok(after.completed_at);
  assert.equal((await worker.processNotificationTick({ workerId: "move-accepted-repeat", now: new Date(startsAt - 3 * 60_000), send: async () => { throw new Error("must not resend"); } })).processed, false);
});

test("atšaukta užbaigta užduotis gali būti iš naujo suplanuota tuo pačiu laiku", () => {
  jobs.updateTaskStartPreference(userA, true, 5);
  const startsAt = Date.parse("2099-11-06T14:00:00.000Z");
  const taskKey = "local:reopened";
  const taskHooks = jobs.createTaskStartNotificationHooks(db, userA, () => startsAt - 60 * 60_000);
  taskHooks.sync(taskKey, new Date(startsAt).toISOString(), 1);
  db.prepare("UPDATE notification_jobs SET completed_at = CURRENT_TIMESTAMP WHERE user_id = ? AND scenario = 'task_start'").run(userA);
  taskHooks.cancel(taskKey);
  taskHooks.sync(taskKey, new Date(startsAt).toISOString(), 2);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM notification_jobs WHERE user_id = ? AND scenario = 'task_start'").get(userA).count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM notification_jobs WHERE user_id = ? AND scenario = 'task_start' AND cancelled_at IS NULL AND completed_at IS NULL").get(userA).count, 1);
});

test("Google užduoties perkėlimas išsaugo neaiškią pristatymo būseną", async () => {
  push.savePushSubscription(userA, sample("moved-ambiguous"));
  jobs.updateTaskStartPreference(userA, true, 5);
  const startsAt = Date.parse("2099-11-07T12:00:00.000Z");
  const oldKey = "google:old-list:ambiguous";
  const newKey = "google:new-list:ambiguous";
  const taskHooks = jobs.createTaskStartNotificationHooks(db, userA, () => startsAt - 60 * 60_000);
  taskHooks.sync(oldKey, new Date(startsAt).toISOString(), 1);
  const jobId = db.prepare("SELECT id FROM notification_jobs WHERE user_id = ? AND scenario = 'task_start'").get(userA).id;
  assert.equal((await worker.processNotificationTick({ workerId: "move-ambiguous", now: new Date(startsAt - 4 * 60_000), send: async () => { throw new Error("timeout"); } })).state, "ambiguous");

  taskHooks.move(oldKey, newKey, new Date(startsAt).toISOString(), 2);
  assert.equal(db.prepare("SELECT id FROM notification_jobs WHERE user_id = ? AND scenario = 'task_start'").get(userA).id, jobId);
  assert.equal(db.prepare("SELECT state FROM notification_deliveries WHERE job_id = ?").get(jobId).state, "ambiguous");
  assert.equal((await worker.processNotificationTick({ workerId: "move-ambiguous-repeat", now: new Date(startsAt - 3 * 60_000), send: async () => { throw new Error("must not resend"); } })).processed, false);
});

test("Google užduoties perkėlimas nekeičia dalinai išsiųsto kelių įrenginių darbo", async () => {
  push.savePushSubscription(userA, sample("moved-partial-a"));
  push.savePushSubscription(userA, sample("moved-partial-b"));
  jobs.updateTaskStartPreference(userA, true, 5);
  const startsAt = Date.parse("2099-11-08T12:00:00.000Z");
  const oldKey = "google:old-list:partial";
  const newKey = "google:new-list:partial";
  const taskHooks = jobs.createTaskStartNotificationHooks(db, userA, () => startsAt - 60 * 60_000);
  taskHooks.sync(oldKey, new Date(startsAt).toISOString(), 1);
  const sent = [];
  const send = async (subscription) => { sent.push(subscription.id); };
  const due = new Date(startsAt - 4 * 60_000);
  assert.equal((await worker.processNotificationTick({ workerId: "move-partial-a", now: due, send })).state, "accepted");
  const jobId = db.prepare("SELECT id FROM notification_jobs WHERE user_id = ? AND scenario = 'task_start'").get(userA).id;

  taskHooks.move(oldKey, newKey, new Date(startsAt).toISOString(), 2);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM notification_jobs WHERE user_id = ? AND scenario = 'task_start'").get(userA).count, 1);
  assert.deepEqual(db.prepare("SELECT state FROM notification_deliveries WHERE job_id = ? ORDER BY id").all(jobId).map(row => row.state), ["accepted", "queued"]);
  assert.equal((await worker.processNotificationTick({ workerId: "move-partial-b", now: due, send })).state, "accepted");
  assert.equal((await worker.processNotificationTick({ workerId: "move-partial-done", now: due, send })).processed, false);
  assert.equal(new Set(sent).size, 2);
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
