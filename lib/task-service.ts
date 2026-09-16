import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export type RemoteTaskSource = "microsoft" | "google";
export type TaskList = { key: string; source: RemoteTaskSource; account_id: string; list_id: string; name: string; writable: boolean; stale?: boolean };
export type Task = {
  id: number | string; source: "local" | RemoteTaskSource; account_id?: string; list_id?: string; list_name?: string;
  due_date?: string | null; readonly_reason?: string; source_url?: string; parent_id?: string;
  key: string; title: string; notes: string; due_at: string | null; scheduled_at: string | null;
  duration_minutes: number; completed: number; project: string; priority: "low" | "normal" | "high";
  tags: string; energy: string; schedule_version: number; legacy_schedule: number;
  mirror_requested: number; mirror_event_id: string | null; mirror_error: string | null; stale?: boolean;
};
type Input = Record<string, unknown>;
type Plan = {
  task_key: string; scheduled_at: string | null; duration_minutes: number; schedule_version: number;
  legacy_schedule: number; mirror_requested: number; mirror_event_id: string | null;
  mirror_account_id: string | null; mirror_transaction_id: string | null; mirror_error: string | null; mirror_create_payload: string | null;
  project: string | null; tags: string | null; energy: string | null; local_priority: Task["priority"] | null;
};
export type TaskGateway = {
  connected(): boolean;
  cachedAccountId(): string | null;
  accountId(): Promise<string>;
  defaultListId?(): Promise<string>;
  request(path: string, init?: RequestInit): Promise<any>;
};

export class TaskError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
const locks = new Map<string, Promise<unknown>>();
async function serial<T>(key: string, action: () => Promise<T>) {
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  locks.set(key, current);
  try { return await current; } finally { if (locks.get(key) === current) locks.delete(key); }
}
function duration(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 5 || value > 1440) throw new TaskError("Trukmė turi būti nuo 5 iki 1440 minučių.");
  return value;
}
function dateValue(value: unknown, exact = false): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || (exact && !/(Z|[+-]\d{2}:\d{2})$/i.test(value)) || !Number.isFinite(Date.parse(value))) throw new TaskError("Neteisinga data. Planavimui pateik laiką su laiko zona.");
  return new Date(value).toISOString();
}
function title(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) throw new TaskError("Įvesk užduoties pavadinimą (iki 1024 simbolių).");
  return value.trim();
}
function priority(value: unknown): Task["priority"] {
  if (value !== "low" && value !== "normal" && value !== "high") throw new TaskError("Neteisingas prioritetas.");
  return value;
}
function text(value: unknown, max = 8192) {
  if (typeof value !== "string" || value.length > max) throw new TaskError("Neteisingas arba per ilgas tekstas.");
  return value;
}
function remoteKey(account: string, list: string, id: string, source: RemoteTaskSource = "microsoft") { return JSON.stringify([source, account, list, id]); }
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048 || value === "." || value === ".." || /[\u0000-\u001f]/.test(value)) throw new TaskError("Neteisingas paskyros, sąrašo arba užduoties ID.");
  return value;
}
function dateOnly(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw new TaskError("Google užduoties dieną nurodyk formatu YYYY-MM-DD.");
  return value;
}
function localKey(id: string | number) { return `local:${id}`; }
function googleTaskLink(value: unknown) {
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      if (url.origin === "https://tasks.google.com" && !url.username && !url.password) return url.href;
    } catch { /* Fall back to the provider's task list. */ }
  }
  return "https://tasks.google.com/";
}

// Called after the original tasks schema/migrations. This migration is atomic
// and preserves the original ambiguous due_at value as a deadline AND snapshot.
export function migrateTaskPlanning(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS task_plans (
      task_key TEXT PRIMARY KEY, scheduled_at TEXT, duration_minutes INTEGER NOT NULL DEFAULT 30,
      schedule_version INTEGER NOT NULL DEFAULT 0, legacy_schedule INTEGER NOT NULL DEFAULT 0,
      mirror_requested INTEGER NOT NULL DEFAULT 0, mirror_event_id TEXT, mirror_account_id TEXT,
      mirror_transaction_id TEXT, mirror_error TEXT, project TEXT, tags TEXT, energy TEXT, mirror_create_payload TEXT
    ); CREATE TABLE IF NOT EXISTS remote_tasks (task_key TEXT PRIMARY KEY, account_id TEXT NOT NULL, list_id TEXT NOT NULL, task_json TEXT NOT NULL);`);
    const columns = db.prepare("PRAGMA table_info(task_plans)").all() as {name: string}[];
    if (!columns.some((column) => column.name === "mirror_create_payload")) db.exec("ALTER TABLE task_plans ADD COLUMN mirror_create_payload TEXT");
    if (!columns.some((column) => column.name === "local_priority")) db.exec("ALTER TABLE task_plans ADD COLUMN local_priority TEXT");
    if (!(db.prepare("PRAGMA table_info(remote_tasks)").all() as {name:string}[]).some(c=>c.name === "source")) db.exec("ALTER TABLE remote_tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'microsoft'");
    db.exec("CREATE TABLE IF NOT EXISTS remote_task_lists (list_key TEXT PRIMARY KEY, source TEXT NOT NULL, account_id TEXT NOT NULL, list_json TEXT NOT NULL)");
    if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migration_task_plans_v1'").get()) {
      const legacy = db.prepare("SELECT id, due_at, duration_minutes FROM tasks WHERE due_at IS NOT NULL").all() as { id: number; due_at: string; duration_minutes: number }[];
      const insert = db.prepare("INSERT OR IGNORE INTO task_plans(task_key, scheduled_at, duration_minutes, legacy_schedule) VALUES (?, ?, ?, 1)");
      for (const task of legacy) {
        if (Number.isFinite(Date.parse(task.due_at))) insert.run(localKey(task.id), task.due_at, Math.min(1440, Math.max(5, task.duration_minutes || 30)));
      }
      db.prepare("INSERT INTO settings(key, value) VALUES ('migration_task_plans_v1', '1')").run();
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function createTaskService(db: DatabaseSync, microsoft: TaskGateway, google?: TaskGateway) {
  function gateway(source: RemoteTaskSource) {
    const result = source === "microsoft" ? microsoft : google;
    if (!result || !result.connected()) throw new TaskError(`${source === "google" ? "Google Tasks" : "Microsoft"} paskyra neprijungta arba nesuteikti leidimai.`, 409);
    return result;
  }
  function requireAccount(account: string, source: RemoteTaskSource = "microsoft") {
    if (gateway(source).cachedAccountId() !== account) throw new TaskError("Paskyra pasikeitė. Atnaujink duomenis.", 409);
  }
  function plan(key: string) { return db.prepare("SELECT * FROM task_plans WHERE task_key = ?").get(key) as Plan | undefined; }
  function decorate(base: Task): Task {
    const extra = plan(base.key);
    return { ...base, scheduled_at: extra?.scheduled_at ?? null, duration_minutes: extra?.duration_minutes ?? base.duration_minutes,
      schedule_version: extra?.schedule_version ?? 0, legacy_schedule: extra?.legacy_schedule ?? 0,
      mirror_requested: extra?.mirror_requested ?? 0, mirror_event_id: extra?.mirror_event_id ?? null, mirror_error: extra?.mirror_error ?? null,
      project: extra?.project ?? base.project, tags: extra?.tags ?? base.tags, energy: extra?.energy ?? base.energy,
      priority: base.source === "google" ? extra?.local_priority ?? base.priority : base.priority };
  }
  function ensurePlan(task: Task) {
    db.prepare("INSERT OR IGNORE INTO task_plans(task_key, duration_minutes) VALUES (?, ?)").run(task.key, task.duration_minutes || 30);
    return plan(task.key)!;
  }
  function localTasks() {
    return (db.prepare("SELECT * FROM tasks ORDER BY completed, COALESCE(due_at, '9999'), created_at DESC").all() as unknown as Task[])
      .map((task) => decorate({ ...task, source: "local", key: localKey(task.id) }));
  }
  function cachedTasks(account: string, source: RemoteTaskSource, list?: string) {
    return (db.prepare("SELECT task_json FROM remote_tasks WHERE account_id = ? AND source = ? AND (? IS NULL OR list_id = ?)").all(account, source, list ?? null, list ?? null) as {task_json: string}[]).map((row) => decorate(JSON.parse(row.task_json) as Task));
  }
  function reference(input: Input) {
    if (input.source !== undefined && input.source !== "local" && input.source !== "microsoft" && input.source !== "google") throw new TaskError("Nežinomas užduoties šaltinis.");
    if (!input.source || input.source === "local") {
      if (!/^[1-9]\d*$/.test(String(input.id))) throw new TaskError("Neteisingas vietinės užduoties ID.");
      return localKey(String(input.id));
    }
    return remoteKey(identifier(input.account_id), identifier(input.list_id), identifier(input.id), input.source);
  }
  function get(input: Input): Task {
    const key = reference(input);
    if (!input.source || input.source === "local") {
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(Number(input.id)) as unknown as Task | undefined;
      if (!row) throw new TaskError("Užduotis nerasta.", 404);
      return decorate({ ...row, source: "local", key });
    }
    requireAccount(input.account_id as string, input.source as RemoteTaskSource);
    const row = db.prepare("SELECT task_json FROM remote_tasks WHERE task_key = ?").get(key) as { task_json: string } | undefined;
    if (!row) throw new TaskError("Užduotis nerasta. Atnaujink sąrašą.", 404);
    return decorate(JSON.parse(row.task_json) as Task);
  }
  function cache(task: Task) {
    db.prepare("INSERT INTO remote_tasks(task_key, account_id, list_id, task_json, source) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_key) DO UPDATE SET task_json=excluded.task_json")
      .run(task.key, task.account_id!, task.list_id!, JSON.stringify(task), task.source);
  }
  function mapped(task: any, list: TaskList): Task {
    const isGoogle = list.source === "google";
    const due = task.dueDateTime?.dateTime;
    return { id: identifier(task.id), key: remoteKey(list.account_id, list.list_id, task.id, list.source), source: list.source,
      account_id: list.account_id, list_id: list.list_id, list_name: list.name,
      source_url: isGoogle ? googleTaskLink(task.webViewLink) : "https://to-do.office.com/tasks/",
      ...(isGoogle && typeof task.parent === "string" ? {parent_id:task.parent} : {}),
      ...(list.writable ? {} : {readonly_reason:"Šis specialus sąrašas rodomas tik skaitymui. Darbo laiką galima planuoti vietoje."}),
      title: task.title || "Be pavadinimo", notes: isGoogle ? task.notes || "" : task.body?.content || "",
      due_at: !isGoogle && due ? new Date(/(Z|[+-]\d{2}:\d{2})$/i.test(due) ? due : `${due}Z`).toISOString() : null,
      ...(isGoogle ? {due_date: task.due ? dateOnly(String(task.due).slice(0,10)) : null} : {}),
      duration_minutes: 30, completed: task.status === "completed" ? 1 : 0,
      project: isGoogle ? "Google Tasks" : "Microsoft To Do", priority: isGoogle ? "normal" : task.importance || "normal", energy: "medium", tags: "",
      scheduled_at: null, schedule_version: 0, legacy_schedule: 0, mirror_requested: 0, mirror_event_id: null, mirror_error: null };
  }
  async function pages(source: RemoteTaskSource, path: string, query: string) {
    const provider = gateway(source), values: any[] = [], visited = new Set<string>();
    let next: string | null = path + query;
    while (next) {
      if (visited.has(next) || visited.size >= 2000) throw new Error("Pasikartojantis arba per ilgas puslapiavimas");
      visited.add(next);
      const response = await provider.request(next);
      const page = response[source === "google" ? "items" : "value"] ?? (source === "google" ? [] : undefined);
      if (!Array.isArray(page)) throw new Error("Neteisingas užduočių atsakymas");
      values.push(...page);
      if (source === "google") {
        const token = response.nextPageToken;
        if (token && (typeof token !== "string" || token.length > 8192)) throw new Error("Neteisingas puslapio žetonas");
        next = token ? path + query + "&pageToken=" + encodeURIComponent(token) : null;
      } else {
        next = response["@odata.nextLink"] || null;
        if (next) {
          const url = new URL(next);
          if (url.origin !== "https://graph.microsoft.com" || url.pathname !== "/v1.0" + path || url.hash || url.username || url.password) throw new Error("Neteisinga puslapiavimo nuoroda");
          next = url.pathname.slice("/v1.0".length) + url.search;
        }
      }
    }
    return values;
  }
  async function fetchLists(source: RemoteTaskSource, account: string): Promise<TaskList[]> {
    const raw = await pages(source, source === "google" ? "/users/@me/lists" : "/me/todo/lists", source === "google" ? "?maxResults=1000" : "?$top=100");
    requireAccount(account, source);
    const lists = raw.map(list => ({
      key: JSON.stringify([source, account, identifier(list.id)]), source, account_id:account, list_id:list.id as string,
      name:String(source === "google" ? list.title || "Google Tasks" : list.displayName || "Microsoft To Do"),
      writable:source === "google" || !list.wellknownListName || ["none","defaultList"].includes(list.wellknownListName),
    }));
    return [...new Map(lists.map(list=>[list.key,list])).values()];
  }
  function cachedLists(source: RemoteTaskSource, account: string): TaskList[] {
    return (db.prepare("SELECT list_json FROM remote_task_lists WHERE source=? AND account_id=?").all(source,account) as {list_json:string}[]).map(row=>JSON.parse(row.list_json));
  }
  async function listProvider(source: RemoteTaskSource) {
    const items: Task[] = [], lists: TaskList[] = [], warnings: string[] = [];
    const provider = source === "microsoft" ? microsoft : google;
    if (!provider?.connected()) return {items,lists,warnings};
    let account = provider.cachedAccountId();
    try {
      account = await provider.accountId();
      const available = await fetchLists(source,account);
      const staged: {list:TaskList;tasks:Task[];fresh:boolean}[] = [];
      for (const list of available) {
        try {
          const path = source === "google" ? `/lists/${encodeURIComponent(list.list_id)}/tasks` : `/me/todo/lists/${encodeURIComponent(list.list_id)}/tasks`;
          const raw = await pages(source,path,source === "google" ? "?maxResults=100&showCompleted=true&showHidden=true&showDeleted=false&showAssigned=false" : "?$top=100");
          staged.push({list,tasks:raw.filter(task=>!task.deleted && !task.assignmentInfo).map(task=>mapped(task,list)),fresh:true});
        } catch {
          staged.push({list:{...list,stale:true},tasks:cachedTasks(account,source,list.list_id).map(task=>({...task,list_name:list.name,stale:true})),fresh:false});
          warnings.push(`${source === "google" ? "Google" : "Microsoft"}: sąrašo „${list.name}“ atnaujinti nepavyko; duomenys gali būti pasenę.`);
        }
      }
      requireAccount(account, source);
      // Commit only after all reads and account checks. Planning rows survive
      // remote deletion; a failed list never replaces its last good snapshot.
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM remote_task_lists WHERE source=? AND account_id=?").run(source,account);
        for (const entry of staged) {
          db.prepare("INSERT INTO remote_task_lists(list_key,source,account_id,list_json) VALUES (?,?,?,?)").run(entry.list.key,source,account,JSON.stringify(entry.list));
          if (entry.fresh) {
            db.prepare("DELETE FROM remote_tasks WHERE source=? AND account_id=? AND list_id=?").run(source,account,entry.list.list_id);
            for (const task of entry.tasks) {
              // A completion observed at the source must not resurrect the old
              // work block when that task is later reopened. Failed reads never
              // enter this branch, so an outage cannot erase a local plan.
              if (task.completed) db.prepare(`UPDATE task_plans SET scheduled_at=NULL, mirror_requested=0,
                schedule_version=schedule_version+1,
                mirror_error=CASE WHEN mirror_event_id IS NOT NULL OR mirror_transaction_id IS NOT NULL
                  THEN 'Užduotis užbaigta šaltinyje. Atverk ją ir išsaugok, kad pašalintum susietą Outlook bloką.' ELSE mirror_error END
                WHERE task_key=? AND (scheduled_at IS NOT NULL OR mirror_requested<>0)`).run(task.key);
              cache(task);
            }
          }
        }
        for (const task of cachedTasks(account,source)) if (!available.some(list=>list.list_id === task.list_id)) db.prepare("DELETE FROM remote_tasks WHERE task_key=?").run(task.key);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      for (const entry of staged) {lists.push(entry.list);items.push(...entry.tasks.map(decorate));}
    } catch {
      if (account && provider.connected() && provider.cachedAccountId() === account) {
        items.push(...cachedTasks(account,source).map(task=>({...task,stale:true})));
        lists.push(...cachedLists(source,account).map(list=>({...list,stale:true})));
      }
      warnings.push(`${source === "google" ? "Google Tasks" : "Microsoft"} užduočių atnaujinti nepavyko. Vietinės užduotys veikia; išsaugoti duomenys gali būti pasenę.`);
    }
    return {items,lists,warnings};
  }
  async function list() {
    const results = await Promise.all((["microsoft","google"] as const).map(source=>serial("task-provider:" + source,()=>listProvider(source))));
    return {items:[...localTasks(),...results.flatMap(result=>result.items)],lists:results.flatMap(result=>result.lists),warnings:results.flatMap(result=>result.warnings)};
  }
  async function syncMirror(task: Task) {
    const current = plan(task.key);
    if (!current || (!current.mirror_requested && !current.mirror_event_id && !current.mirror_transaction_id)) return;
    try {
      if (!microsoft.connected()) throw new Error("Paskyra neprijungta");
      const account = await microsoft.accountId();
      requireAccount(account);
      if (current.mirror_account_id && current.mirror_account_id !== account) throw new Error("Kita paskyra");
      if (!current.mirror_requested || !current.scheduled_at || task.completed) {
        // An uncertain create must be resolved with its persisted transactionId
        // before deletion, so retries do not leave an orphan free block.
        if (!current.mirror_event_id && current.mirror_create_payload) {
          const recovered = await microsoft.request("/me/events", {method:"POST", body: current.mirror_create_payload});
          if (!recovered?.id) throw new Error("Nepavyko nustatyti bloko");
          current.mirror_event_id = recovered.id;
          db.prepare("UPDATE task_plans SET mirror_event_id=? WHERE task_key=?").run(recovered.id, task.key);
        }
        if (current.mirror_event_id) await microsoft.request(`/me/events/${encodeURIComponent(current.mirror_event_id)}`, { method: "DELETE" });
        db.prepare("UPDATE task_plans SET mirror_event_id=NULL, mirror_account_id=NULL, mirror_transaction_id=NULL, mirror_create_payload=NULL, mirror_error=NULL WHERE task_key=?").run(task.key);
        return;
      }
      const transactionId = current.mirror_transaction_id || randomUUID();
      db.prepare("UPDATE task_plans SET mirror_account_id=?, mirror_transaction_id=? WHERE task_key=?").run(account, transactionId, task.key);
      const start = new Date(current.scheduled_at);
      const payload = { subject: `✓ ${task.title}`, body: {contentType: "text", content: "Dienos planas: pasirenkamas užduoties darbo laikas."},
        start: {dateTime: start.toISOString().replace(/Z$/, ""), timeZone:"UTC"},
        end: {dateTime: new Date(start.getTime() + current.duration_minutes * 60000).toISOString().replace(/Z$/, ""), timeZone:"UTC"},
        showAs: "free", isReminderOn: false };
      let eventId = current.mirror_event_id;
      if (!eventId) {
        const createPayload = current.mirror_create_payload || JSON.stringify({...payload, transactionId});
        db.prepare("UPDATE task_plans SET mirror_create_payload=? WHERE task_key=?").run(createPayload, task.key);
        const result = await microsoft.request("/me/events", {method:"POST", body:createPayload});
        eventId = result?.id;
        if (eventId) db.prepare("UPDATE task_plans SET mirror_event_id=? WHERE task_key=?").run(eventId, task.key);
      }
      if (!eventId) throw new Error("Nėra įvykio ID");
      await microsoft.request(`/me/events/${encodeURIComponent(eventId)}`, {method:"PATCH",body:JSON.stringify(payload)});
      db.prepare("UPDATE task_plans SET mirror_event_id=?, mirror_error=NULL WHERE task_key=?").run(eventId, task.key);
    } catch {
      db.prepare("UPDATE task_plans SET mirror_error=? WHERE task_key=?").run("Vietinis planas išsaugotas, bet Outlook bloko sinchronizuoti nepavyko. Prijunk tą pačią paskyrą ir pakartok.", task.key);
    }
  }
  async function create(input: Input) {
    const source = input.source ?? "local";
    if (source !== "local" && source !== "microsoft" && source !== "google") throw new TaskError("Nežinomas užduoties šaltinis.");
    if (source === "google" && input.due_at) throw new TaskError("Google Tasks palaiko tik dieną. Naudok due_date, ne due_at.");
    if (source !== "google" && input.due_date !== undefined) throw new TaskError("Šiam šaltiniui naudok due_at.");
    const dueDate = source === "google" ? dateOnly(input.due_date ?? null) : null;
    const values = { title: title(input.title), notes: text(input.notes ?? ""), due_at: input.due_at ? dateValue(input.due_at, true) : null,
      duration_minutes: duration(input.duration_minutes ?? 30), project: text(input.project ?? (source === "local" ? "Asmeniniai" : source === "google" ? "Google Tasks" : "Microsoft To Do"), 200),
      priority: priority(input.priority ?? "normal"), tags: text(input.tags ?? "", 1000), energy: text(input.energy ?? "medium", 30) };
    if (source === "local") {
      const result = db.prepare("INSERT INTO tasks(title, notes, due_at, duration_minutes, project, priority, tags, energy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(values.title, values.notes, values.due_at, values.duration_minutes, values.project, values.priority, values.tags, values.energy);
      return get({ id: Number(result.lastInsertRowid), source });
    }
    const provider = gateway(source), account = await provider.accountId();
    // Explicit destinations are bound to the account displayed when selected.
    if (input.list_id !== undefined || input.account_id !== undefined || source === "google") {
      identifier(input.list_id); identifier(input.account_id);
      if (input.account_id !== account) throw new TaskError("Pasirinkto sąrašo paskyra pasikeitė. Atnaujink duomenis.", 409);
    }
    const listId = input.list_id === undefined ? await provider.defaultListId?.() : identifier(input.list_id);
    requireAccount(account,source);
    if (!listId) throw new TaskError("Pasirink užduočių sąrašą.");
    const lists = input.list_id !== undefined ? await fetchLists(source,account) : [];
    const destination = lists.find(list=>list.list_id === listId) ?? (input.list_id === undefined ? {key:"",source,account_id:account,list_id:listId,name:"Microsoft To Do",writable:true} : undefined);
    if (!destination) throw new TaskError("Sąrašo nebėra. Atnaujink duomenis.",409);
    if (!destination.writable) throw new TaskError("Šiame specialiame sąraše užduočių kurti negalima.",403);
    requireAccount(account,source);
    const path = source === "google" ? `/lists/${encodeURIComponent(listId)}/tasks` : `/me/todo/lists/${encodeURIComponent(listId)}/tasks`;
    const body = source === "google" ? {title:values.title,notes:values.notes,...(dueDate ? {due:dueDate + "T00:00:00.000Z"} : {})} : {title:values.title,body:{content:values.notes,contentType:"text"},importance:values.priority,...(values.due_at ? {dueDateTime:{dateTime:values.due_at.replace(/Z$/,""),timeZone:"UTC"}} : {})};
    const result = await provider.request(path,{method:"POST",body:JSON.stringify(body)});
    requireAccount(account,source);
    const task = mapped(result, destination); cache(task); ensurePlan(task);
    db.prepare("UPDATE task_plans SET duration_minutes=?, project=?, tags=?, energy=?, local_priority=? WHERE task_key=?").run(values.duration_minutes, values.project, values.tags, values.energy, source === "google" ? values.priority : null, task.key);
    return decorate(task);
  }
  async function update(input: Input) {
    const key = reference(input);
    return serial(key, async () => {
      const current = get(input); const changes: Input = {};
      if (input.title !== undefined) changes.title = title(input.title);
      if (input.notes !== undefined) changes.notes = text(input.notes);
      if (current.source === "google") {
        if (input.due_at !== undefined) throw new TaskError("Google užduočiai naudok due_date, ne due_at.");
        if (input.due_date !== undefined) changes.due_date = dateOnly(input.due_date);
      } else {
        if (input.due_date !== undefined) throw new TaskError("Šiam šaltiniui naudok due_at.");
        if (input.due_at !== undefined) changes.due_at = dateValue(input.due_at, true);
      }
      if (input.priority !== undefined) changes.priority = priority(input.priority);
      for (const field of ["project", "tags", "energy"]) if (input[field] !== undefined) changes[field] = text(input[field], 1000);
      if (input.completed !== undefined) {
        if (typeof input.completed !== "boolean") throw new TaskError("Neteisinga užbaigimo būsena.");
        changes.completed = input.completed ? 1 : 0;
      }
      if (input.duration_minutes !== undefined) changes.duration_minutes = duration(input.duration_minutes);
      const scheduling = input.scheduled_at !== undefined || input.duration_minutes !== undefined || input.mirror_requested !== undefined;
      if (scheduling && input.schedule_version !== current.schedule_version) throw new TaskError("Planas jau pakeistas. Atnaujink duomenis ir bandyk dar kartą.", 409);
      if (input.scheduled_at !== undefined) changes.scheduled_at = dateValue(input.scheduled_at, true);
      if (input.mirror_requested !== undefined && typeof input.mirror_requested !== "boolean") throw new TaskError("Neteisingas Outlook bloko pasirinkimas.");
      const next = { ...current, ...changes } as Task;
      if (next.completed && input.scheduled_at) throw new TaskError("Atliktos užduoties planuoti negalima.");
      if (current.readonly_reason && ["title","notes","due_at","due_date","priority","completed"].some(field=>changes[field] !== undefined)) throw new TaskError(current.readonly_reason,403);
      if (current.source !== "local") {
        const provider = gateway(current.source);
        const patch: Input = {};
        if (changes.title !== undefined) patch.title = changes.title;
        if (current.source === "google") {
          if (changes.notes !== undefined) patch.notes = changes.notes;
          if (changes.completed !== undefined) patch.status = next.completed ? "completed" : "needsAction";
          if (changes.due_date !== undefined) patch.due = next.due_date ? next.due_date + "T00:00:00.000Z" : null;
        } else {
          if (changes.notes !== undefined) patch.body = {contentType:"text",content:changes.notes};
          if (changes.priority !== undefined) patch.importance = changes.priority;
          if (changes.completed !== undefined) patch.status = next.completed ? "completed" : "notStarted";
          if (changes.due_at !== undefined) patch.dueDateTime = next.due_at ? {dateTime:next.due_at.replace(/Z$/, ""),timeZone:"UTC"} : null;
        }
        requireAccount(current.account_id!,current.source);
        const path = `${current.source === "google" ? "/lists" : "/me/todo/lists"}/${encodeURIComponent(current.list_id!)}/tasks/${encodeURIComponent(String(current.id))}`;
        if (Object.keys(patch).length) await provider.request(path, {method:"PATCH", body:JSON.stringify(patch)});
        requireAccount(current.account_id!,current.source);
        cache(next);
      } else {
        db.prepare("UPDATE tasks SET title=?, notes=?, due_at=?, duration_minutes=?, completed=?, project=?, priority=?, energy=?, tags=? WHERE id=?")
          .run(next.title, next.notes, next.due_at, next.duration_minutes, next.completed, next.project, next.priority, next.energy, next.tags, Number(next.id));
      }
      const extra = ensurePlan(current);
      const scheduledAt = next.completed ? null : next.scheduled_at;
      const mirror = scheduledAt ? (input.mirror_requested === undefined ? extra.mirror_requested : Number(input.mirror_requested)) : 0;
      db.prepare("UPDATE task_plans SET scheduled_at=?, duration_minutes=?, schedule_version=schedule_version+1, legacy_schedule=?, mirror_requested=?, project=?, tags=?, energy=?, local_priority=? WHERE task_key=?")
        .run(scheduledAt, next.duration_minutes, input.scheduled_at !== undefined ? 0 : extra.legacy_schedule, mirror, next.project, next.tags, next.energy, next.source === "google" ? next.priority : null, key);
      await syncMirror(next);
      return get(input);
    });
  }
  async function remove(input: Input) {
    return serial(reference(input), async () => {
      const task = get(input); const extra = ensurePlan(task);
      if (task.readonly_reason) throw new TaskError(task.readonly_reason,403);
      db.prepare("UPDATE task_plans SET mirror_requested=0 WHERE task_key=?").run(task.key);
      await syncMirror(task);
      if (plan(task.key)?.mirror_error) {
        db.prepare("UPDATE task_plans SET mirror_requested=? WHERE task_key=?").run(extra.mirror_requested, task.key);
        throw new TaskError("Pirmiausia pakartok susieto Outlook bloko pašalinimą.", 409);
      }
      if (task.source !== "local") {
        requireAccount(task.account_id!,task.source);
        await gateway(task.source).request(`${task.source === "google" ? "/lists" : "/me/todo/lists"}/${encodeURIComponent(task.list_id!)}/tasks/${encodeURIComponent(String(task.id))}`, {method:"DELETE"});
        requireAccount(task.account_id!,task.source);
        db.prepare("DELETE FROM remote_tasks WHERE task_key=?").run(task.key);
      } else db.prepare("DELETE FROM tasks WHERE id=?").run(Number(task.id));
      db.prepare("DELETE FROM task_plans WHERE task_key=?").run(task.key);
    });
  }
  // Prevent a slow read from replacing a just-written remote cache snapshot.
  function mutation<T>(input: Input, operation: () => Promise<T>) {return input.source === "google" || input.source === "microsoft" ? serial("task-provider:" + input.source,operation) : operation();}
  return { list, create:(input:Input)=>mutation(input,()=>create(input)), update:(input:Input)=>mutation(input,()=>update(input)), remove:(input:Input)=>mutation(input,()=>remove(input)) };
}
