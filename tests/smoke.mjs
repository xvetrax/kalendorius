import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const temp = mkdtempSync(path.join(tmpdir(), "dienos-planas-smoke-"));
const reservation = createServer();
await new Promise((resolve, reject) => reservation.once("error", reject).listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const databasePath = path.join(temp, "planner.db");
const env = { ...process.env, NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", APP_ORIGIN: origin, DATABASE_PATH: path.relative(process.cwd(), databasePath) };
// No live provider calls or credentials are needed for this regression check.
for (const provider of ["GOOGLE", "MICROSOFT"]) {
  for (const suffix of ["CLIENT_ID", "CLIENT_SECRET", "REDIRECT_URI"]) env[`${provider}_${suffix}`] = "";
}
const child = spawn(process.execPath, ["scripts/start.mjs"], { env, stdio: "ignore" });
const stopped = new Promise((resolve) => child.once("exit", resolve));

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("Produkcijos serveris nepasileido.");
    try { ready = (await fetch(origin, { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready) break;
    await delay(200);
  }
  assert.ok(ready, "Serveris turi pasileisti");
  const html = await (await fetch(origin)).text();
  assert.match(html, /aria-label="Kraunamas kalendorius"/, "SSR neturi įrašyti build dienos datos į kalendorių");
  assert.ok(!html.includes('class="calendarToolbar"'), "Datos rodinys atsiranda tik žinant naršyklės laiką");
  assert.ok(html.includes("planner-theme"), "Tema parenkama prieš pirmą puslapio piešimą");
  const assets = [...new Set([...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((match) => match[1]).filter((url) => url.startsWith("/_next/static/") || url.startsWith("/favicon")))];
  assert.ok(assets.some((url) => url.endsWith(".css")), "Puslapis turi CSS");
  assert.ok(assets.some((url) => url.endsWith(".js")), "Puslapis turi JavaScript");
  for (const asset of assets) {
    const response = await fetch(new URL(asset, origin));
    assert.equal(response.status, 200, asset);
    const type = response.headers.get("content-type") || "";
    assert.ok(!type.includes("text/html"), `Vietoje resurso grąžintas HTML: ${asset}`);
  }
  for (const provider of ["google", "microsoft"]) {
    const status = await (await fetch(`${origin}/api/${provider}/status`)).json();
    assert.equal(status.connected, false);
    assert.equal(status.configured, false);
    const badCallback = await fetch(`${origin}/api/${provider}/callback?error_description=DO_NOT_EXPOSE`, { redirect: "manual" });
    assert.equal(badCallback.status, 302);
    assert.ok(badCallback.headers.get("location").endsWith(`/?integration=${provider}&oauth=error`));
    assert.ok(!(await badCallback.text()).includes("DO_NOT_EXPOSE"));
    const blocked = await fetch(`${origin}/api/${provider}/status`, { method: "DELETE", headers: { Origin: "https://example.org" } });
    assert.equal(blocked.status, 403);
    const disconnected = await fetch(`${origin}/api/${provider}/status`, { method: "DELETE", headers: { Origin: origin } });
    assert.equal(disconnected.status, 200);
    const events = await (await fetch(`${origin}/api/${provider}/events`)).json();
    assert.deepEqual(events.items, []);
  }
  const headers = { Origin: origin, "Content-Type": "application/json" };
  assert.equal((await fetch(`${origin}/api/tasks`, { method: "POST", body: "{}" })).status, 403);
  const deadline = "2026-10-30T12:00:00.000Z";
  const created = await fetch(`${origin}/api/tasks`, { method: "POST", headers, body: JSON.stringify({ title: "Izoliuoto testo užduotis", due_at: deadline }) });
  assert.equal(created.status, 201);
  let task = await created.json(); const {id} = task;
  assert.equal(task.scheduled_at, null);
  const patch = async (changes, version = task.schedule_version) => fetch(`${origin}/api/tasks`, {method:"PATCH", headers, body:JSON.stringify({id,source:"local",schedule_version:version,...changes})});
  let response = await patch({scheduled_at:"2026-10-25T10:00:00+02:00",duration_minutes:60});
  assert.equal(response.status,200); task=await response.json();
  assert.equal(task.scheduled_at,"2026-10-25T08:00:00.000Z"); assert.equal(task.due_at,deadline);
  assert.equal((await patch({scheduled_at:"2026-10-26T10:00:00Z"},0)).status,409);
  response=await patch({scheduled_at:"2026-10-26T10:00:00Z",duration_minutes:90});
  assert.equal(response.status,200); task=await response.json();
  const envelope=await (await fetch(`${origin}/api/tasks?envelope=1`)).json();
  assert.equal(envelope.items[0].duration_minutes,90); assert.equal(envelope.items[0].due_at,deadline);
  response=await patch({scheduled_at:null}); task=await response.json();
  assert.equal(task.scheduled_at,null); assert.equal(task.due_at,deadline);
  assert.equal((await patch({duration_minutes:0})).status,400);
  const updated = await fetch(`${origin}/api/tasks`, { method: "PATCH", headers, body: JSON.stringify({ id, completed: true }) });
  assert.equal(updated.status, 200);
  const tasks = await (await fetch(`${origin}/api/tasks`)).json();
  assert.equal(tasks.find((task) => task.id === id).completed, 1);
  assert.ok(existsSync(databasePath), "Santykinis DB kelias turi būti sprendžiamas projekto, o ne build katalogo atžvilgiu");
  console.log(`OK: produkcinis paleidimas, ${assets.length} resursų, OAuth klaidos, atjungimas, CSRF, užduotis, planavimas, trukmė, terminas, konfliktas, išplanavimas ir užbaigimas.`);
} finally {
  child.kill("SIGTERM");
  await stopped;
  // Only the unique test directory created above is removed.
  rmSync(temp, { recursive: true, force: true });
}
