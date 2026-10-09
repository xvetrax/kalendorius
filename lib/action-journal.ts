import {randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import type {CalendarEvent,CalendarProvider} from "./calendar-events.ts";
import type {RemoteTaskSource,Task} from "./task-service.ts";
import type {TaskStartNotificationHooks} from "./notification-jobs.ts";

export const ACTION_UNDO_TTL_MS=15_000;
export const ACTION_RETENTION_MS=7*24*60*60*1000;
const ACTION_HISTORY_LIMIT=50;

export type ActionType=
  |"local_task_created"|"local_task_completed"|"local_task_planned"|"local_task_moved"|"local_task_resized"|"local_task_unplanned"
  |"provider_task_planned"|"provider_task_moved"|"provider_task_resized"|"provider_task_unplanned"
  |"provider_event_moved"|"provider_event_resized";
export type ActionStatus="available"|"applying"|"undone"|"conflict"|"expired";
export type ActionSummary={operationId:string;actionType:ActionType;label:string;createdAt:string;undoExpiresAt:string;status:ActionStatus;canUndo:boolean};

type TaskState={id:number;key:string;title:string;completed:number;duration_minutes:number};
type PlanState={scheduled_at:string|null;duration_minutes:number;schedule_version:number;legacy_schedule:number;mirror_requested:number;mirror_event_id:string|null;mirror_account_id:string|null;mirror_connection_id:number|null;mirror_transaction_pending:number;mirror_create_pending:number};
export type LocalTaskSnapshot={task:TaskState;plan:PlanState};
export type ProviderTaskSnapshot={kind:"provider_task";provider:RemoteTaskSource;id:string;key:string;title:string;accountId:string;connectionId:number;listId:string;plan:PlanState};
export type ProviderEventSnapshot={kind:"provider_event";provider:CalendarProvider;id:string;key:string;title:string;accountId:string;connectionId:string;calendarId:string;version:string;allDay:boolean;start:{dateTime?:string;date?:string};end:{dateTime?:string;date?:string};timeZone?:string};
type TaskActionSnapshot=LocalTaskSnapshot|ProviderTaskSnapshot;
type JournalRow={operation_id:string;action_type:ActionType;entity_type:string;entity_key:string;label:string;before_json:string|null;after_json:string;status:"available"|"applying"|"undone"|"conflict";undo_expires_at:string;retained_until:string;created_at:string;applied_at:string|null};

export type ProviderUndoHooks={
  readEvent(snapshot:ProviderEventSnapshot):Promise<ProviderEventSnapshot|null>;
  restoreEvent(current:ProviderEventSnapshot,target:ProviderEventSnapshot):Promise<ProviderEventSnapshot>;
};

export class ActionJournalError extends Error {status:number;constructor(message:string,status=400){super(message);this.status=status;}}
function nowIso(now:()=>Date){return now().toISOString();}
function plusIso(now:Date,milliseconds:number){return new Date(now.getTime()+milliseconds).toISOString();}
function same(left:unknown,right:unknown){return JSON.stringify(left)===JSON.stringify(right);}
function defaultPlan(durationMinutes:number):PlanState{return {scheduled_at:null,duration_minutes:durationMinutes,schedule_version:0,legacy_schedule:0,mirror_requested:0,mirror_event_id:null,mirror_account_id:null,mirror_connection_id:null,mirror_transaction_pending:0,mirror_create_pending:0};}
function planSnapshot(db:DatabaseSync,userId:number,key:string,durationMinutes:number):PlanState {
  return (db.prepare(`SELECT scheduled_at,duration_minutes,schedule_version,legacy_schedule,mirror_requested,mirror_event_id,mirror_account_id,mirror_connection_id,
    CASE WHEN mirror_transaction_id IS NULL THEN 0 ELSE 1 END AS mirror_transaction_pending,
    CASE WHEN mirror_create_payload IS NULL THEN 0 ELSE 1 END AS mirror_create_pending
    FROM task_plans WHERE task_key=? AND user_id=?`).get(key,userId) as PlanState|undefined)??defaultPlan(durationMinutes);
}
function localSnapshot(db:DatabaseSync,userId:number,taskId:number):LocalTaskSnapshot|null {
  const row=db.prepare("SELECT id,title,completed,duration_minutes FROM tasks WHERE id=? AND user_id=?").get(taskId,userId) as Omit<TaskState,"key">|undefined;
  if(!row)return null;const key=`local:${taskId}`;return {task:{...row,key},plan:planSnapshot(db,userId,key,row.duration_minutes)};
}
function providerTaskSnapshot(db:DatabaseSync,userId:number,task:Task):ProviderTaskSnapshot|null {
  if((task.source!=="google"&&task.source!=="microsoft")||!task.account_id||!task.list_id||!Number.isSafeInteger(task.connection_id)||Number(task.connection_id)<=0)return null;
  return {kind:"provider_task",provider:task.source,id:String(task.id),key:task.key,title:task.title,accountId:task.account_id,connectionId:Number(task.connection_id),listId:task.list_id,plan:planSnapshot(db,userId,task.key,task.duration_minutes)};
}
function currentProviderTaskSnapshot(db:DatabaseSync,userId:number,expected:ProviderTaskSnapshot):ProviderTaskSnapshot|null {
  const row=db.prepare("SELECT task_json FROM remote_tasks WHERE user_id=? AND task_key=? AND source=? AND account_id=? AND list_id=?").get(userId,expected.key,expected.provider,expected.accountId,expected.listId) as {task_json:string}|undefined;
  if(!row)return null;try{return providerTaskSnapshot(db,userId,JSON.parse(row.task_json) as Task);}catch{return null;}
}
function sameProviderTaskPlan(actual:ProviderTaskSnapshot,expected:ProviderTaskSnapshot){
  return actual.provider===expected.provider&&actual.id===expected.id&&actual.key===expected.key&&actual.accountId===expected.accountId&&actual.connectionId===expected.connectionId&&actual.listId===expected.listId&&same(actual.plan,expected.plan);
}
function validateLocalSnapshot(value:unknown):LocalTaskSnapshot {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new ActionJournalError("Veiksmo istorijos įrašas sugadintas.",409);
  const candidate=value as LocalTaskSnapshot;
  if(!candidate.task||!candidate.plan||!Number.isSafeInteger(candidate.task.id)||candidate.task.id<1||candidate.task.key!==`local:${candidate.task.id}`||typeof candidate.task.title!=="string"||typeof candidate.plan.schedule_version!=="number")throw new ActionJournalError("Veiksmo istorijos įrašas sugadintas.",409);
  return candidate;
}
function validateProviderTaskSnapshot(value:unknown):ProviderTaskSnapshot {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new ActionJournalError("Veiksmo istorijos įrašas sugadintas.",409);
  const item=value as ProviderTaskSnapshot;
  if(item.kind!=="provider_task"||(item.provider!=="google"&&item.provider!=="microsoft")||typeof item.id!=="string"||!item.id||typeof item.key!=="string"||!item.key||typeof item.title!=="string"||typeof item.accountId!=="string"||!item.accountId||!Number.isSafeInteger(item.connectionId)||item.connectionId<=0||typeof item.listId!=="string"||!item.listId||!item.plan||typeof item.plan.schedule_version!=="number")throw new ActionJournalError("Veiksmo istorijos įrašas sugadintas.",409);
  return item;
}
function validBoundary(value:{dateTime?:string;date?:string}){return (typeof value.dateTime==="string"&&Number.isFinite(Date.parse(value.dateTime)))||(typeof value.date==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(value.date));}
export function providerEventSnapshot(event:CalendarEvent):ProviderEventSnapshot{return {kind:"provider_event",provider:event.provider,id:event.id,key:event.key,title:event.summary,accountId:event.providerAccountId||"",connectionId:event.connectionId,calendarId:event.calendarId,version:event.conditionalVersion||"",allDay:event.allDay,start:{...event.start},end:{...event.end},...(event.timeZone?{timeZone:event.timeZone}:{})};}
function validateProviderEventSnapshot(value:unknown):ProviderEventSnapshot {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new ActionJournalError("Veiksmo istorijos įrašas sugadintas.",409);
  const item=value as ProviderEventSnapshot;
  if(item.kind!=="provider_event"||(item.provider!=="google"&&item.provider!=="outlook")||typeof item.id!=="string"||!item.id||typeof item.key!=="string"||!item.key||typeof item.title!=="string"||typeof item.accountId!=="string"||!item.accountId||typeof item.connectionId!=="string"||!item.connectionId||typeof item.calendarId!=="string"||!item.calendarId||typeof item.version!=="string"||!item.version||typeof item.allDay!=="boolean"||!item.start||!item.end||!validBoundary(item.start)||!validBoundary(item.end))throw new ActionJournalError("Veiksmo istorijos įrašas sugadintas.",409);
  return item;
}
function parseJson(value:string|null){if(value===null)return null;try{return JSON.parse(value) as unknown;}catch{throw new ActionJournalError("Veiksmo istorijos įrašas sugadintas.",409);}}
function prune(db:DatabaseSync,userId:number,now:string){db.prepare("DELETE FROM action_journal WHERE user_id=? AND status<>'applying' AND retained_until<=?").run(userId,now);db.prepare("DELETE FROM action_journal WHERE user_id=? AND status<>'applying' AND id NOT IN (SELECT id FROM action_journal WHERE user_id=? AND status<>'applying' ORDER BY id DESC LIMIT ?)").run(userId,userId,ACTION_HISTORY_LIMIT);}
function publicSummary(row:JournalRow,now:string):ActionSummary {const expired=row.undo_expires_at<=now,status:ActionStatus=row.status==="conflict"||row.status==="undone"||row.status==="applying"?row.status:expired?"expired":"available";return {operationId:row.operation_id,actionType:row.action_type,label:row.label,createdAt:row.created_at,undoExpiresAt:row.undo_expires_at,status,canUndo:row.status==="applying"||(row.status==="available"&&!expired)};}
function insertRecord(db:DatabaseSync,userId:number,now:()=>Date,type:ActionType,entityType:string,entityKey:string,label:string,before:unknown|null,after:unknown){
  const instant=now(),operationId=randomUUID(),createdAt=instant.toISOString(),undoExpiresAt=plusIso(instant,ACTION_UNDO_TTL_MS),retainedUntil=plusIso(instant,ACTION_RETENTION_MS);
  db.prepare("INSERT INTO action_journal(user_id,operation_id,action_type,entity_type,entity_key,label,before_json,after_json,status,undo_expires_at,retained_until,created_at) VALUES(?,?,?,?,?,?,?,?, 'available',?,?,?)").run(userId,operationId,type,entityType,entityKey,label,before===null?null:JSON.stringify(before),JSON.stringify(after),undoExpiresAt,retainedUntil,createdAt);
  prune(db,userId,createdAt);return {operationId,actionType:type,label,createdAt,undoExpiresAt,status:"available" as const,canUndo:true};
}
function taskActionDetails(prefix:"local_task"|"provider_task",title:string,before:PlanState,after:PlanState,input:Record<string,unknown>):{type:ActionType;label:string}|null {
  const identityFields=new Set(["id","source","account_id","connection_id","list_id","schedule_version","mirror_requested","mirror_account_id","mirror_connection_id"]),changedFields=Object.keys(input).filter(key=>!identityFields.has(key));
  if(!(input.scheduled_at!==undefined||input.duration_minutes!==undefined)||changedFields.some(key=>key!=="scheduled_at"&&key!=="duration_minutes"))return null;
  if(!before.scheduled_at&&after.scheduled_at)return {type:`${prefix}_planned` as ActionType,label:`Suplanuota užduotis „${title}“`};
  if(before.scheduled_at&&!after.scheduled_at)return {type:`${prefix}_unplanned` as ActionType,label:`Išplanuota užduotis „${title}“`};
  if(before.scheduled_at===after.scheduled_at&&before.duration_minutes!==after.duration_minutes)return {type:`${prefix}_resized` as ActionType,label:`Pakeista užduoties „${title}“ trukmė`};
  if(before.scheduled_at!==after.scheduled_at)return {type:`${prefix}_moved` as ActionType,label:`Perkelta užduotis „${title}“`};return null;
}
function mirrored(plan:PlanState){return Boolean(plan.mirror_requested||plan.mirror_event_id||plan.mirror_transaction_pending||plan.mirror_create_pending);}

export type ActionJournalHooks={capture(task:Task):TaskActionSnapshot|null;recordCreated(task:Task):ActionSummary|undefined;recordUpdated(before:TaskActionSnapshot|null,after:Task,input:Record<string,unknown>):ActionSummary|undefined};
export function createActionJournalHooks(db:DatabaseSync,userId:number,{now=()=>new Date()}:{now?:()=>Date}={}):ActionJournalHooks {
  return {
    capture(task){return task.source==="local"?localSnapshot(db,userId,Number(task.id)):providerTaskSnapshot(db,userId,task);},
    recordCreated(task){if(task.source!=="local")return undefined;const after=localSnapshot(db,userId,Number(task.id));return after?insertRecord(db,userId,now,"local_task_created","local_task",after.task.key,`Sukurta užduotis „${after.task.title}“`,null,after):undefined;},
    recordUpdated(before,after,input){
      if(!before)return undefined;
      if(after.source==="local"&&!("kind" in before)){
        const current=localSnapshot(db,userId,Number(after.id));if(!current||mirrored(before.plan)||mirrored(current.plan))return undefined;
        const changed=Object.keys(input).filter(key=>!["id","source","schedule_version"].includes(key));
        if(before.task.completed===0&&current.task.completed===1&&changed.every(key=>key==="completed"))return insertRecord(db,userId,now,"local_task_completed","local_task",current.task.key,`Užbaigta užduotis „${current.task.title}“`,before,current);
        if(before.task.completed!==current.task.completed||before.task.completed||current.task.completed)return undefined;
        const details=taskActionDetails("local_task",current.task.title,before.plan,current.plan,input);return details?insertRecord(db,userId,now,details.type,"local_task",current.task.key,details.label,before,current):undefined;
      }
      if((after.source==="google"||after.source==="microsoft")&&"kind" in before&&before.kind==="provider_task"){
        const current=providerTaskSnapshot(db,userId,after);if(!current||mirrored(before.plan)||mirrored(current.plan)||before.key!==current.key)return undefined;
        const details=taskActionDetails("provider_task",current.title,before.plan,current.plan,input);return details?insertRecord(db,userId,now,details.type,"provider_task",current.key,details.label,before,current):undefined;
      }
      return undefined;
    },
  };
}

function eventDuration(snapshot:ProviderEventSnapshot){return snapshot.allDay?Date.parse(`${snapshot.end.date}T00:00:00Z`)-Date.parse(`${snapshot.start.date}T00:00:00Z`):Date.parse(snapshot.end.dateTime!)-Date.parse(snapshot.start.dateTime!);}
function sameEventTime(left:ProviderEventSnapshot,right:ProviderEventSnapshot){return left.allDay===right.allDay&&same(left.start,right.start)&&same(left.end,right.end)&&(left.allDay||left.timeZone===right.timeZone);}
export function createCalendarActionJournalHooks(db:DatabaseSync,userId:number,{now=()=>new Date()}:{now?:()=>Date}={}){return {recordUpdated(before:CalendarEvent,after:CalendarEvent,input:Record<string,unknown>):ActionSummary|undefined{
  const allowed=new Set(["id","calendarId","connectionId","version","start","end","allDay","timeZone","confirmAttendees"]);
  if(Object.keys(input).some(key=>!allowed.has(key))||before.key!==after.key||!before.editable||!after.editable||before.recurring||after.recurring||Boolean(before.mirrorTaskKey)||Boolean(after.mirrorTaskKey)||before.attendeeCount!==0||after.attendeeCount!==0||before.allDay!==after.allDay||!before.conditionalVersion||!after.conditionalVersion||before.conditionalVersion===after.conditionalVersion||!before.providerAccountId||before.providerAccountId!==after.providerAccountId)return undefined;
  const previous=providerEventSnapshot(before),current=providerEventSnapshot(after);if(sameEventTime(previous,current))return undefined;
  const resized=eventDuration(previous)!==eventDuration(current),type:ActionType=resized?"provider_event_resized":"provider_event_moved",label=resized?`Pakeista įvykio „${after.summary}“ trukmė`:`Perkeltas įvykis „${after.summary}“`;
  return insertRecord(db,userId,now,type,"provider_event",current.key,label,previous,current);
}};}

function validOperationId(value:unknown){if(typeof value!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw new ActionJournalError("Neteisingas operacijos ID.");return value;}
const rowColumns="operation_id,action_type,entity_type,entity_key,label,before_json,after_json,status,undo_expires_at,retained_until,created_at,applied_at";
export function createActionJournalService(db:DatabaseSync,userId:number,notifications:TaskStartNotificationHooks,{now=()=>new Date(),providers}:{now?:()=>Date;providers?:ProviderUndoHooks}={}) {
  function row(id:string){return db.prepare(`SELECT ${rowColumns} FROM action_journal WHERE user_id=? AND operation_id=?`).get(userId,id) as JournalRow|undefined;}
  function list():ActionSummary[]{const current=nowIso(now);prune(db,userId,current);return (db.prepare(`SELECT ${rowColumns} FROM action_journal WHERE user_id=? AND (status='applying' OR id IN (SELECT id FROM action_journal WHERE user_id=? AND status<>'applying' ORDER BY id DESC LIMIT 20)) ORDER BY id DESC`).all(userId,userId) as JournalRow[]).map(item=>publicSummary(item,current));}
  function available(item:JournalRow,currentTime:string){if(item.status==="undone")return "undone" as const;if(item.status!=="available")throw new ActionJournalError("Veiksmo nebegalima saugiai atšaukti. Atnaujink duomenis.",409);if(item.undo_expires_at<=currentTime)throw new ActionJournalError("Laikas veiksmui atšaukti baigėsi.",410);return "available" as const;}
  function conflict(id:string,message:string):never {const time=nowIso(now);db.prepare("UPDATE action_journal SET status='conflict',applied_at=? WHERE user_id=? AND operation_id=? AND status IN ('available','applying')").run(time,userId,id);throw new ActionJournalError(message,409);}
  function finish(item:JournalRow,currentTime:string,alreadyUndone=false){if(!alreadyUndone){const changed=db.prepare("UPDATE action_journal SET status='undone',applied_at=? WHERE user_id=? AND operation_id=? AND status IN ('available','applying')").run(currentTime,userId,item.operation_id);if(changed.changes!==1){const latest=row(item.operation_id);if(latest?.status!=="undone")throw new ActionJournalError("Veiksmas jau apdorotas. Atnaujink istoriją.",409);alreadyUndone=true;}}return {action:publicSummary({...item,status:"undone",applied_at:currentTime},currentTime),alreadyUndone};}
  function claimProviderEvent(item:JournalRow){
    const currentTime=nowIso(now);db.exec("BEGIN IMMEDIATE");
    try{
      const locked=row(item.operation_id);if(!locked)throw new ActionJournalError("Veiksmo istorijos įrašas nerastas.",404);
      if(locked.status==="undone"){db.exec("COMMIT");return {item:locked,alreadyUndone:true};}
      if(locked.status==="conflict")throw new ActionJournalError("Veiksmo nebegalima saugiai atšaukti. Atnaujink duomenis.",409);
      if(locked.status==="available"){
        if(locked.undo_expires_at<=currentTime)throw new ActionJournalError("Laikas veiksmui atšaukti baigėsi.",410);
        const changed=db.prepare("UPDATE action_journal SET status='applying' WHERE user_id=? AND operation_id=? AND status='available'").run(userId,locked.operation_id);
        if(changed.changes!==1)throw new ActionJournalError("Veiksmas jau apdorojamas. Bandyk dar kartą.",409);
      }
      db.exec("COMMIT");return {item:{...locked,status:"applying" as const},alreadyUndone:false};
    }catch(error){try{db.exec("ROLLBACK");}catch{}throw error;}
  }
  function restorePlan(beforeSnapshot:LocalTaskSnapshot|ProviderTaskSnapshot,afterSnapshot:LocalTaskSnapshot|ProviderTaskSnapshot){
    const key="kind" in afterSnapshot?afterSnapshot.key:afterSnapshot.task.key,before=beforeSnapshot.plan,after=afterSnapshot.plan,nextVersion=after.schedule_version+1;
    const restored=db.prepare("UPDATE task_plans SET scheduled_at=?,duration_minutes=?,schedule_version=?,legacy_schedule=? WHERE user_id=? AND task_key=? AND schedule_version=?").run(before.scheduled_at,before.duration_minutes,nextVersion,before.legacy_schedule,userId,key,after.schedule_version);
    if(restored.changes!==1)throw new ActionJournalError("Užduotis jau pasikeitė. Atšaukimas nepritaikytas — atnaujink duomenis.",409);
    notifications.sync(key,"kind" in beforeSnapshot?before.scheduled_at:beforeSnapshot.task.completed?null:before.scheduled_at,nextVersion);
  }
  function undoLocal(item:JournalRow){
    const currentTime=nowIso(now);db.exec("BEGIN IMMEDIATE");
    try{
      prune(db,userId,currentTime);const locked=row(item.operation_id);if(!locked)throw new ActionJournalError("Veiksmo istorijos įrašas nerastas.",404);
      if(available(locked,currentTime)==="undone"){db.exec("COMMIT");return finish(locked,currentTime,true);}
      const beforeValue=parseJson(locked.before_json),before=beforeValue===null?null:validateLocalSnapshot(beforeValue),after=validateLocalSnapshot(parseJson(locked.after_json)),actual=localSnapshot(db,userId,after.task.id);
      if(!actual||!same(actual,after)){db.prepare("UPDATE action_journal SET status='conflict',applied_at=? WHERE user_id=? AND operation_id=? AND status='available'").run(currentTime,userId,locked.operation_id);db.exec("COMMIT");throw new ActionJournalError("Užduotis jau pasikeitė. Atšaukimas nepritaikytas — atnaujink duomenis.",409);}
      if(locked.action_type==="local_task_created"){notifications.cancel(after.task.key);db.prepare("DELETE FROM task_plans WHERE user_id=? AND task_key=?").run(userId,after.task.key);db.prepare("DELETE FROM tasks WHERE user_id=? AND id=?").run(userId,after.task.id);}
      else{if(!before)throw new ActionJournalError("Veiksmo istorijos įrašas sugadintas.",409);db.prepare("UPDATE tasks SET completed=?,duration_minutes=? WHERE user_id=? AND id=?").run(before.task.completed,before.task.duration_minutes,userId,before.task.id);restorePlan(before,after);}
      const result=finish(locked,currentTime);db.exec("COMMIT");return result;
    }catch(error){try{db.exec("ROLLBACK");}catch{}throw error;}
  }
  function undoProviderTask(item:JournalRow){
    const before=validateProviderTaskSnapshot(parseJson(item.before_json)),after=validateProviderTaskSnapshot(parseJson(item.after_json));
    db.exec("BEGIN IMMEDIATE");
    try{
      const currentTime=nowIso(now),locked=row(item.operation_id);if(!locked)throw new ActionJournalError("Veiksmo istorijos įrašas nerastas.",404);
      if(available(locked,currentTime)==="undone"){db.exec("COMMIT");return finish(locked,currentTime,true);}
      const actual=currentProviderTaskSnapshot(db,userId,after);if(!actual||!sameProviderTaskPlan(actual,after)){db.prepare("UPDATE action_journal SET status='conflict',applied_at=? WHERE user_id=? AND operation_id=? AND status='available'").run(currentTime,userId,locked.operation_id);db.exec("COMMIT");throw new ActionJournalError("Užduoties planas jau pasikeitė. Atšaukimas nepritaikytas — atnaujink duomenis.",409);}
      restorePlan(before,after);const result=finish(locked,nowIso(now));db.exec("COMMIT");return result;
    }catch(error){try{db.exec("ROLLBACK");}catch{}throw error;}
  }
  async function undoProviderEvent(item:JournalRow){
    if(!providers)throw new ActionJournalError("Tiekėjo atšaukimas šiame serveryje nepasiekiamas.",503);
    const before=validateProviderEventSnapshot(parseJson(item.before_json)),after=validateProviderEventSnapshot(parseJson(item.after_json));
    const claimed=claimProviderEvent(item);if(claimed.alreadyUndone)return finish(claimed.item,nowIso(now),true);
    let live:ProviderEventSnapshot|null;
    try{live=await providers.readEvent(after);}catch(error){if(error instanceof ActionJournalError&&error.status===409)return conflict(item.operation_id,error.message);throw error;}
    if(!live)return conflict(item.operation_id,"Įvykio nebėra Google arba Microsoft kalendoriuje.");
    const sameIdentity=(value:ProviderEventSnapshot)=>value.provider===after.provider&&value.id===after.id&&value.key===after.key&&value.accountId===after.accountId&&value.connectionId===after.connectionId&&value.calendarId===after.calendarId&&value.allDay===after.allDay;
    if(!sameIdentity(live))return conflict(item.operation_id,"Įvykio paskyra arba kalendorius pasikeitė. Atšaukimas nepritaikytas.");
    if(!sameEventTime(live,before)){
      if(!sameEventTime(live,after)||live.version!==after.version)return conflict(item.operation_id,"Įvykis jau pakeistas kitur. Atšaukimas nepritaikytas — atnaujink kalendorių.");
      try{
        const restored=await providers.restoreEvent(live,before);
        if(!sameIdentity(restored)||!sameEventTime(restored,before)||restored.version===live.version)return conflict(item.operation_id,"Tiekėjas nepatvirtino įvykio atstatymo. Atnaujink kalendorių.");
        live=restored;
      }catch(error){
        let reread:ProviderEventSnapshot|null|undefined;
        try{reread=await providers.readEvent(after);}catch(readError){if(readError instanceof ActionJournalError&&readError.status===409)return conflict(item.operation_id,readError.message);reread=undefined;}
        if(reread===null)return conflict(item.operation_id,"Įvykio nebėra Google arba Microsoft kalendoriuje.");
        if(reread&&sameIdentity(reread)&&sameEventTime(reread,before))live=reread;
        else if(reread&&(!sameIdentity(reread)||!sameEventTime(reread,after)||reread.version!==after.version))return conflict(item.operation_id,"Įvykis jau pakeistas kitur. Atšaukimas nepritaikytas — atnaujink kalendorių.");
        else throw error;
      }
    }
    const latest=row(item.operation_id);if(!latest)throw new ActionJournalError("Veiksmo istorijos įrašas nerastas.",404);if(latest.status==="undone")return finish(latest,nowIso(now),true);if(latest.status!=="applying")throw new ActionJournalError("Veiksmo nebegalima saugiai atšaukti. Atnaujink duomenis.",409);return finish(latest,nowIso(now));
  }
  function undo(value:unknown){const id=validOperationId(value),currentTime=nowIso(now);prune(db,userId,currentTime);const item=row(id);if(!item)throw new ActionJournalError("Veiksmo istorijos įrašas nerastas.",404);if(item.entity_type==="local_task")return undoLocal(item);if(item.entity_type==="provider_task")return undoProviderTask(item);if(item.entity_type==="provider_event")return undoProviderEvent(item);throw new ActionJournalError("Veiksmo istorijos įrašas sugadintas.",409);}
  return {list,undo};
}
