import type {CalendarEvent} from "./calendar-events.ts";
import type {Task} from "./task-service.ts";

export const OFFLINE_PLAN_DB = "dienos-planas-offline";
export const OFFLINE_PLAN_DB_VERSION = 1;
export const OFFLINE_PLAN_SNAPSHOT_STORE = "snapshots";
export const OFFLINE_PLAN_META_STORE = "meta";
export const OFFLINE_PLAN_ACTIVE_USER_KEY = "active-user";
export const OFFLINE_PLAN_TTL_MS = 48 * 60 * 60 * 1000;

export type OfflineDayItem = {
  kind:"event"|"task";
  title:string;
  allDay:boolean;
  start?:string;
  end?:string;
  source:string;
  provider:"google"|"outlook"|"local"|"microsoft";
};

export type OfflineDaySnapshot = {
  version:1;
  userKey:string;
  day:string;
  capturedAt:number;
  expiresAt:number;
  items:OfflineDayItem[];
};

function localDay(value:Date) {
  const year=value.getFullYear(),month=String(value.getMonth()+1).padStart(2,"0"),day=String(value.getDate()).padStart(2,"0");
  return `${year}-${month}-${day}`;
}

function dayRange(day:string) {
  const start=new Date(`${day}T00:00:00`),end=new Date(start);end.setDate(end.getDate()+1);
  return {start,end};
}

function overlapsDay(start:Date,end:Date,day:string) {
  const range=dayRange(day);
  return Number.isFinite(start.getTime())&&Number.isFinite(end.getTime())&&start<range.end&&end>range.start;
}

function eventTouchesDay(event:CalendarEvent,day:string) {
  if(event.allDay)return Boolean(event.start.date&&event.end.date&&event.start.date<=day&&event.end.date>day);
  return overlapsDay(new Date(event.start.dateTime||""),new Date(event.end.dateTime||""),day);
}

function taskTouchesDay(task:Task,day:string) {
  if(task.completed)return false;
  if(task.scheduled_at){const start=new Date(task.scheduled_at);return overlapsDay(start,new Date(start.getTime()+task.duration_minutes*60_000),day);}
  return task.due_date===day;
}

function taskSource(task:Task) {
  const provider=task.source==="google"?"Google Tasks":task.source==="microsoft"?"Microsoft To Do":"Vietinė užduotis";
  return task.list_name?`${provider} · ${task.list_name}`:provider;
}

export function buildOfflineDaySnapshot({userId,day,tasks,events,now=Date.now(),ttlMs=OFFLINE_PLAN_TTL_MS}:{userId:number;day:string;tasks:Task[];events:CalendarEvent[];now?:number;ttlMs?:number}):OfflineDaySnapshot {
  if(!Number.isSafeInteger(userId)||userId<1)throw new Error("Neteisingas naudotojo ID.");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||localDay(new Date(`${day}T12:00:00`))!==day)throw new Error("Neteisinga diena.");
  const eventItems=events.filter(event=>eventTouchesDay(event,day)).map<OfflineDayItem>(event=>({
    kind:"event",title:event.summary||"Įvykis",allDay:event.allDay,
    ...(event.start.dateTime?{start:event.start.dateTime}:{}),...(event.end.dateTime?{end:event.end.dateTime}:{}),
    source:[event.accountLabel||event.accountEmail,event.calendarName||event.calendarId].filter(Boolean).join(" · ")||(event.provider==="outlook"?"Microsoft / Outlook":"Google Calendar"),
    provider:event.provider,
  }));
  const taskItems=tasks.filter(task=>taskTouchesDay(task,day)).map<OfflineDayItem>(task=>({
    kind:"task",title:task.title,allDay:!task.scheduled_at,
    ...(task.scheduled_at?{start:task.scheduled_at,end:new Date(Date.parse(task.scheduled_at)+task.duration_minutes*60_000).toISOString()}:{}),
    source:taskSource(task),provider:task.source,
  }));
  const items=[...eventItems,...taskItems].sort((a,b)=>Number(b.allDay)-Number(a.allDay)||(a.start||"").localeCompare(b.start||"")||a.title.localeCompare(b.title,"lt"));
  return {version:1,userKey:`user:${userId}`,day,capturedAt:now,expiresAt:now+ttlMs,items};
}

function openOfflineDb() {
  if(typeof indexedDB==="undefined")return Promise.reject(new Error("IndexedDB nepalaikomas."));
  return new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open(OFFLINE_PLAN_DB,OFFLINE_PLAN_DB_VERSION);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains(OFFLINE_PLAN_SNAPSHOT_STORE))db.createObjectStore(OFFLINE_PLAN_SNAPSHOT_STORE,{keyPath:"userKey"});
      if(!db.objectStoreNames.contains(OFFLINE_PLAN_META_STORE))db.createObjectStore(OFFLINE_PLAN_META_STORE,{keyPath:"key"});
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error||new Error("Offline saugyklos atverti nepavyko."));
  });
}

function transactionDone(transaction:IDBTransaction) {
  return new Promise<void>((resolve,reject)=>{
    transaction.oncomplete=()=>resolve();
    transaction.onerror=()=>reject(transaction.error||new Error("Offline saugyklos operacija nepavyko."));
    transaction.onabort=()=>reject(transaction.error||new Error("Offline saugyklos operacija nutraukta."));
  });
}

export async function saveOfflineDayPlan(snapshot:OfflineDaySnapshot) {
  const db=await openOfflineDb();
  try {
    const transaction=db.transaction([OFFLINE_PLAN_SNAPSHOT_STORE,OFFLINE_PLAN_META_STORE],"readwrite");
    const snapshots=transaction.objectStore(OFFLINE_PLAN_SNAPSHOT_STORE);
    snapshots.clear();
    snapshots.put(snapshot);
    transaction.objectStore(OFFLINE_PLAN_META_STORE).put({key:OFFLINE_PLAN_ACTIVE_USER_KEY,value:snapshot.userKey});
    await transactionDone(transaction);
  } finally {db.close();}
}

export async function ensureOfflineDayPlanUser(userId:number) {
  if(!Number.isSafeInteger(userId)||userId<1)throw new Error("Neteisingas naudotojo ID.");
  const db=await openOfflineDb();
  try {
    const transaction=db.transaction([OFFLINE_PLAN_SNAPSHOT_STORE,OFFLINE_PLAN_META_STORE],"readwrite");
    const snapshots=transaction.objectStore(OFFLINE_PLAN_SNAPSHOT_STORE),meta=transaction.objectStore(OFFLINE_PLAN_META_STORE);
    const request=meta.get(OFFLINE_PLAN_ACTIVE_USER_KEY),expected=`user:${userId}`;
    request.onsuccess=()=>{
      if(request.result?.value===expected)return;
      snapshots.clear();
      meta.clear();
    };
    await transactionDone(transaction);
  } finally {db.close();}
}

export async function clearOfflineDayPlans() {
  if(typeof indexedDB==="undefined")return;
  const db=await openOfflineDb();
  try {
    const transaction=db.transaction([OFFLINE_PLAN_SNAPSHOT_STORE,OFFLINE_PLAN_META_STORE],"readwrite");
    transaction.objectStore(OFFLINE_PLAN_SNAPSHOT_STORE).clear();
    transaction.objectStore(OFFLINE_PLAN_META_STORE).clear();
    await transactionDone(transaction);
  } finally {db.close();}
}
