import {randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import type {Task} from "./task-service.ts";
import type {TaskStartNotificationHooks} from "./notification-jobs.ts";

export const ACTION_UNDO_TTL_MS=15_000;
export const ACTION_RETENTION_MS=7*24*60*60*1000;
const ACTION_HISTORY_LIMIT=50;

export type ActionType="local_task_created"|"local_task_completed"|"local_task_planned"|"local_task_moved"|"local_task_resized"|"local_task_unplanned";
export type ActionStatus="available"|"undone"|"conflict"|"expired";
export type ActionSummary={
  operationId:string;actionType:ActionType;label:string;createdAt:string;undoExpiresAt:string;
  status:ActionStatus;canUndo:boolean;
};

type TaskState={
  id:number;key:string;title:string;completed:number;duration_minutes:number;
};
type PlanState={
  scheduled_at:string|null;duration_minutes:number;schedule_version:number;legacy_schedule:number;
  mirror_requested:number;mirror_event_id:string|null;mirror_account_id:string|null;
  mirror_connection_id:number|null;mirror_transaction_pending:number;mirror_create_pending:number;
};
export type LocalTaskSnapshot={task:TaskState;plan:PlanState};

type JournalRow={
  operation_id:string;action_type:ActionType;label:string;before_json:string|null;after_json:string;
  status:"available"|"undone"|"conflict";undo_expires_at:string;retained_until:string;created_at:string;applied_at:string|null;
};

export class ActionJournalError extends Error {
  status:number;
  constructor(message:string,status=400){super(message);this.status=status;}
}

function nowIso(now:()=>Date){return now().toISOString();}
function plusIso(now:Date,milliseconds:number){return new Date(now.getTime()+milliseconds).toISOString();}
function same(left:LocalTaskSnapshot,right:LocalTaskSnapshot){return JSON.stringify(left)===JSON.stringify(right);}

function snapshot(db:DatabaseSync,userId:number,taskId:number):LocalTaskSnapshot|null {
  const row=db.prepare(`SELECT id,title,completed,duration_minutes FROM tasks WHERE id=? AND user_id=?`).get(taskId,userId) as Omit<TaskState,"key">|undefined;
  if(!row)return null;
  const task:Omit<TaskState,"key">={id:row.id,title:row.title,completed:row.completed,duration_minutes:row.duration_minutes};
  const key=`local:${taskId}`;
  const plan=db.prepare(`SELECT scheduled_at,duration_minutes,schedule_version,legacy_schedule,mirror_requested,mirror_event_id,mirror_account_id,mirror_connection_id,
    CASE WHEN mirror_transaction_id IS NULL THEN 0 ELSE 1 END AS mirror_transaction_pending,
    CASE WHEN mirror_create_payload IS NULL THEN 0 ELSE 1 END AS mirror_create_pending
    FROM task_plans WHERE task_key=? AND user_id=?`).get(key,userId) as PlanState|undefined;
  return {task:{...task,key},plan:plan??{scheduled_at:null,duration_minutes:row.duration_minutes,schedule_version:0,legacy_schedule:0,mirror_requested:0,mirror_event_id:null,mirror_account_id:null,mirror_connection_id:null,mirror_transaction_pending:0,mirror_create_pending:0}};
}

function validateSnapshot(value:unknown):LocalTaskSnapshot {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new ActionJournalError("Veiksmo istorijos įrašas sugadintas.",409);
  const candidate=value as LocalTaskSnapshot;
  if(!candidate.task||!candidate.plan||!Number.isSafeInteger(candidate.task.id)||candidate.task.id<1||candidate.task.key!==`local:${candidate.task.id}`||
    typeof candidate.task.title!=="string"||typeof candidate.plan.schedule_version!=="number")throw new ActionJournalError("Veiksmo istorijos įrašas sugadintas.",409);
  return candidate;
}

function parseSnapshot(value:string|null){
  if(value===null)return null;
  try{return validateSnapshot(JSON.parse(value));}catch(error){if(error instanceof ActionJournalError)throw error;throw new ActionJournalError("Veiksmo istorijos įrašas sugadintas.",409);}
}

function prune(db:DatabaseSync,userId:number,now:string){
  db.prepare("DELETE FROM action_journal WHERE user_id=? AND retained_until<=?").run(userId,now);
  db.prepare(`DELETE FROM action_journal WHERE user_id=? AND id NOT IN (SELECT id FROM action_journal WHERE user_id=? ORDER BY id DESC LIMIT ?)`)
    .run(userId,userId,ACTION_HISTORY_LIMIT);
}

function publicSummary(row:JournalRow,now:string):ActionSummary {
  const expired=row.undo_expires_at<=now;
  const status:ActionStatus=row.status==="available"&&expired?"expired":row.status;
  return {operationId:row.operation_id,actionType:row.action_type,label:row.label,createdAt:row.created_at,undoExpiresAt:row.undo_expires_at,status,canUndo:row.status==="available"&&!expired};
}

function actionDetails(before:LocalTaskSnapshot,after:LocalTaskSnapshot,input:Record<string,unknown>):{type:ActionType;label:string}|null {
  const identityFields=new Set(["id","source","account_id","connection_id","list_id","schedule_version","mirror_requested","mirror_account_id","mirror_connection_id"]);
  const changedFields=Object.keys(input).filter(key=>!identityFields.has(key));
  if(before.plan.mirror_requested||after.plan.mirror_requested||before.plan.mirror_event_id||after.plan.mirror_event_id||
    before.plan.mirror_transaction_pending||after.plan.mirror_transaction_pending||before.plan.mirror_create_pending||after.plan.mirror_create_pending)return null;
  if(changedFields.every(key=>key==="completed")&&before.task.completed===0&&after.task.completed===1)return {type:"local_task_completed",label:`Užbaigta užduotis „${after.task.title}“`};
  if(before.task.completed!==after.task.completed)return null;
  const scheduling=input.scheduled_at!==undefined||input.duration_minutes!==undefined;
  if(!scheduling||changedFields.some(key=>key!=="scheduled_at"&&key!=="duration_minutes")||before.task.completed||after.task.completed)return null;
  if(!before.plan.scheduled_at&&after.plan.scheduled_at)return {type:"local_task_planned",label:`Suplanuota užduotis „${after.task.title}“`};
  if(before.plan.scheduled_at&&!after.plan.scheduled_at)return {type:"local_task_unplanned",label:`Išplanuota užduotis „${after.task.title}“`};
  if(before.plan.scheduled_at===after.plan.scheduled_at&&before.plan.duration_minutes!==after.plan.duration_minutes)return {type:"local_task_resized",label:`Pakeista užduoties „${after.task.title}“ trukmė`};
  if(before.plan.scheduled_at!==after.plan.scheduled_at)return {type:"local_task_moved",label:`Perkelta užduotis „${after.task.title}“`};
  return null;
}

export type ActionJournalHooks={
  capture(task:Task):LocalTaskSnapshot|null;
  recordCreated(task:Task):ActionSummary|undefined;
  recordUpdated(before:LocalTaskSnapshot|null,after:Task,input:Record<string,unknown>):ActionSummary|undefined;
};

export function createActionJournalHooks(db:DatabaseSync,userId:number,{now=()=>new Date()}:{now?:()=>Date}={}):ActionJournalHooks {
  function record(type:ActionType,label:string,before:LocalTaskSnapshot|null,after:LocalTaskSnapshot){
    const instant=now(),operationId=randomUUID(),createdAt=instant.toISOString(),undoExpiresAt=plusIso(instant,ACTION_UNDO_TTL_MS),retainedUntil=plusIso(instant,ACTION_RETENTION_MS);
    db.prepare(`INSERT INTO action_journal(user_id,operation_id,action_type,entity_type,entity_key,label,before_json,after_json,status,undo_expires_at,retained_until,created_at)
      VALUES(?,? ,?,'local_task',?,?,?,?, 'available',?,?,?)`).run(userId,operationId,type,after.task.key,label,before?JSON.stringify(before):null,JSON.stringify(after),undoExpiresAt,retainedUntil,createdAt);
    prune(db,userId,createdAt);
    return {operationId,actionType:type,label,createdAt,undoExpiresAt,status:"available" as const,canUndo:true};
  }
  return {
    capture(task){return task.source==="local"?snapshot(db,userId,Number(task.id)):null;},
    recordCreated(task){
      if(task.source!=="local")return undefined;
      const after=snapshot(db,userId,Number(task.id));
      return after?record("local_task_created",`Sukurta užduotis „${after.task.title}“`,null,after):undefined;
    },
    recordUpdated(before,after,input){
      if(!before||after.source!=="local")return undefined;
      const current=snapshot(db,userId,Number(after.id));if(!current)return undefined;
      const details=actionDetails(before,current,input);return details?record(details.type,details.label,before,current):undefined;
    },
  };
}

export function createActionJournalService(db:DatabaseSync,userId:number,notifications:TaskStartNotificationHooks,{now=()=>new Date()}:{now?:()=>Date}={}) {
  function list():ActionSummary[]{
    const current=nowIso(now);prune(db,userId,current);
    return (db.prepare(`SELECT operation_id,action_type,label,before_json,after_json,status,undo_expires_at,retained_until,created_at,applied_at FROM action_journal WHERE user_id=? ORDER BY id DESC LIMIT 20`).all(userId) as JournalRow[]).map(row=>publicSummary(row,current));
  }
  function undo(operationId:unknown){
    if(typeof operationId!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId))throw new ActionJournalError("Neteisingas operacijos ID.");
    const currentTime=nowIso(now);
    db.exec("BEGIN IMMEDIATE");
    try{
      prune(db,userId,currentTime);
      const row=db.prepare(`SELECT operation_id,action_type,label,before_json,after_json,status,undo_expires_at,retained_until,created_at,applied_at FROM action_journal WHERE user_id=? AND operation_id=?`).get(userId,operationId) as JournalRow|undefined;
      if(!row)throw new ActionJournalError("Veiksmo istorijos įrašas nerastas.",404);
      if(row.status==="undone"){db.exec("COMMIT");return {action:publicSummary(row,currentTime),alreadyUndone:true};}
      if(row.status!=="available")throw new ActionJournalError("Veiksmo nebegalima saugiai atšaukti. Atnaujink duomenis.",409);
      if(row.undo_expires_at<=currentTime)throw new ActionJournalError("Laikas veiksmui atšaukti baigėsi.",410);
      const before=parseSnapshot(row.before_json),after=parseSnapshot(row.after_json)!;
      const actual=snapshot(db,userId,after.task.id);
      if(!actual||!same(actual,after)){
        db.prepare("UPDATE action_journal SET status='conflict',applied_at=? WHERE user_id=? AND operation_id=? AND status='available'").run(currentTime,userId,operationId);
        db.exec("COMMIT");
        throw new ActionJournalError("Užduotis jau pasikeitė. Atšaukimas nepritaikytas — atnaujink duomenis.",409);
      }
      if(row.action_type==="local_task_created"){
        notifications.cancel(after.task.key);
        db.prepare("DELETE FROM task_plans WHERE user_id=? AND task_key=?").run(userId,after.task.key);
        db.prepare("DELETE FROM tasks WHERE user_id=? AND id=?").run(userId,after.task.id);
      }else{
        if(!before)throw new ActionJournalError("Veiksmo istorijos įrašas sugadintas.",409);
        db.prepare(`UPDATE tasks SET completed=?,duration_minutes=? WHERE user_id=? AND id=?`)
          .run(before.task.completed,before.task.duration_minutes,userId,before.task.id);
        const nextVersion=after.plan.schedule_version+1;
        const restored=db.prepare(`UPDATE task_plans SET scheduled_at=?,duration_minutes=?,schedule_version=?,legacy_schedule=?
          WHERE user_id=? AND task_key=? AND schedule_version=?`)
          .run(before.plan.scheduled_at,before.plan.duration_minutes,nextVersion,before.plan.legacy_schedule,userId,before.task.key,after.plan.schedule_version);
        if(restored.changes!==1)throw new ActionJournalError("Užduotis jau pasikeitė. Atšaukimas nepritaikytas — atnaujink duomenis.",409);
        notifications.sync(before.task.key,before.task.completed?null:before.plan.scheduled_at,nextVersion);
      }
      const changed=db.prepare("UPDATE action_journal SET status='undone',applied_at=? WHERE user_id=? AND operation_id=? AND status='available'").run(currentTime,userId,operationId);
      if(changed.changes!==1)throw new ActionJournalError("Veiksmas jau apdorotas. Atnaujink istoriją.",409);
      db.exec("COMMIT");
      const applied={...row,status:"undone" as const,applied_at:currentTime};
      return {action:publicSummary(applied,currentTime),alreadyUndone:false};
    }catch(error){
      try{db.exec("ROLLBACK");}catch{}
      throw error;
    }
  }
  return {list,undo};
}
