import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { graphRecurrence, parseTaskRecurrence, providerRecurrence, sameTaskRecurrence, taskRecurrenceDate } from "./task-recurrence.ts";
import { ProviderError } from "./provider-error.ts";
import { OUTLOOK_MIRROR_BODY } from "./outlook-mirror-link.ts";

export type RemoteTaskSource = "microsoft" | "google";
export type TaskList = { key: string; source: RemoteTaskSource; account_id: string; list_id: string; name: string; writable: boolean; stale?: boolean;
  version?: string; can_rename?: boolean; can_delete?: boolean; management_reason?: string; etag?: string };
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
type PendingGoogleMove = { setting_key: string; account_id: string; source_list_id: string; destination_list_id: string;
  old_task_id: string; old_key: string; schedule_version: number; moved_id: string | null };
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
function listName(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 255) throw new TaskError("Įvesk sąrašo pavadinimą (iki 255 simbolių).");
  return value.trim();
}
function fingerprint(value: unknown): string {
  const stable = (item: any): any => Array.isArray(item) ? item.map(stable) : item && typeof item === "object"
    ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,stable(item[key])])) : item;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
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
  function pendingMoveKey(oldKey: string) { return `task_move_pending:${createHash("sha256").update(oldKey).digest("hex")}`; }
  function pendingMoves(account: string): PendingGoogleMove[] {
    const rows = db.prepare("SELECT key,value FROM settings WHERE key LIKE 'task_move_pending:%'").all() as {key:string;value:string}[];
    return rows.flatMap(row=>{
      try {
        const value=JSON.parse(row.value) as Omit<PendingGoogleMove,"setting_key">;
        return value.account_id===account && value.old_key && value.destination_list_id ? [{...value,setting_key:row.key}] : [];
      } catch { return []; }
    });
  }
  function writePendingMove(move: PendingGoogleMove) {
    const {setting_key,...value}=move;
    db.prepare("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(setting_key,JSON.stringify(value));
  }
  function applyMoveRows(move: PendingGoogleMove, moved: Task, expectedVersion?: number) {
    const destinationPlan = plan(moved.key);
    if (destinationPlan && moved.key !== move.old_key) throw new TaskError("Paskirties užduoties planas jau egzistuoja. Atnaujink duomenis.",409);
    const existing = db.prepare("SELECT account_id,list_id,source,task_json FROM remote_tasks WHERE task_key=?").get(moved.key) as {account_id:string;list_id:string;source:string;task_json:string}|undefined;
    if (existing) {
      let existingId: unknown;
      try { existingId=(JSON.parse(existing.task_json) as {id?:unknown}).id; } catch { /* Invalid cache is a conflict. */ }
      if (existing.account_id!==move.account_id || existing.list_id!==move.destination_list_id || existing.source!=="google" || existingId!==moved.id) {
        throw new TaskError("Paskirties užduoties vietiniai duomenys jau egzistuoja. Atnaujink duomenis.",409);
      }
    }
    const oldPlan=plan(move.old_key);
    if (oldPlan) {
      const version=expectedVersion ?? oldPlan.schedule_version;
      const changed=db.prepare("UPDATE task_plans SET task_key=?,schedule_version=schedule_version+1 WHERE task_key=? AND schedule_version=?")
        .run(moved.key,move.old_key,version);
      if (changed.changes!==1) throw new TaskError("Planas jau pakeistas. Atnaujink duomenis ir bandyk dar kartą.",409);
    }
    db.prepare(`INSERT INTO remote_tasks(task_key,account_id,list_id,task_json,source) VALUES (?,?,?,?,?)
      ON CONFLICT(task_key) DO UPDATE SET account_id=excluded.account_id,list_id=excluded.list_id,task_json=excluded.task_json,source=excluded.source`)
      .run(moved.key,move.account_id,move.destination_list_id,JSON.stringify(moved),"google");
    db.prepare("DELETE FROM remote_tasks WHERE task_key=? AND task_key<>?").run(move.old_key,moved.key);
    db.prepare("DELETE FROM settings WHERE key=?").run(move.setting_key);
  }
  function reconcilePendingMoves(account: string, staged: {list:TaskList;tasks:Task[];fresh:boolean}[], warnings: string[]) {
    for (const move of pendingMoves(account)) {
      const source=staged.find(entry=>entry.list.list_id===move.source_list_id),destination=staged.find(entry=>entry.list.list_id===move.destination_list_id);
      if (!source?.fresh || !destination?.fresh) { warnings.push("Google: laukiamas užduoties perkėlimo suderinimas."); continue; }
      const sourceExists=source.tasks.some(task=>String(task.id)===move.old_task_id);
      const expectedId=move.moved_id ?? move.old_task_id;
      const candidates=destination.tasks.filter(task=>String(task.id)===expectedId);
      if (sourceExists && !candidates.length) { db.prepare("DELETE FROM settings WHERE key=?").run(move.setting_key); continue; }
      if (sourceExists || candidates.length!==1) { warnings.push("Google: nepavyko automatiškai suderinti nutrūkusio užduoties perkėlimo."); continue; }
      db.exec("SAVEPOINT reconcile_google_move");
      try {
        applyMoveRows(move,candidates[0]);
        db.exec("RELEASE reconcile_google_move");
        warnings.push("Google: užbaigtas anksčiau nutrūkęs užduoties perkėlimas.");
      } catch {
        db.exec("ROLLBACK TO reconcile_google_move");db.exec("RELEASE reconcile_google_move");
        warnings.push("Google: perkėlimas įvyko, bet vietiniam planui suderinti reikia atnaujinti duomenis.");
      }
    }
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
  function mappedList(raw: any, source: RemoteTaskSource, account: string): TaskList {
    const builtin = source === "microsoft" && raw.wellknownListName !== "none";
    const managed = source === "google" || (!builtin && raw.isOwner === true);
    const list: TaskList = {
      key: JSON.stringify([source,account,identifier(raw.id)]), source, account_id:account, list_id:raw.id,
      name:String(source === "google" ? raw.title || "Google Tasks" : raw.displayName || "Microsoft To Do"),
      writable:source === "google" || !raw.wellknownListName || ["none","defaultList"].includes(raw.wellknownListName),
      can_rename:managed,can_delete:managed,
      ...(!managed ? {management_reason:builtin ? "Įtaisytų arba neatpažintų Microsoft sąrašų pervadinti ir šalinti negalima." : "Šį sąrašą gali valdyti tik jo savininkas."} : {}),
      ...(typeof raw.etag === "string" ? {etag:raw.etag} : {}),
    };
    return {...list,version:fingerprint(list)};
  }
  async function fetchLists(source: RemoteTaskSource, account: string): Promise<TaskList[]> {
    const raw = await pages(source, source === "google" ? "/users/@me/lists" : "/me/todo/lists", source === "google" ? "?maxResults=1000" : "?$top=100");
    requireAccount(account, source);
    const lists = raw.map(list => mappedList(list,source,account));
    return [...new Map(lists.map(list=>[list.key,list])).values()];
  }
  function cachedLists(source: RemoteTaskSource, account: string): TaskList[] {
    return (db.prepare("SELECT list_json FROM remote_task_lists WHERE source=? AND account_id=?").all(source,account) as {list_json:string}[]).map(row=>JSON.parse(row.list_json));
  }
  function saveList(list: TaskList) {
    db.prepare("INSERT INTO remote_task_lists(list_key,source,account_id,list_json) VALUES (?,?,?,?) ON CONFLICT(list_key) DO UPDATE SET list_json=excluded.list_json")
      .run(list.key,list.source,list.account_id,JSON.stringify(list));
  }
  function listReference(input: Input): {source:RemoteTaskSource;account:string} {
    if (input.source !== "google" && input.source !== "microsoft") throw new TaskError("Pasirink Google arba Microsoft sąrašą.");
    const source = input.source, account = identifier(input.account_id);
    requireAccount(account,source);
    return {source,account};
  }
  async function currentList(input: Input) {
    const {source,account} = listReference(input), id=identifier(input.list_id);
    const list=(await fetchLists(source,account)).find(list=>list.list_id===id);
    if (!list) throw new TaskError("Sąrašas neberastas. Atnaujink duomenis.",404);
    return list;
  }
  const listPath = (source:RemoteTaskSource,id?:string) => (source === "google" ? "/users/@me/lists" : "/me/todo/lists") + (id ? "/"+encodeURIComponent(id) : "");
  function matchingPlans(list: TaskList) {
    return (db.prepare("SELECT * FROM task_plans").all() as Plan[]).filter(plan=>{
      try {const parts=JSON.parse(plan.task_key);return Array.isArray(parts) && parts.length===4 && parts[0]===list.source && parts[1]===list.account_id && parts[2]===list.list_id;}
      catch {return false;}
    });
  }
  async function listCatalog() {
    const results=await Promise.all((["google","microsoft"] as const).map(source=>serial("task-provider:"+source,async()=>{
      const provider=source === "google" ? google : microsoft;
      if (!provider?.connected()) return {lists:[] as TaskList[],accounts:[] as {source:RemoteTaskSource;account_id:string}[],warnings:[] as string[]};
      let account=provider.cachedAccountId();
      try {
        account=await provider.accountId();const lists=await fetchLists(source,account);
        for (const list of lists) saveList(list);
        return {lists,accounts:[{source,account_id:account}],warnings:[]};
      } catch {
        const same=account && provider.connected() && provider.cachedAccountId()===account;
        return {lists:same ? cachedLists(source,account!).map(list=>({...list,stale:true})) : [],accounts:[],warnings:[`${source === "google" ? "Google Tasks" : "Microsoft To Do"} sąrašų atnaujinti nepavyko. Bandyk atnaujinti dar kartą.`]};
      }
    })));
    return {lists:results.flatMap(r=>r.lists),accounts:results.flatMap(r=>r.accounts),warnings:results.flatMap(r=>r.warnings)};
  }
  async function createList(input: Input) {
    const {source,account}=listReference(input),name=listName(input.name);
    const result=await gateway(source).request(listPath(source),{method:"POST",body:JSON.stringify(source === "google" ? {title:name} : {displayName:name})});
    requireAccount(account,source);
    const list=mappedList(result,source,account);saveList(list);return list;
  }
  async function renameList(input: Input) {
    const name=listName(input.name),list=await currentList(input);
    if (!list.can_rename) throw new TaskError(list.management_reason!,403);
    if (input.version !== list.version) throw new TaskError("Sąrašas jau pakeistas. Atnaujink duomenis.",409);
    const result=await gateway(list.source).request(listPath(list.source,list.list_id),{method:"PATCH",
      ...(list.etag ? {headers:{"If-Match":list.etag}} : {}),body:JSON.stringify(list.source === "google" ? {title:name} : {displayName:name})});
    requireAccount(list.account_id,list.source);
    if (result?.id !== list.list_id) throw new TaskError("Paslauga grąžino kitą sąrašą. Atnaujink duomenis.",502);
    const updated=mappedList(result,list.source,list.account_id);
    db.exec("BEGIN IMMEDIATE");
    try {saveList(updated);for (const task of cachedTasks(list.account_id,list.source,list.list_id)) cache({...task,list_name:updated.name});db.exec("COMMIT");}
    catch(error){db.exec("ROLLBACK");throw error;}
    return updated;
  }
  async function previewListDeletion(input: Input) {
    const list=await currentList(input);
    if (!list.can_delete) return {list,task_count:0,confirmation:null,blocked_reason:list.management_reason};
    const path=list.source === "google" ? `/lists/${encodeURIComponent(list.list_id)}/tasks` : `/me/todo/lists/${encodeURIComponent(list.list_id)}/tasks`;
    // Include hidden, completed and assigned Google tasks: deleting a list also
    // deletes Docs/Chat originals, even though normal planning excludes them.
    const raw=await pages(list.source,path,list.source === "google" ? "?maxResults=100&showCompleted=true&showHidden=true&showDeleted=false&showAssigned=true" : "?$top=100");
    requireAccount(list.account_id,list.source);
    const tasks=raw.filter(task=>!task.deleted).sort((a,b)=>identifier(a.id).localeCompare(identifier(b.id)));
    const plans=matchingPlans(list);
    const blocked=tasks.some(task=>task.assignmentInfo) ? "Sąraše yra iš Docs / Chat priskirtų užduočių. Šį sąrašą tvarkyk Google Tasks, nes šalinimas paliestų ir originalus."
      : plans.some(plan=>plan.mirror_requested || plan.mirror_event_id || plan.mirror_transaction_id || plan.mirror_create_payload) ? "Sąrašas turi susietų arba nebaigtų kurti Outlook blokų. Pirmiausia pašalink jų susiejimą užduočių redaktoriuose." : undefined;
    return {list,task_count:tasks.length,confirmation:blocked ? null : fingerprint({version:list.version,tasks}),...(blocked ? {blocked_reason:blocked} : {})};
  }
  async function deleteList(input: Input) {
    if (typeof input.confirmation !== "string" || !input.confirmation || typeof input.confirm_name !== "string") throw new TaskError("Pirmiausia peržiūrėk šalinimą ir įvesk sąrašo pavadinimą.");
    const preview=await previewListDeletion(input),{list}=preview;
    if (preview.blocked_reason) throw new TaskError(preview.blocked_reason,409);
    if (input.confirm_name !== list.name || input.version !== list.version || input.confirmation !== preview.confirmation) throw new TaskError("Sąrašas arba jo užduotys pasikeitė. Peržiūrėk šalinimą iš naujo.",409);
    requireAccount(list.account_id,list.source);
    await gateway(list.source).request(listPath(list.source,list.list_id),{method:"DELETE",...(list.etag ? {headers:{"If-Match":list.etag}} : {})});
    requireAccount(list.account_id,list.source);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const plan of matchingPlans(list)) db.prepare("DELETE FROM task_plans WHERE task_key=?").run(plan.task_key);
      db.prepare("DELETE FROM remote_tasks WHERE source=? AND account_id=? AND list_id=?").run(list.source,list.account_id,list.list_id);
      db.prepare("DELETE FROM remote_task_lists WHERE list_key=?").run(list.key);
      if (list.source === "microsoft") db.prepare("DELETE FROM settings WHERE key='microsoft_task_list_id' AND value=?").run(list.list_id);
      db.exec("COMMIT");
    } catch(error){db.exec("ROLLBACK");throw error;}
  }
  function reminderSnapshot(raw: any, list: TaskList) {
    if (!raw || typeof raw.isReminderOn !== "boolean") throw new TaskError("Nepavyko perskaityti Microsoft priminimo. Atnaujink duomenis.",502);
    const sourceTime = raw.reminderDateTime && typeof raw.reminderDateTime.dateTime === "string" && typeof raw.reminderDateTime.timeZone === "string"
      ? {dateTime:raw.reminderDateTime.dateTime,timeZone:raw.reminderDateTime.timeZone} : null;
    let at: string | null = null;
    if (sourceTime) {
      const explicitOffset = /(Z|[+-]\d{2}:\d{2})$/i.test(sourceTime.dateTime);
      // Never treat an unrecognised provider wall-clock zone as UTC.
      if (explicitOffset || ["UTC","Etc/UTC","Etc/GMT","GMT"].includes(sourceTime.timeZone)) {
        try {at=reminderInstant(sourceTime.dateTime + (explicitOffset ? "" : "Z"));} catch { /* Show the original provider value instead. */ }
      }
    }
    const readonlyReason = !list.writable ? "Šio specialaus sąrašo priminimo keisti negalima."
      : raw.status === "completed" ? "Užbaigtos užduoties priminimą keisk atkūręs užduotį." : undefined;
    return {enabled:raw.isReminderOn,at,source_time:sourceTime,recurring:Boolean(raw.recurrence),
      version:fingerprint({key:remoteKey(list.account_id,list.list_id,identifier(raw.id)),enabled:raw.isReminderOn,time:raw.reminderDateTime ?? null,
        modified:raw.lastModifiedDateTime ?? null,etag:raw["@odata.etag"] ?? null,status:raw.status,recurrence:raw.recurrence ?? null}),
      ...(readonlyReason ? {readonly_reason:readonlyReason} : {})};
  }
  function reminderInstant(value: unknown) {
    if (typeof value !== "string") throw new TaskError("Nurodyk tikslų priminimo laiką su laiko zona.");
    const parts=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(Z|[+-](\d{2}):(\d{2}))$/i.exec(value);
    if (!parts || Number(parts[2])>23 || Number(parts[3])>59 || Number(parts[4])>59 || Number(parts[6]||0)>23 || Number(parts[7]||0)>59)
      throw new TaskError("Nurodyk tikslų priminimo laiką su laiko zona.");
    dateOnly(parts[1]);
    return dateValue(value,true)!;
  }
  async function currentMicrosoftTask(input: Input, feature: "priminimai" | "kartojimas") {
    if (input.source !== "microsoft") throw new TaskError(`${feature === "priminimai" ? "Priminimai palaikomi" : "Kartojimas palaikomas"} tik Microsoft To Do užduotims.`);
    const id=identifier(input.id),list=await currentList(input);
    const path=`/me/todo/lists/${encodeURIComponent(list.list_id)}/tasks/${encodeURIComponent(id)}`;
    const raw=await microsoft.request(path);
    requireAccount(list.account_id);
    if (raw?.id !== id) throw new TaskError("Paslauga grąžino kitą užduotį. Atnaujink duomenis.",502);
    return {raw,list,path};
  }
  async function readReminder(input: Input) {
    const {raw,list}=await currentMicrosoftTask(input,"priminimai");
    return reminderSnapshot(raw,list);
  }
  async function updateReminder(input: Input) {
    if (typeof input.enabled !== "boolean" || typeof input.version !== "string" || !input.version) throw new TaskError("Pirmiausia perskaityk priminimą ir pasirink jo būseną.");
    const at=input.enabled ? reminderInstant(input.at) : null;
    const {raw,list,path}=await currentMicrosoftTask(input,"priminimai"),snapshot=reminderSnapshot(raw,list);
    if (snapshot.readonly_reason) throw new TaskError(snapshot.readonly_reason,403);
    if (input.version !== snapshot.version) throw new TaskError("Microsoft priminimas arba užduotis jau pakeisti. Atnaujink priminimą ir patikrink laiką.",409);
    requireAccount(list.account_id);
    const updated=await microsoft.request(path,{method:"PATCH",
      ...(typeof raw["@odata.etag"] === "string" ? {headers:{"If-Match":raw["@odata.etag"]}} : {}),
      body:JSON.stringify(input.enabled ? {isReminderOn:true,reminderDateTime:{dateTime:at!.replace(/Z$/,""),timeZone:"UTC"}} : {isReminderOn:false})});
    requireAccount(list.account_id);
    if (updated?.id !== raw.id) throw new TaskError("Priminimo rezultato patvirtinti nepavyko. Atnaujink duomenis prieš kartodamas.",502);
    // A reminder never alters the local plan, cached task metadata or Outlook mirror.
    return reminderSnapshot(updated,list);
  }
  function recurrenceSnapshot(raw: any, list: TaskList) {
    const parsed=providerRecurrence(raw?.recurrence),readonlyReason=!list.writable ? "Šio specialaus sąrašo kartojimo keisti negalima."
      : raw?.status === "completed" ? "Užbaigtos užduoties kartojimą keisk atkūręs užduotį."
      : !parsed.supported ? "Šios Microsoft kartojimo taisyklės programėlė negali saugiai pakeisti. Tvarkyk ją Microsoft To Do." : undefined;
    const dueDate=typeof raw?.dueDateTime?.dateTime === "string" ? taskRecurrenceDate(raw.dueDateTime.dateTime.slice(0,10)) : null;
    return {recurrence:parsed.recurrence,supported:parsed.supported,
      suggested_start_date:dueDate,
      version:fingerprint({key:remoteKey(list.account_id,list.list_id,identifier(raw?.id)),task:raw}),
      ...(readonlyReason ? {readonly_reason:readonlyReason} : {})};
  }
  async function readRecurrence(input: Input) {
    const {raw,list}=await currentMicrosoftTask(input,"kartojimas");
    return recurrenceSnapshot(raw,list);
  }
  async function updateRecurrence(input: Input) {
    if (typeof input.version !== "string" || !input.version || input.recurrence === undefined) throw new TaskError("Pirmiausia perskaityk kartojimo taisyklę ir pasirink jos būseną.");
    const desired=input.recurrence === null ? null : parseTaskRecurrence(input.recurrence);
    if (input.recurrence !== null && !desired) throw new TaskError("Neteisinga Microsoft To Do kartojimo taisyklė.");
    const {raw,list,path}=await currentMicrosoftTask(input,"kartojimas"),snapshot=recurrenceSnapshot(raw,list);
    if (snapshot.readonly_reason) throw new TaskError(snapshot.readonly_reason, snapshot.supported ? 403 : 409);
    if (input.version !== snapshot.version) throw new TaskError("Microsoft kartojimo taisyklė arba užduotis jau pakeista. Atnaujink kartojimą.",409);
    requireAccount(list.account_id);
    const updated=await microsoft.request(path,{method:"PATCH",
      ...(typeof raw["@odata.etag"] === "string" ? {headers:{"If-Match":raw["@odata.etag"]}} : {}),
      body:JSON.stringify({recurrence:desired ? graphRecurrence(desired) : null})});
    requireAccount(list.account_id);
    if (updated?.id !== raw.id) throw new TaskError("Kartojimo rezultato patvirtinti nepavyko. Atnaujink duomenis prieš kartodamas.",502);
    const result=recurrenceSnapshot(updated,list);
    if (!result.supported || !sameTaskRecurrence(result.recurrence,desired)) throw new TaskError("Microsoft nepatvirtino pasirinktos kartojimo taisyklės. Atnaujink duomenis prieš kartodamas.",502);
    // Recurrence is provider-owned and never changes local planning or Outlook mirrors.
    return result;
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
        if (source === "google") reconcilePendingMoves(account,staged,warnings);
        for (const task of cachedTasks(account,source)) if (!available.some(list=>list.list_id === task.list_id)) db.prepare("DELETE FROM remote_tasks WHERE task_key=?").run(task.key);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      // Mark orphaned plans for lists that were refreshed successfully:
      // tasks deleted externally will have no matching remote_tasks row.
      const orphanMsg = "Užduotis pašalinta šaltinyje. Outlook blokas gali likti. Atjunk ir prijunk paskyrą, jei blokas neišnyksta.";
      for (const entry of staged) {
        if (!entry.fresh) continue;
        const orphans = (db.prepare("SELECT tp.task_key FROM task_plans tp WHERE tp.task_key NOT IN (SELECT task_key FROM remote_tasks WHERE source=? AND account_id=? AND list_id=?) AND (tp.mirror_event_id IS NOT NULL OR tp.mirror_requested<>0 OR tp.mirror_transaction_id IS NOT NULL)").all(source, account, entry.list.list_id) as {task_key:string}[]).filter(row => {
          try { const parts = JSON.parse(row.task_key); return Array.isArray(parts) && parts.length === 4 && parts[0] === source && parts[1] === account && parts[2] === entry.list.list_id; } catch { return false; }
        });
        for (const orphan of orphans) {
          db.prepare("UPDATE task_plans SET mirror_error=? WHERE task_key=?").run(orphanMsg, orphan.task_key);
        }
      }
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
        if (current.mirror_event_id) {
          try {
            await microsoft.request(`/me/events/${encodeURIComponent(current.mirror_event_id)}`, { method: "DELETE" });
          } catch (e) {
            if (!(e instanceof ProviderError && e.status === 404)) throw e;
          }
        }
        db.prepare("UPDATE task_plans SET mirror_event_id=NULL, mirror_account_id=NULL, mirror_transaction_id=NULL, mirror_create_payload=NULL, mirror_error=NULL WHERE task_key=?").run(task.key);
        return;
      }
      const transactionId = current.mirror_transaction_id || randomUUID();
      db.prepare("UPDATE task_plans SET mirror_account_id=?, mirror_transaction_id=? WHERE task_key=?").run(account, transactionId, task.key);
      const start = new Date(current.scheduled_at);
      const payload = { subject: `✓ ${task.title}`, body: {contentType: "text", content: OUTLOOK_MIRROR_BODY},
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
  async function moveGoogle(input: Input) {
    if (input.source !== "google") throw new TaskError("Tik Google užduotys gali būti perkeltos tarp sąrašų.");
    const account = identifier(input.account_id), sourceListId = identifier(input.list_id);
    const destinationListId = identifier(input.destination_list_id), taskId = identifier(input.id);
    if (sourceListId === destinationListId) throw new TaskError("Pasirink kitą Google Tasks sąrašą.");
    const provider = gateway("google"), currentAccount = await provider.accountId();
    if (account !== currentAccount) throw new TaskError("Paskyra pasikeitė. Atnaujink duomenis.", 409);
    requireAccount(account,"google");
    const current = get({source:"google",account_id:account,list_id:sourceListId,id:taskId});
    if (input.schedule_version !== current.schedule_version) throw new TaskError("Planas jau pakeistas. Atnaujink duomenis ir bandyk dar kartą.", 409);
    const availableLists = await fetchLists("google",account);
    const sourceList=availableLists.find(list=>list.list_id===sourceListId),destination=availableLists.find(list=>list.list_id === destinationListId);
    if (!sourceList) throw new TaskError("Šaltinio sąrašo nebėra. Atnaujink duomenis.",409);
    if (!destination) throw new TaskError("Paskirties sąrašo nebėra. Atnaujink duomenis.",409);
    if (!destination.writable) throw new TaskError("Į pasirinktą sąrašą užduočių perkelti negalima.",403);
    const sourceTasks = await pages("google",`/lists/${encodeURIComponent(sourceListId)}/tasks`,"?maxResults=100&showCompleted=true&showHidden=true&showDeleted=false&showAssigned=false");
    const providerTask = sourceTasks.find(task=>String(task?.id) === taskId);
    if (!providerTask || providerTask.deleted || providerTask.assignmentInfo) throw new TaskError("Google užduoties šiame sąraše nebėra arba jos perkelti negalima. Atnaujink duomenis.",409);
    if (providerTask.parent || sourceTasks.some(task=>String(task?.parent) === taskId)) {
      throw new TaskError("Užduočių su Google hierarchija tarp sąrašų neperkeliame, kad neprarastume tėvinio ryšio.",409);
    }
    requireAccount(account,"google");

    const oldKey = current.key, expectedKey = remoteKey(account,destinationListId,taskId,"google");
    if (db.prepare("SELECT 1 FROM remote_tasks WHERE task_key=?").get(expectedKey) || db.prepare("SELECT 1 FROM task_plans WHERE task_key=?").get(expectedKey)) {
      throw new TaskError("Paskirties sąraše jau yra vietinių duomenų su šia užduoties tapatybe. Atnaujink duomenis.",409);
    }
    const pending: PendingGoogleMove = {setting_key:pendingMoveKey(oldKey),account_id:account,source_list_id:sourceListId,
      destination_list_id:destinationListId,old_task_id:taskId,old_key:oldKey,schedule_version:current.schedule_version,
      moved_id:null};
    if (db.prepare("SELECT 1 FROM settings WHERE key=?").get(pending.setting_key)) throw new TaskError("Ankstesnis šios užduoties perkėlimas dar derinamas. Atnaujink duomenis.",409);
    writePendingMove(pending);
    const params = new URLSearchParams({destinationTasklist:destinationListId});
    const raw = await provider.request(`/lists/${encodeURIComponent(sourceListId)}/tasks/${encodeURIComponent(taskId)}/move?${params}`,{method:"POST"});
    if (!raw || typeof raw !== "object") {
      throw new TaskError("Google perkėlė užduotį, bet negrąžino patvirtintos jos tapatybės. Atnaujink duomenis.",502);
    }
    let movedId: string;
    try { movedId = identifier(raw.id); }
    catch { throw new TaskError("Google perkėlė užduotį, bet grąžino neteisingą jos tapatybę. Atnaujink duomenis.",502); }
    pending.moved_id=movedId;writePendingMove(pending);
    requireAccount(account,"google");
    const confirmed = await provider.request(`/lists/${encodeURIComponent(destinationListId)}/tasks/${encodeURIComponent(movedId)}`);
    requireAccount(account,"google");
    let confirmedId: string | null = null;
    try { confirmedId = confirmed && typeof confirmed === "object" ? identifier(confirmed.id) : null; } catch { /* Invalid provider response. */ }
    if (confirmedId !== movedId) {
      throw new TaskError("Google perkėlimo rezultato paskirties sąraše patvirtinti nepavyko. Atnaujink duomenis.",502);
    }
    const moved = mapped(confirmed,destination), newKey = moved.key;

    db.exec("BEGIN IMMEDIATE");
    try {
      const cached = db.prepare("SELECT 1 FROM remote_tasks WHERE task_key=? AND source='google' AND account_id=? AND list_id=?").get(oldKey,account,sourceListId);
      if (!cached) throw new TaskError("Užduoties vietinė kopija pasikeitė. Atnaujink duomenis.",409);
      if (newKey !== expectedKey && (db.prepare("SELECT 1 FROM remote_tasks WHERE task_key=?").get(newKey) || db.prepare("SELECT 1 FROM task_plans WHERE task_key=?").get(newKey))) {
        throw new TaskError("Paskirties sąrašo duomenys pasikeitė. Atnaujink duomenis.",409);
      }
      applyMoveRows(pending,moved,current.schedule_version);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return decorate(moved);
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
  return { list, listCatalog, readReminder:(input:Input)=>mutation(input,()=>readReminder(input)), updateReminder:(input:Input)=>mutation(input,()=>updateReminder(input)),
    readRecurrence:(input:Input)=>mutation(input,()=>readRecurrence(input)), updateRecurrence:(input:Input)=>mutation(input,()=>updateRecurrence(input)),
    createList:(input:Input)=>mutation(input,()=>createList(input)), renameList:(input:Input)=>mutation(input,()=>renameList(input)),
    previewListDeletion:(input:Input)=>mutation(input,()=>previewListDeletion(input)), deleteList:(input:Input)=>mutation(input,()=>deleteList(input)),
    create:(input:Input)=>mutation(input,()=>create(input)), update:(input:Input)=>mutation(input,()=>update(input)),
    moveGoogle:(input:Input)=>mutation(input,()=>moveGoogle(input)), remove:(input:Input)=>mutation(input,()=>remove(input)) };
}
