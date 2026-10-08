import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const projectRoot = path.resolve(import.meta.dirname, "..");
const suffix = `${process.pid}-${Date.now()}`;
const image = `kalendorius:ma8-smoke-${suffix}`;
const container = `kalendorius-ma8-smoke-${suffix}`;
const workerContainer = `kalendorius-worker-smoke-${suffix}`;
let containerRunning = false;
let workerRunning = false;

function docker(...args) {
  return execFileSync("docker", args, { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Nepavyko parinkti Docker smoke prievado.");
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const runDirectory = mkdtempSync(path.join(projectRoot, ".docker-smoke-"));
const databasePath = path.join(runDirectory, "planner.db");
const encryptionKey = "d7".repeat(32);
process.env.APP_ORIGIN = origin;
process.env.DATABASE_PATH = databasePath;
process.env.MULTI_USER_DATABASE_PATH = databasePath;
process.env.TOKEN_ENCRYPTION_KEY = encryptionKey;

function runContainer() {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  docker("run", "-d", "--name", container, "--init", "--user", `${uid}:${gid}`,
    "-p", `127.0.0.1:${port}:3000`, "--mount", `type=bind,src=${runDirectory},dst=/app/data`,
    "-e", "NODE_ENV=production", "-e", "TZ=Europe/Vilnius", "-e", `APP_ORIGIN=${origin}`,
    "-e", "PUBLIC_SIGNUP=true", "-e", "INITIAL_ADMIN_EMAIL=docker@example.test",
    "-e", `TOKEN_ENCRYPTION_KEY=${encryptionKey}`,
    "-e", "GOOGLE_CLIENT_ID=smoke", "-e", "GOOGLE_CLIENT_SECRET=smoke",
    "-e", `GOOGLE_REDIRECT_URI=${origin}/api/google/callback`,
    "-e", "MICROSOFT_CLIENT_ID=smoke", "-e", "MICROSOFT_CLIENT_SECRET=smoke",
    "-e", "MICROSOFT_TENANT=common", "-e", `MICROSOFT_REDIRECT_URI=${origin}/api/microsoft/callback`,
    "-e", "DATABASE_PATH=/app/data/planner.db", image);
  containerRunning = true;
}

function runWorker() {
  try { unlinkSync(path.join(runDirectory, "notification-worker-health.json")); } catch {}
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  docker("run", "-d", "--name", workerContainer, "--init", "--user", `${uid}:${gid}`,
    "--mount", `type=bind,src=${runDirectory},dst=/app/data`,
    "-e", "NODE_ENV=production", "-e", "TZ=Europe/Vilnius",
    "-e", `TOKEN_ENCRYPTION_KEY=${encryptionKey}`,
    "-e", "DATABASE_PATH=/app/data/planner.db", image, "node", "notification-worker.mjs");
  workerRunning = true;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Docker health check nepraėjo.\n${docker("logs", container)}`);
}

async function waitForWorkerHealth() {
  const health = path.join(runDirectory, "notification-worker-health.json");
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const value = JSON.parse(readFileSync(health, "utf8"));
      if (value.ok && Date.now() - Date.parse(value.at) < 10_000) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Pranešimų workerio health check nepraėjo.\n${docker("logs", workerContainer)}`);
}

function removeContainer() {
  if (workerRunning) {
    try { docker("rm", "-f", workerContainer); } finally { workerRunning = false; }
  }
  if (containerRunning) {
    try { docker("rm", "-f", container); } finally { containerRunning = false; }
  }
}

try {
  docker("build", "--build-arg", "APP_VERSION=ma8-smoke", "-t", image, ".");

  const { db, createSession, SESSION_COOKIE } = await import(`${pathToFileURL(path.join(projectRoot, "lib", "db-multi.ts")).href}?docker-smoke=${suffix}`);
  const userResult = db.prepare("INSERT INTO users (display_name, primary_email, role, status) VALUES (?, ?, 'admin', 'active')").run("Docker Admin", "docker@example.test");
  const userId = Number(userResult.lastInsertRowid);
  db.prepare("INSERT INTO tasks (user_id, title) VALUES (?, ?)").run(userId, "Prieš kopiją");
  const insertConnection = db.prepare(`INSERT INTO oauth_connections
    (user_id, provider, provider_account_id, provider_email, encrypted_refresh_token, scopes, display_label, color_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [provider, account] of [["google", "g-one"], ["google", "g-two"], ["microsoft", "m-one"], ["microsoft", "m-two"]]) {
    const result = insertConnection.run(userId, provider, account, `${account}@example.test`, "encrypted-smoke-token", "calendar tasks", account, account);
    db.prepare("INSERT INTO calendar_preference_sets (user_id, connection_id, explicit) VALUES (?, ?, 1)").run(userId, Number(result.lastInsertRowid));
  }
  const { rawToken } = createSession(userId);
  db.close();
  chmodSync(runDirectory, 0o777);
  chmodSync(databasePath, 0o666);

  runContainer();
  await waitForHealth();
  runWorker();
  await waitForWorkerHealth();
  for (const [asset, expectedType] of [
    ["/manifest.webmanifest", "application/manifest+json"],
    ["/sw.js", "application/javascript"],
    ["/offline.html", "text/html"],
    ["/pwa/offline.css", "text/css"],
    ["/pwa/icon-192.png", "image/png"],
    ["/pwa/icon-512.png", "image/png"],
    ["/pwa/icon-maskable-512.png", "image/png"],
    ["/pwa/apple-touch-icon.png", "image/png"],
  ]) {
    const response = await fetch(`${origin}${asset}`, { redirect: "manual" });
    assert.equal(response.status, 200, `${asset} turi būti Docker image`);
    assert.ok((response.headers.get("content-type") || "").startsWith(expectedType), `${asset} MIME tipas Docker image`);
  }
  const workerResponse = await fetch(`${origin}/sw.js`);
  assert.equal(workerResponse.headers.get("cache-control"), "no-cache, no-store, must-revalidate", "Service worker negali įstrigti HTTP podėlyje");
  assert.ok((workerResponse.headers.get("content-security-policy") || "").includes("connect-src 'self'"), "Service worker turi ribotą CSP");
  const headers = { Origin: origin, Cookie: `${SESSION_COOKIE}=${rawToken}` };
  const backupResponse = await fetch(`${origin}/api/backup`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ type: "full" }),
  });
  assert.equal(backupResponse.status, 200);
  const backup = Buffer.from(await backupResponse.arrayBuffer());
  assert.equal(backup.subarray(0, 16).toString("utf8"), "SQLite format 3\0");

  const created = await fetch(`${origin}/api/tasks`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Po kopijos" }),
  });
  assert.equal(created.status, 201);
  const restoreResponse = await fetch(`${origin}/api/backup`, {
    method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: backup,
  });
  assert.equal(restoreResponse.status, 200);

  removeContainer();
  const restored = new DatabaseSync(databasePath, { readOnly: true });
  assert.deepEqual(restored.prepare("SELECT title FROM tasks ORDER BY id").all().map(row => row.title), ["Prieš kopiją"]);
  assert.equal(restored.prepare("SELECT COUNT(*) AS count FROM oauth_connections").get().count, 4);
  assert.equal(restored.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
  restored.close();

  runContainer();
  await waitForHealth();
  runWorker();
  await waitForWorkerHealth();
  console.log("OK: Docker build, web ir worker health, keturios OAuth jungtys, pilnos kopijos atkūrimas ir pakartotinis paleidimas.");
} finally {
  removeContainer();
  try { docker("image", "rm", "-f", image); } catch {}
  rmSync(runDirectory, { recursive: true, force: true });
}
