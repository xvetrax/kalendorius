import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import webPush from "web-push";

const temp = mkdtempSync(path.join(tmpdir(), "planner-push-"));
const dbFile = path.join(temp, "push.db");
process.env.DATABASE_PATH = dbFile;
process.env.MULTI_USER_DATABASE_PATH = dbFile;
process.env.TOKEN_ENCRYPTION_KEY = "cd".repeat(32);
process.env.APP_ORIGIN = "http://localhost:3000";
const vapid = webPush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
process.env.VAPID_SUBJECT = "mailto:test@example.test";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    return next(specifier.startsWith("@/")
      ? pathToFileURL(path.resolve(import.meta.dirname, "..", `${specifier.slice(2)}.ts`)).href
      : specifier, context);
  },
});

const { db, createSession, SESSION_COOKIE } = await import("../lib/db-multi.ts");
const push = await import("../lib/push-notifications.ts");
const subscriptionsRoute = await import("../app/api/push/subscriptions/route.ts");
const testRoute = await import("../app/api/push/test/route.ts");
const logoutRoute = await import("../app/api/auth/logout/route.ts");
const originalSend = webPush.sendNotification;

function insertUser(email) {
  return Number(db.prepare(
    "INSERT INTO users (display_name, primary_email, role, status) VALUES (?, ?, 'member', 'active')",
  ).run(email, email).lastInsertRowid);
}

const userA = insertUser("push-a@example.test");
const userB = insertUser("push-b@example.test");
const sessionA = createSession(userA);
const sessionB = createSession(userB);
const cookieA = `${SESSION_COOKIE}=${sessionA.rawToken}`;
const cookieB = `${SESSION_COOKIE}=${sessionB.rawToken}`;

function sample(endpoint = "https://fcm.googleapis.com/fcm/send/subscription-a", deviceName = "Test Chrome") {
  return {
    endpoint,
    expirationTime: null,
    keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
    deviceName,
  };
}

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

beforeEach(() => {
  db.prepare("DELETE FROM push_subscriptions").run();
  db.prepare("DELETE FROM push_rate_limits").run();
  webPush.sendNotification = async () => ({ statusCode: 201, headers: {}, body: "" });
});

after(() => {
  webPush.sendNotification = originalSend;
  db.close();
  hooks.deregister();
  rmSync(temp, { recursive: true, force: true });
});

test("push prenumerata saugoma užšifruota ir atskirta pagal naudotoją", () => {
  const input = push.parsePushSubscription(sample());
  const id = push.savePushSubscription(userA, input);
  const row = db.prepare("SELECT * FROM push_subscriptions WHERE id = ?").get(id);
  assert.equal(row.user_id, userA);
  assert.equal(row.endpoint_hash, createHash("sha256").update(input.endpoint).digest("hex"));
  assert.ok(!row.encrypted_subscription.includes(input.endpoint));
  assert.ok(!row.encrypted_subscription.includes(input.keys.auth));
  assert.deepEqual(push.listPushSubscriptions(userB), []);
  assert.throws(() => push.savePushSubscription(userB, input), (error) => error.status === 409);

  const sameId = push.savePushSubscription(userA, { ...input, deviceName: "Pervadintas" });
  assert.equal(sameId, id);
  assert.equal(push.listPushSubscriptions(userA)[0].deviceName, "Pervadintas");
});

test("prenumeratų API reikalauja sesijos, same-origin ir slepia pristatymo paslaptis", async () => {
  const unauthorized = await subscriptionsRoute.GET(request("/api/push/subscriptions", { cookie: "" }));
  assert.equal(unauthorized.status, 401);

  const csrf = await subscriptionsRoute.POST(request("/api/push/subscriptions", {
    method: "POST", body: sample(), origin: "https://attacker.example",
  }));
  assert.equal(csrf.status, 403);

  const created = await subscriptionsRoute.POST(request("/api/push/subscriptions", { method: "POST", body: sample() }));
  assert.equal(created.status, 201);
  const payload = await created.json();
  assert.equal(payload.subscriptions.length, 1);
  assert.equal("endpoint" in payload.subscriptions[0], false);
  assert.equal("encrypted_subscription" in payload.subscriptions[0], false);

  const foreignDelete = await subscriptionsRoute.DELETE(request("/api/push/subscriptions", {
    method: "DELETE", cookie: cookieB, body: { id: payload.id },
  }));
  assert.equal(foreignDelete.status, 404);
  assert.equal(push.listPushSubscriptions(userA).length, 1);
});

test("bandomasis push yra fiksuotas, ribojamas ir pažymi tik push paslaugos priėmimą", async () => {
  const id = push.savePushSubscription(userA, push.parsePushSubscription(sample()));
  const secondId = push.savePushSubscription(userA, push.parsePushSubscription(sample("https://fcm.googleapis.com/fcm/send/subscription-b", "Antras")));
  let sentPayload = "";
  let sentOptions = {};
  webPush.sendNotification = async (_subscription, payload, options) => {
    sentPayload = payload;
    sentOptions = options;
    return { statusCode: 201, headers: {}, body: "" };
  };
  const sent = await testRoute.POST(request("/api/push/test", { method: "POST", body: { id } }));
  assert.equal(sent.status, 200);
  assert.deepEqual(JSON.parse(sentPayload), { type: "test" });
  assert.equal(sentOptions.timeout, 10_000);
  assert.ok(db.prepare("SELECT last_push_accepted_at FROM push_subscriptions WHERE id = ?").get(id).last_push_accepted_at);

  push.deletePushSubscription(userA, id);
  const repeated = await testRoute.POST(request("/api/push/test", { method: "POST", body: { id: secondId } }));
  assert.equal(repeated.status, 429);
  const foreign = await testRoute.POST(request("/api/push/test", { method: "POST", cookie: cookieB, body: { id } }));
  assert.equal(foreign.status, 404);
});

test("nebegaliojanti prenumerata pašalinama, laikina klaida ją palieka", async () => {
  const goneId = push.savePushSubscription(userA, push.parsePushSubscription(sample("https://fcm.googleapis.com/fcm/send/gone")));
  webPush.sendNotification = async () => { const error = new Error("gone"); error.statusCode = 410; throw error; };
  const gone = await testRoute.POST(request("/api/push/test", { method: "POST", body: { id: goneId } }));
  assert.equal(gone.status, 410);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM push_subscriptions WHERE id = ?").get(goneId).count, 0);
  const replacementId = push.savePushSubscription(userA, push.parsePushSubscription(sample("https://fcm.googleapis.com/fcm/send/replacement")));
  const replacement = await testRoute.POST(request("/api/push/test", { method: "POST", body: { id: replacementId } }));
  assert.equal(replacement.status, 429, "410 ištrinta prenumerata negali panaikinti naudotojo limito");

  const transientId = push.savePushSubscription(userB, push.parsePushSubscription(sample("https://fcm.googleapis.com/fcm/send/transient")));
  webPush.sendNotification = async () => { throw new Error("temporary"); };
  const transient = await testRoute.POST(request("/api/push/test", { method: "POST", cookie: cookieB, body: { id: transientId } }));
  assert.equal(transient.status, 502);
  const row = db.prepare("SELECT failure_count FROM push_subscriptions WHERE id = ?").get(transientId);
  assert.equal(row.failure_count, 1);
});

test("neteisingi endpoint, raktai ir įrenginio pavadinimas atmetami", () => {
  assert.throws(() => push.parsePushSubscription(sample("http://fcm.googleapis.com/nope")), /HTTPS/);
  assert.throws(() => push.parsePushSubscription(sample("https://fcm.googleapis.com:444/nope")), /HTTPS/);
  assert.throws(() => push.parsePushSubscription(sample("https://127.0.0.1/internal")), /Neatpažinta/);
  assert.throws(() => push.parsePushSubscription(sample("https://attacker.example/relay")), /Neatpažinta/);
  assert.doesNotThrow(() => push.parsePushSubscription(sample("https://web.push.apple.com/device-token")));
  assert.doesNotThrow(() => push.parsePushSubscription(sample("https://db3.notify.windows.com/channel")));
  assert.doesNotThrow(() => push.parsePushSubscription(sample("https://updates.push.services.mozilla.com/wpush/v2/token")));
  assert.throws(() => push.parsePushSubscription({ ...sample(), keys: {} }), /p256dh/);
  assert.throws(() => push.parsePushSubscription({ ...sample(), deviceName: "x".repeat(81) }), /deviceName/);
});

test("vienas naudotojas negali be galo auginti prenumeratų lentelės", () => {
  for (let index = 0; index < 10; index += 1) {
    push.savePushSubscription(userA, push.parsePushSubscription(sample(
      `https://fcm.googleapis.com/fcm/send/capped-${index}`,
      `Įrenginys ${index}`,
    )));
  }
  assert.throws(
    () => push.savePushSubscription(userA, push.parsePushSubscription(sample(
      "https://fcm.googleapis.com/fcm/send/capped-overflow",
      "Per daug",
    ))),
    (error) => error.status === 409 && /iki 10/.test(error.message),
  );
  assert.doesNotThrow(() => push.savePushSubscription(userA, push.parsePushSubscription(sample(
    "https://fcm.googleapis.com/fcm/send/capped-0",
    "Pervadintas pirmas",
  ))));
});

test("atsijungimas pašalina dabartinio įrenginio, o logout-all visas prenumeratas", async () => {
  const logoutUser = insertUser("logout-push@example.test");
  const first = sample("https://fcm.googleapis.com/fcm/send/logout-one", "One");
  const second = sample("https://fcm.googleapis.com/fcm/send/logout-two", "Two");
  push.savePushSubscription(logoutUser, push.parsePushSubscription(first));
  push.savePushSubscription(logoutUser, push.parsePushSubscription(second));

  const firstSession = createSession(logoutUser);
  const firstHash = createHash("sha256").update(first.endpoint).digest("hex");
  const one = await logoutRoute.POST(request("/api/auth/logout", {
    method: "POST",
    cookie: `${SESSION_COOKIE}=${firstSession.rawToken}`,
    body: { pushEndpointHash: firstHash },
  }));
  assert.equal(one.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM push_subscriptions WHERE user_id = ?").get(logoutUser).count, 1);

  const secondSession = createSession(logoutUser);
  const all = await logoutRoute.POST(request("/api/auth/logout?all=1", {
    method: "POST",
    cookie: `${SESSION_COOKIE}=${secondSession.rawToken}`,
    body: {},
  }));
  assert.equal(all.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM push_subscriptions WHERE user_id = ?").get(logoutUser).count, 0);
});
