import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { processNotificationTick } from "../lib/notification-worker.ts";

const workerId = randomUUID();
const databasePath = path.resolve(process.env.DATABASE_PATH || "./data/planner.db");
const healthPath = process.env.NOTIFICATION_WORKER_HEALTH_PATH || path.join(path.dirname(databasePath), "notification-worker-health.json");
const intervalMs = Math.max(500, Number(process.env.NOTIFICATION_WORKER_POLL_MS || 2000));
let stopping = false;

function heartbeat(ok: boolean, error?: unknown) {
  const temporary = `${healthPath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(healthPath), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify({
    ok,
    workerId,
    at: new Date().toISOString(),
    ...(error ? { error: error instanceof Error ? error.name : "unknown" } : {}),
  }), { mode: 0o600 });
  fs.renameSync(temporary, healthPath);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => { stopping = true; });
}

while (!stopping) {
  try {
    const result = await processNotificationTick({ workerId });
    if (result.processed) console.log(JSON.stringify({ component: "notification-worker", workerId, event: "delivery_finished", deliveryId: result.deliveryId, state: result.state }));
    heartbeat(true);
  } catch (error) {
    heartbeat(false, error);
    console.error(JSON.stringify({ component: "notification-worker", workerId, event: "tick_failed", error: error instanceof Error ? error.name : "unknown" }));
  }
  if (!stopping) await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

heartbeat(true);
