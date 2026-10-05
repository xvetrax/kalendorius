import { createHash } from "node:crypto";
import webPush from "web-push";
import { db } from "@/lib/db-multi";
import { decrypt, encrypt } from "@/lib/secrets";

const MAX_ENDPOINT_LENGTH = 4096;
const MAX_KEY_LENGTH = 512;
const MAX_DEVICE_NAME_LENGTH = 80;
const MAX_SUBSCRIPTIONS_PER_USER = 10;
const TEST_PUSH_COOLDOWN_SECONDS = 30;
const PUSH_REQUEST_TIMEOUT_MS = 10_000;
const EXACT_PUSH_SERVICE_HOSTS = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
]);

function isTrustedPushServiceHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return EXACT_PUSH_SERVICE_HOSTS.has(host)
    || host === "push.apple.com"
    || host.endsWith(".push.apple.com")
    || host === "notify.windows.com"
    || host.endsWith(".notify.windows.com");
}

export class PushNotificationError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status = 400, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type PushSubscriptionInput = {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
  deviceName: string;
};

type PushSubscriptionRow = {
  id: number;
  user_id: number;
  endpoint_hash: string;
  encrypted_subscription: string;
  device_name: string;
  created_at: string;
  updated_at: string;
  last_test_attempt_at: string | null;
  last_push_accepted_at: string | null;
  failure_count: number;
};

export type StoredPushSubscription = Pick<PushSubscriptionRow,
  "id" | "user_id" | "endpoint_hash" | "encrypted_subscription" | "device_name"
>;

export function pushConfiguration() {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() || "";
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() || "";
  const subject = process.env.VAPID_SUBJECT?.trim() || "";
  let keysValid = false;
  try {
    keysValid = Buffer.from(publicKey, "base64url").length === 65
      && Buffer.from(privateKey, "base64url").length === 32;
  } catch { /* Invalid environment value. */ }
  return {
    configured: Boolean(keysValid && /^(mailto:|https:\/\/)/.test(subject)),
    publicKey,
    privateKey,
    subject,
  };
}

function text(value: unknown, field: string, max: number) {
  if (typeof value !== "string") throw new PushNotificationError(`Trūksta lauko „${field}“.`);
  const result = value.trim();
  if (!result || result.length > max) throw new PushNotificationError(`Neteisingas laukas „${field}“.`);
  return result;
}

export function parsePushSubscription(value: unknown): PushSubscriptionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PushNotificationError("Neteisingi prenumeratos duomenys.");
  }
  const body = value as Record<string, unknown>;
  const endpoint = text(body.endpoint, "endpoint", MAX_ENDPOINT_LENGTH);
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new PushNotificationError("Neteisingas pranešimų paslaugos adresas."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port) {
    throw new PushNotificationError("Pranešimų paslaugos adresas turi būti saugus HTTPS adresas.");
  }
  if (!isTrustedPushServiceHost(url.hostname)) {
    throw new PushNotificationError("Neatpažinta naršyklės pranešimų paslauga.");
  }
  if (!body.keys || typeof body.keys !== "object" || Array.isArray(body.keys)) {
    throw new PushNotificationError("Trūksta prenumeratos raktų.");
  }
  const keys = body.keys as Record<string, unknown>;
  const expirationTime = body.expirationTime === null || body.expirationTime === undefined
    ? null
    : Number(body.expirationTime);
  if (expirationTime !== null && (!Number.isSafeInteger(expirationTime) || expirationTime <= 0)) {
    throw new PushNotificationError("Neteisingas prenumeratos galiojimo laikas.");
  }
  return {
    endpoint: url.toString(),
    expirationTime,
    keys: {
      p256dh: text(keys.p256dh, "p256dh", MAX_KEY_LENGTH),
      auth: text(keys.auth, "auth", MAX_KEY_LENGTH),
    },
    deviceName: text(body.deviceName, "deviceName", MAX_DEVICE_NAME_LENGTH),
  };
}

export function endpointFingerprint(endpoint: string) {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
}

export function readStoredPushSubscription(subscriptionId: number, userId: number) {
  return db.prepare(`
    SELECT id, user_id, endpoint_hash, encrypted_subscription, device_name
    FROM push_subscriptions
    WHERE id = ? AND user_id = ?
  `).get(subscriptionId, userId) as StoredPushSubscription | undefined;
}

export async function sendStoredPush(row: StoredPushSubscription, payload: { v: 1; type: "focus_end" }) {
  const config = pushConfiguration();
  if (!config.configured) {
    throw new PushNotificationError("Pranešimai serveryje dar nesukonfigūruoti.", 409, "push_not_configured");
  }
  let subscription: PushSubscriptionInput;
  try {
    subscription = parsePushSubscription(JSON.parse(decrypt(row.encrypted_subscription)));
  } catch {
    throw new PushNotificationError("Pranešimų prenumeratos duomenys sugadinti.", 409, "subscription_corrupt");
  }
  return webPush.sendNotification(
    { endpoint: subscription.endpoint, expirationTime: subscription.expirationTime, keys: subscription.keys },
    JSON.stringify(payload),
    {
      TTL: 15 * 60,
      urgency: "normal",
      timeout: PUSH_REQUEST_TIMEOUT_MS,
      topic: payload.type,
      vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
    },
  );
}

function endpointHash(endpoint: string) {
  return createHash("sha256").update(endpoint).digest("hex");
}

export function listPushSubscriptions(userId: number) {
  const rows = db.prepare(`
    SELECT id, endpoint_hash, device_name, created_at, updated_at, last_push_accepted_at, failure_count
    FROM push_subscriptions
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(userId) as Array<Pick<PushSubscriptionRow,
    "id" | "endpoint_hash" | "device_name" | "created_at" | "updated_at" | "last_push_accepted_at" | "failure_count"
  >>;
  return rows.map((row) => ({
    id: row.id,
    deviceName: row.device_name,
    endpointFingerprint: row.endpoint_hash.slice(0, 16),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastPushAcceptedAt: row.last_push_accepted_at,
    failureCount: row.failure_count,
  }));
}

export function savePushSubscription(userId: number, subscription: PushSubscriptionInput) {
  const hash = endpointHash(subscription.endpoint);
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare(
      "SELECT id, user_id FROM push_subscriptions WHERE endpoint_hash = ?",
    ).get(hash) as { id: number; user_id: number } | undefined;
    if (existing && existing.user_id !== userId) {
      throw new PushNotificationError(
        "Ši naršyklės prenumerata priklauso kitai programėlės paskyrai. Išjunk pranešimus šiame įrenginyje ir įjunk iš naujo.",
        409,
      );
    }
    if (existing) {
      db.prepare(`
        UPDATE push_subscriptions
        SET encrypted_subscription = ?, device_name = ?,
            updated_at = CURRENT_TIMESTAMP, failure_count = 0
        WHERE id = ? AND user_id = ?
      `).run(
        encrypt(JSON.stringify(subscription)),
        subscription.deviceName,
        existing.id,
        userId,
      );
      db.exec("COMMIT");
      return existing.id;
    }
    const count = Number((db.prepare(
      "SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?",
    ).get(userId) as { count: number }).count);
    if (count >= MAX_SUBSCRIPTIONS_PER_USER) {
      throw new PushNotificationError(`Vienas naudotojas gali turėti iki ${MAX_SUBSCRIPTIONS_PER_USER} pranešimų įrenginių.`, 409);
    }
    const result = db.prepare(`
      INSERT INTO push_subscriptions
        (user_id, endpoint_hash, encrypted_subscription, device_name)
      VALUES (?, ?, ?, ?)
    `).run(
      userId,
      hash,
      encrypt(JSON.stringify(subscription)),
      subscription.deviceName,
    );
    db.exec("COMMIT");
    return Number(result.lastInsertRowid);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function deletePushSubscription(userId: number, subscriptionId: number) {
  return db.prepare("DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?")
    .run(subscriptionId, userId).changes > 0;
}

export async function sendTestPush(userId: number, subscriptionId: number) {
  const config = pushConfiguration();
  if (!config.configured) {
    throw new PushNotificationError("Pranešimai serveryje dar nesukonfigūruoti.", 409);
  }
  let row: PushSubscriptionRow;
  db.exec("BEGIN IMMEDIATE");
  try {
    const selected = db.prepare(`
      SELECT id, user_id, endpoint_hash, encrypted_subscription, device_name,
             created_at, updated_at, last_test_attempt_at, last_push_accepted_at, failure_count
      FROM push_subscriptions
      WHERE id = ? AND user_id = ?
    `).get(subscriptionId, userId) as PushSubscriptionRow | undefined;
    if (!selected) throw new PushNotificationError("Pranešimų įrenginys nerastas.", 404);
    const recent = db.prepare(`
      SELECT 1 FROM push_rate_limits
      WHERE user_id = ?
        AND last_test_attempt_at > datetime('now', '-' || ? || ' seconds')
    `).get(userId, TEST_PUSH_COOLDOWN_SECONDS);
    if (recent) {
      throw new PushNotificationError(
        `Palauk ${TEST_PUSH_COOLDOWN_SECONDS} sekundžių prieš siųsdamas kitą bandomąjį pranešimą.`,
        429,
      );
    }
    db.prepare(`
      INSERT INTO push_rate_limits (user_id, last_test_attempt_at)
      VALUES (?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET last_test_attempt_at = excluded.last_test_attempt_at
    `).run(userId);
    db.prepare(`
      UPDATE push_subscriptions
      SET last_test_attempt_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(subscriptionId, userId);
    db.exec("COMMIT");
    row = selected;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  let subscription: PushSubscriptionInput;
  try {
    subscription = parsePushSubscription(JSON.parse(decrypt(row.encrypted_subscription)));
  } catch {
    throw new PushNotificationError("Pranešimų prenumeratos duomenys sugadinti. Pašalink įrenginį ir įjunk iš naujo.", 409);
  }

  try {
    await webPush.sendNotification(
      { endpoint: subscription.endpoint, expirationTime: subscription.expirationTime, keys: subscription.keys },
      JSON.stringify({ type: "test" }),
      {
        TTL: 60,
        urgency: "normal",
        timeout: PUSH_REQUEST_TIMEOUT_MS,
        vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
      },
    );
    db.prepare(`
      UPDATE push_subscriptions
      SET last_push_accepted_at = CURRENT_TIMESTAMP, failure_count = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(subscriptionId, userId);
  } catch (error) {
    const statusCode = Number((error as { statusCode?: unknown })?.statusCode || 0);
    if (statusCode === 404 || statusCode === 410) {
      deletePushSubscription(userId, subscriptionId);
      throw new PushNotificationError("Ši prenumerata nebegalioja ir buvo pašalinta. Įjunk pranešimus iš naujo.", 410);
    }
    db.prepare(`
      UPDATE push_subscriptions
      SET failure_count = failure_count + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(subscriptionId, userId);
    throw new PushNotificationError("Bandomojo pranešimo pristatyti nepavyko.", 502);
  }
}
