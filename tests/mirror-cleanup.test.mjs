import assert from "node:assert/strict";
import { test, after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const rel = specifier.slice(2);
    const withTs = rel.endsWith(".ts") ? rel : rel + ".ts";
    return next(pathToFileURL(path.resolve(import.meta.dirname, "..", withTs)).href, context);
  }
  return next(specifier, context);
}});

const { ProviderError } = await import("../lib/provider-error.ts");
const { createTaskService, migrateTaskPlanning } = await import("../lib/task-service.ts");

function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '', due_at TEXT, duration_minutes INTEGER NOT NULL DEFAULT 30,
    completed INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    project TEXT NOT NULL DEFAULT 'Asmeniniai', priority TEXT NOT NULL DEFAULT 'normal',
    tags TEXT NOT NULL DEFAULT '', energy TEXT NOT NULL DEFAULT 'medium');`);
}

function makeGateway(overrides = {}) {
  const events = new Map();
  const transactions = new Map();
  const state = { connected: true, account: "account-a", ...overrides.state };
  return {
    events,
    state,
    connected: () => state.connected,
    cachedAccountId: () => state.account,
    accountId: async () => state.account,
    defaultListId: async () => "list-a",
    async request(url, init = {}) {
      const method = init.method || "GET";
      const body = init.body ? JSON.parse(init.body) : null;
      if (overrides.request) return overrides.request(url, method, body, events, transactions, state);
      // Default Graph mock
      if (url.startsWith("/me/todo/lists?") || url.startsWith("/me/todo/lists?") || url === "/me/todo/lists") {
        return { value: [{ id: "list-a", displayName: "Darbai", wellknownListName: "defaultList" }] };
      }
      if (url.startsWith("/me/todo/lists/list-a/tasks") && method === "GET") return { value: [] };
      if (url === "/me/events" && method === "POST") {
        const id = transactions.get(body.transactionId) || `event-${transactions.size + 1}`;
        transactions.set(body.transactionId, id); events.set(id, body); return { id };
      }
      if (url.startsWith("/me/events/") && method === "PATCH") {
        const id = decodeURIComponent(url.split("/").at(-1));
        events.set(id, { ...events.get(id), ...body }); return { id };
      }
      if (url.startsWith("/me/events/") && method === "DELETE") {
        const id = decodeURIComponent(url.split("/").at(-1));
        events.delete(id); return null;
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    },
  };
}

function fixture(overrides = {}) {
  const db = new DatabaseSync(":memory:");
  schema(db);
  migrateTaskPlanning(db);
  const graph = makeGateway(overrides);
  const service = createTaskService(db, graph);
  return { db, graph, service };
}

const start = "2026-10-25T08:00:00.000Z";
const ref = (task) => ({ id: task.id, source: task.source, account_id: task.account_id, list_id: task.list_id, schedule_version: task.schedule_version });

// Helper: seed a microsoft task in remote_tasks + task_plans with mirror data
function seedMicrosoftTask(db, { key, listId = "list-a", mirrorEventId = "event-1", mirrorRequested = 1, mirrorTransactionId = null, scheduledAt = start, mirrorAccountId = "account-a" }) {
  db.prepare("INSERT INTO remote_tasks(task_key, account_id, list_id, source, task_json) VALUES (?, ?, ?, ?, ?)").run(
    key, "account-a", listId, "microsoft",
    JSON.stringify({ id: key, key, source: "microsoft", account_id: "account-a", list_id: listId,
      title: "Test", notes: "", due_at: null, duration_minutes: 30, completed: 0,
      project: "Microsoft To Do", priority: "normal", energy: "medium", tags: "",
      scheduled_at: null, schedule_version: 0, legacy_schedule: 0,
      mirror_requested: mirrorRequested, mirror_event_id: mirrorEventId, mirror_error: null })
  );
  db.prepare("INSERT OR IGNORE INTO task_plans(task_key, duration_minutes, scheduled_at, mirror_requested, mirror_event_id, mirror_transaction_id, mirror_account_id) VALUES (?, 30, ?, ?, ?, ?, ?)").run(
    key, scheduledAt, mirrorRequested, mirrorEventId, mirrorTransactionId, mirrorAccountId
  );
}

// B1.1 test 1: DELETE returns 404 → treated as success, mirror cleared
test("syncMirror: DELETE returning 404 is treated as success and mirror fields are cleared", async () => {
  const key = JSON.stringify(["microsoft", "account-a", "list-a", "task-1"]);
  const deleteCalls = [];

  const { db, service } = fixture({
    request: (url, method, body, events, transactions, state) => {
      if (url.startsWith("/me/todo/lists") && method === "GET") return { value: [{ id: "list-a", displayName: "Darbai", wellknownListName: "defaultList" }] };
      if (url.startsWith("/me/todo/lists/list-a/tasks") && method === "GET") return { value: [] };
      if (url.startsWith("/me/todo/lists/list-a/tasks/") && method === "PATCH") {
        const id = decodeURIComponent(url.split("/").at(-1));
        return { id, status: "notStarted", title: body?.title ?? "Test" };
      }
      if (url.startsWith("/me/events/") && method === "DELETE") {
        deleteCalls.push(url);
        throw new ProviderError("Microsoft", 404);
      }
      throw new Error(`Unexpected: ${method} ${url}`);
    },
  });

  // Insert plan with mirror_event_id and mirror_requested=0 (unschedule path)
  db.prepare("INSERT OR IGNORE INTO task_plans(task_key, duration_minutes, scheduled_at, mirror_requested, mirror_event_id) VALUES (?, 30, NULL, 0, 'event-404')").run(key);

  const task = {
    id: "task-1", key, source: "microsoft", account_id: "account-a", list_id: "list-a",
    title: "Test", notes: "", due_at: null, duration_minutes: 30, completed: 0,
    project: "Microsoft To Do", priority: "normal", energy: "medium", tags: "",
    scheduled_at: null, schedule_version: 0, legacy_schedule: 0,
    mirror_requested: 0, mirror_event_id: "event-404", mirror_error: null,
  };

  // syncMirror is called indirectly via update. Trigger it directly via a
  // local helper: we update the task with scheduled_at=null, mirror_requested=false
  // which triggers the delete path. But syncMirror isn't exported.
  // Instead let's update via service.update after setting up the plan properly.
  // We need a remote_tasks row for the task.
  db.prepare("INSERT INTO remote_tasks(task_key, account_id, list_id, source, task_json) VALUES (?, ?, ?, ?, ?)").run(
    key, "account-a", "list-a", "microsoft",
    JSON.stringify({ id: "task-1", key, source: "microsoft", account_id: "account-a", list_id: "list-a",
      title: "Test", notes: "", due_at: null, duration_minutes: 30, completed: 0,
      project: "Microsoft To Do", priority: "normal", energy: "medium", tags: "",
      scheduled_at: null, schedule_version: 0, legacy_schedule: 0,
      mirror_requested: 0, mirror_event_id: "event-404", mirror_error: null })
  );
  // Update task_plans to have mirror_event_id set
  db.prepare("UPDATE task_plans SET mirror_event_id='event-404', mirror_requested=0 WHERE task_key=?").run(key);

  // Trigger an update that will call syncMirror via the update path
  const updated = await service.update({
    id: "task-1", source: "microsoft", account_id: "account-a", list_id: "list-a",
    schedule_version: 0, title: "Test",
  });

  assert.ok(deleteCalls.length > 0, "DELETE was called");
  const plan = db.prepare("SELECT * FROM task_plans WHERE task_key=?").get(key);
  assert.equal(plan.mirror_event_id, null, "mirror_event_id cleared");
  assert.equal(plan.mirror_error, null, "mirror_error null after 404");
});

// B1.1 test 2: DELETE returns 200 → same result (mirror cleared)
test("syncMirror: DELETE returning 200 also clears mirror fields", async () => {
  const key = JSON.stringify(["microsoft", "account-a", "list-a", "task-2"]);
  const deleteCalls = [];

  const { db, service } = fixture({
    request: (url, method, body, events, transactions, state) => {
      if (url.startsWith("/me/todo/lists") && method === "GET") return { value: [{ id: "list-a", displayName: "Darbai", wellknownListName: "defaultList" }] };
      if (url.startsWith("/me/todo/lists/list-a/tasks") && method === "GET") return { value: [] };
      if (url.startsWith("/me/todo/lists/list-a/tasks") && method === "PATCH") {
        const id = decodeURIComponent(url.split("/").at(-1));
        return { id, status: "notStarted", title: body?.title ?? "Test" };
      }
      if (url.startsWith("/me/events/") && method === "DELETE") {
        deleteCalls.push(url); return null; // 200/204 success
      }
      throw new Error(`Unexpected: ${method} ${url}`);
    },
  });

  db.prepare("INSERT INTO remote_tasks(task_key, account_id, list_id, source, task_json) VALUES (?, ?, ?, ?, ?)").run(
    key, "account-a", "list-a", "microsoft",
    JSON.stringify({ id: "task-2", key, source: "microsoft", account_id: "account-a", list_id: "list-a",
      title: "Test", notes: "", due_at: null, duration_minutes: 30, completed: 0,
      project: "Microsoft To Do", priority: "normal", energy: "medium", tags: "",
      scheduled_at: null, schedule_version: 0, legacy_schedule: 0,
      mirror_requested: 0, mirror_event_id: "event-200", mirror_error: null })
  );
  db.prepare("INSERT OR REPLACE INTO task_plans(task_key, duration_minutes, scheduled_at, mirror_requested, mirror_event_id) VALUES (?, 30, NULL, 0, 'event-200')").run(key);

  await service.update({
    id: "task-2", source: "microsoft", account_id: "account-a", list_id: "list-a",
    schedule_version: 0, title: "Test",
  });

  assert.ok(deleteCalls.length > 0, "DELETE was called");
  const plan = db.prepare("SELECT * FROM task_plans WHERE task_key=?").get(key);
  assert.equal(plan.mirror_event_id, null, "mirror_event_id cleared");
  assert.equal(plan.mirror_error, null, "mirror_error null after 200 DELETE");
});

// B1.2 test 3: task with mirror_event_id is in old cache but missing from fresh provider list
test("listProvider: externally deleted task with mirror_event_id gets orphan mirror_error set", async () => {
  const taskId = "deleted-task";
  const key = JSON.stringify(["microsoft", "account-a", "list-a", taskId]);

  const { db, graph } = fixture({
    request: (url, method, body, events) => {
      // Lists endpoint
      if (url.startsWith("/me/todo/lists?") || url === "/me/todo/lists") {
        return { value: [{ id: "list-a", displayName: "Darbai", wellknownListName: "defaultList" }] };
      }
      // Tasks: return empty list (task was deleted externally)
      if (url.startsWith("/me/todo/lists/list-a/tasks") && method === "GET") return { value: [] };
      if (url.startsWith("/me/events/") && method === "DELETE") {events.delete(decodeURIComponent(url.split("/").at(-1)));return null;}
      throw new Error(`Unexpected: ${method} ${url}`);
    },
  });

  const service = createTaskService(db, graph);

  // Seed old task in remote_tasks and task_plans with mirror_event_id
  seedMicrosoftTask(db, { key, listId: "list-a", mirrorEventId: "orphan-event-1", mirrorRequested: 0, scheduledAt: null });

  // Run listProvider (via service.list)
  graph.events.set("orphan-event-1",{subject:"✓ Test"});
  const result=await service.list();

  // Check that the orphaned task_plans row got mirror_error set
  const plan = db.prepare("SELECT * FROM task_plans WHERE task_key=?").get(key);
  assert.ok(plan, "task_plans row still exists");
  assert.ok(plan.mirror_error, "mirror_error is set");
  assert.ok(plan.mirror_error.includes("pašalinta šaltinyje"), `mirror_error contains expected message, got: ${plan.mirror_error}`);
  assert.ok(plan.mirror_orphaned_at,"orphan cleanup version is persisted");
  assert.equal(result.cleanups.length,1);assert.equal(result.cleanups[0].title,"Test");assert.equal(result.cleanups[0].can_retry,true);
  // remote_tasks row should be gone
  const rt = db.prepare("SELECT * FROM remote_tasks WHERE task_key=?").get(key);
  assert.equal(rt, undefined, "remote_tasks row was deleted");
  assert.deepEqual(await service.cleanupMirror({task_key:key,orphaned_at:plan.mirror_orphaned_at,mirror_event_id:"orphan-event-1"}),{ok:true});
  assert.equal(graph.events.has("orphan-event-1"),false);assert.equal(db.prepare("SELECT 1 FROM task_plans WHERE task_key=?").get(key),undefined);
  // A repeated client request after a lost response is harmless.
  assert.deepEqual(await service.cleanupMirror({task_key:key,orphaned_at:plan.mirror_orphaned_at,mirror_event_id:"orphan-event-1"}),{ok:true});
});

test("orphan cleanup treats an already missing Outlook event as success",async()=>{
  const key=JSON.stringify(["microsoft","account-a","list-a","already-gone"]),deletes=[];
  const {db,graph,service}=fixture({request:(url,method)=>{
    if(url.startsWith("/me/todo/lists")&&method==="GET"&&!url.includes("/tasks"))return {value:[{id:"list-a",displayName:"Darbai",wellknownListName:"defaultList"}]};
    if(url.startsWith("/me/todo/lists/list-a/tasks")&&method==="GET")return {value:[]};
    if(url.startsWith("/me/events/")&&method==="DELETE"){deletes.push(url);throw new ProviderError("Microsoft",404);}
    throw new Error(`Unexpected: ${method} ${url}`);
  }});
  seedMicrosoftTask(db,{key,mirrorEventId:"gone-event",mirrorRequested:0,scheduledAt:null});
  const listed=await service.list(),cleanup=listed.cleanups[0];assert.ok(cleanup);
  assert.deepEqual(await service.cleanupMirror({task_key:key,orphaned_at:cleanup.orphaned_at,mirror_event_id:"gone-event"}),{ok:true});
  assert.equal(deletes.length,1);assert.equal(db.prepare("SELECT 1 FROM task_plans WHERE task_key=?").get(key),undefined);
});

test("removing a whole provider list queues its cached Outlook mirrors",async()=>{
  const key=JSON.stringify(["microsoft","account-a","removed-list","removed-with-list"]);
  const {db,graph,service}=fixture({request:(url,method,body,events)=>{
    if((url.startsWith("/me/todo/lists?")||url==="/me/todo/lists")&&method==="GET")return {value:[]};
    if(url==="/me/events/list-orphan"&&method==="DELETE"){events.delete("list-orphan");return null;}
    throw new Error(`Unexpected: ${method} ${url}`);
  }});
  seedMicrosoftTask(db,{key,listId:"removed-list",mirrorEventId:"list-orphan",mirrorRequested:0,scheduledAt:null});
  graph.events.set("list-orphan",{subject:"✓ Test"});
  const listed=await service.list(),cleanup=listed.cleanups.find(item=>item.task_key===key);
  assert.equal(cleanup?.title,"Test");assert.equal(db.prepare("SELECT 1 FROM remote_tasks WHERE task_key=?").get(key),undefined);
  assert.deepEqual(await service.cleanupMirror({task_key:key,orphaned_at:cleanup.orphaned_at,mirror_event_id:"list-orphan"}),{ok:true});
  assert.equal(graph.events.size,0);
});

test("orphan cleanup keeps the queue when the connected Outlook account differs",async()=>{
  const key=JSON.stringify(["google","google-account","list-a","foreign-mirror"]);
  const {db,graph,service}=fixture();
  db.prepare(`INSERT INTO task_plans(task_key,mirror_event_id,mirror_account_id,mirror_orphaned_at,mirror_orphan_title,mirror_error)
    VALUES (?,'event-x','another-microsoft-account','2026-09-23 10:00:00','Svetimas',?)`).run(key,"Užduotis pašalinta šaltinyje. Pašalink likusį Outlook bloką nustatymuose.");
  await assert.rejects(service.cleanupMirror({task_key:key,orphaned_at:"2026-09-23 10:00:00",mirror_event_id:"event-x"}),/Prijunk tą Microsoft paskyrą/);
  assert.ok(db.prepare("SELECT mirror_orphaned_at FROM task_plans WHERE task_key=?").get(key));assert.equal(graph.events.size,0);
});

test("orphan cleanup recovers an uncertain create and stays retryable after a failed delete",async()=>{
  const key=JSON.stringify(["google","google-account","list-a","uncertain-create"]),orphanedAt="2026-09-23 10:00:00";
  let posts=0,deletes=0;
  const {db,graph,service}=fixture({request:(url,method,body,events,transactions)=>{
    if(url==="/me/events"&&method==="POST"){
      posts++;const id=transactions.get(body.transactionId)||"recovered-event";transactions.set(body.transactionId,id);events.set(id,body);return {id};
    }
    if(url==="/me/events/recovered-event"&&method==="DELETE"){
      deletes++;if(deletes===1)throw new ProviderError("Microsoft",503);events.delete("recovered-event");return null;
    }
    throw new Error(`Unexpected: ${method} ${url}`);
  }});
  const payload=JSON.stringify({subject:"✓ Neaiški",transactionId:"cleanup-transaction"});
  db.prepare(`INSERT INTO task_plans(task_key,mirror_account_id,mirror_transaction_id,mirror_create_payload,mirror_orphaned_at,mirror_orphan_title)
    VALUES (?,'account-a','cleanup-transaction',?,?, 'Neaiški')`).run(key,payload,orphanedAt);
  await assert.rejects(service.cleanupMirror({task_key:key,orphaned_at:orphanedAt,mirror_event_id:null}),/Microsoft/);
  const recovered=db.prepare("SELECT mirror_event_id,mirror_orphaned_at FROM task_plans WHERE task_key=?").get(key);
  assert.equal(recovered.mirror_event_id,"recovered-event");assert.equal(recovered.mirror_orphaned_at,orphanedAt);
  assert.deepEqual(await service.cleanupMirror({task_key:key,orphaned_at:orphanedAt,mirror_event_id:"recovered-event"}),{ok:true});
  assert.equal(posts,1);assert.equal(deletes,2);assert.equal(graph.events.size,0);
  assert.equal(db.prepare("SELECT 1 FROM task_plans WHERE task_key=?").get(key),undefined);
});

// B1.2 test 4: task with mirror_requested!=0 is deleted externally → also gets orphan error
test("listProvider: externally deleted task with mirror_requested set gets orphan mirror_error", async () => {
  const taskId = "deleted-task-2";
  const key = JSON.stringify(["microsoft", "account-a", "list-a", taskId]);

  const { db, graph } = fixture({
    request: (url, method) => {
      if (url.startsWith("/me/todo/lists?") || url === "/me/todo/lists") {
        return { value: [{ id: "list-a", displayName: "Darbai", wellknownListName: "defaultList" }] };
      }
      if (url.startsWith("/me/todo/lists/list-a/tasks") && method === "GET") return { value: [] };
      throw new Error(`Unexpected: ${method} ${url}`);
    },
  });

  const service = createTaskService(db, graph);

  // Seed with mirror_requested=1 but no event_id yet
  seedMicrosoftTask(db, { key, listId: "list-a", mirrorEventId: null, mirrorRequested: 1, scheduledAt: start });

  await service.list();

  const plan = db.prepare("SELECT * FROM task_plans WHERE task_key=?").get(key);
  assert.ok(plan, "task_plans row still exists");
  assert.ok(plan.mirror_error, "mirror_error is set");
  assert.ok(plan.mirror_error.includes("pašalinta šaltinyje"), `Expected orphan message, got: ${plan.mirror_error}`);
  graph.state.connected=false;
  const cleanup=(await service.list()).cleanups.find(item=>item.task_key===key);
  assert.equal(cleanup?.can_retry,true,"a local-only orphan can be cleared without an Outlook account lookup");
});

// B1.2: task that still exists in fresh list should NOT get orphan error
test("listProvider: task still present in provider is not marked as orphan", async () => {
  const taskId = "still-present";
  const key = JSON.stringify(["microsoft", "account-a", "list-a", taskId]);

  const { db, graph } = fixture({
    request: (url, method) => {
      if (url.startsWith("/me/todo/lists?") || url === "/me/todo/lists") {
        return { value: [{ id: "list-a", displayName: "Darbai", wellknownListName: "defaultList" }] };
      }
      if (url.startsWith("/me/todo/lists/list-a/tasks") && method === "GET") {
        return { value: [{ id: taskId, title: "Dar čia", status: "notStarted", importance: "normal" }] };
      }
      throw new Error(`Unexpected: ${method} ${url}`);
    },
  });

  const service = createTaskService(db, graph);
  seedMicrosoftTask(db, { key, listId: "list-a", mirrorEventId: "keep-event", mirrorRequested: 1, scheduledAt: start });
  db.prepare("UPDATE task_plans SET mirror_orphaned_at='2026-09-23 10:00:00',mirror_orphan_title='Senas',mirror_error=? WHERE task_key=?")
    .run("Užduotis pašalinta šaltinyje. Pašalink likusį Outlook bloką nustatymuose.",key);

  await service.list();

  const plan = db.prepare("SELECT * FROM task_plans WHERE task_key=?").get(key);
  assert.ok(plan, "task_plans row still exists");
  // mirror_error should NOT be set by orphan logic (task is still in the provider)
  assert.equal(plan.mirror_error, null, "mirror_error not set for present task");
  assert.equal(plan.mirror_orphaned_at,null,"reappearing task leaves the cleanup queue");
});

// B1.1 + B1.2: 404 on DELETE during syncMirror after a source-completed + re-opened scenario
test("syncMirror: after source completion, 404 on subsequent DELETE is treated as success", async () => {
  const key = JSON.stringify(["microsoft", "account-a", "list-a", "task-reopen"]);
  const deleteCalls = [];

  const { db, service } = fixture({
    request: (url, method, body) => {
      if (url.startsWith("/me/todo/lists") && method === "GET") return { value: [{ id: "list-a", displayName: "Darbai", wellknownListName: "defaultList" }] };
      if (url.startsWith("/me/todo/lists/list-a/tasks") && method === "GET") return { value: [] };
      if (url.startsWith("/me/todo/lists/list-a/tasks") && method === "PATCH") {
        const id = decodeURIComponent(url.split("/").at(-1));
        return { id, status: body?.status ?? "notStarted", title: "Atnaujinta" };
      }
      if (url.startsWith("/me/events/") && method === "DELETE") {
        deleteCalls.push(url);
        throw new ProviderError("Microsoft", 404);
      }
      throw new Error(`Unexpected: ${method} ${url}`);
    },
  });

  // Simulate a task that was completed at source: mirror_error set, mirror_event_id present
  db.prepare("INSERT INTO remote_tasks(task_key, account_id, list_id, source, task_json) VALUES (?, ?, ?, ?, ?)").run(
    key, "account-a", "list-a", "microsoft",
    JSON.stringify({ id: "task-reopen", key, source: "microsoft", account_id: "account-a", list_id: "list-a",
      title: "Atnaujinta", notes: "", due_at: null, duration_minutes: 30, completed: 0,
      project: "Microsoft To Do", priority: "normal", energy: "medium", tags: "",
      scheduled_at: null, schedule_version: 1, legacy_schedule: 0,
      mirror_requested: 0, mirror_event_id: "stale-event", mirror_error: "Užduotis užbaigta šaltinyje. Atverk ją ir išsaugok, kad pašalintum susietą Outlook bloką." })
  );
  db.prepare("INSERT OR REPLACE INTO task_plans(task_key, duration_minutes, scheduled_at, mirror_requested, mirror_event_id, schedule_version, mirror_error) VALUES (?, 30, NULL, 0, 'stale-event', 1, ?)").run(
    key, "Užduotis užbaigta šaltinyje. Atverk ją ir išsaugok, kad pašalintum susietą Outlook bloką."
  );

  // Now user saves the task (update) to trigger syncMirror cleanup — 404 should be success
  const updated = await service.update({
    id: "task-reopen", source: "microsoft", account_id: "account-a", list_id: "list-a",
    schedule_version: 1, title: "Atnaujinta",
  });

  assert.ok(deleteCalls.length > 0, "DELETE was attempted");
  assert.equal(updated.mirror_event_id, null, "mirror_event_id cleared");
  assert.equal(updated.mirror_error, null, "mirror_error cleared after 404");
});

after(() => hooks.deregister());
