import assert from "node:assert/strict";
import {after,beforeEach,test} from "node:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {registerHooks} from "node:module";

const temp=mkdtempSync(path.join(tmpdir(),"planner-actions-")),dbFile=path.join(temp,"actions.db");
process.env.DATABASE_PATH=dbFile;process.env.MULTI_USER_DATABASE_PATH=dbFile;
process.env.TOKEN_ENCRYPTION_KEY="ad".repeat(32);process.env.APP_ORIGIN="http://localhost:3000";
const hooks=registerHooks({resolve(specifier,context,next){return next(specifier.startsWith("@/")?pathToFileURL(path.resolve(import.meta.dirname,"..",`${specifier.slice(2)}.ts`)).href:specifier,context);}});

const {db,createSession,SESSION_COOKIE}=await import("../lib/db-multi.ts");
const {createTaskService}=await import("../lib/task-service.ts");
const {createActionJournalHooks,createActionJournalService,ACTION_UNDO_TTL_MS}=await import("../lib/action-journal.ts");
const actionsRoute=await import("../app/api/actions/route.ts");

function user(email){return Number(db.prepare("INSERT INTO users(display_name,primary_email,role,status) VALUES (?,?,'member','active')").run(email,email).lastInsertRowid);}
const userA=user("actions-a@example.test"),userB=user("actions-b@example.test");
const sessionA=createSession(userA),cookieA=`${SESSION_COOKIE}=${sessionA.rawToken}`;
const notifications={sync(){},cancel(){},move(){}};
let clock=Date.parse("2099-10-08T08:00:00.000Z");
const now=()=>new Date(clock);
function services(userId=userA){
  const journal=createActionJournalHooks(db,userId,{now});
  return {tasks:createTaskService(db,userId,[],[],notifications,journal),actions:createActionJournalService(db,userId,notifications,{now})};
}
function ref(task){return {id:task.id,source:task.source,schedule_version:task.schedule_version};}
function request({method="GET",cookie=cookieA,origin="http://localhost:3000",body}={}){
  const headers={cookie};if(method!=="GET")headers.origin=origin;if(body)headers["content-type"]="application/json";
  return new Request("http://localhost:3000/api/actions",{method,headers,body:body?JSON.stringify(body):undefined});
}

beforeEach(()=>{
  db.prepare("DELETE FROM action_journal WHERE user_id IN (?,?)").run(userA,userB);
  db.prepare("DELETE FROM notification_jobs WHERE user_id IN (?,?)").run(userA,userB);
  db.prepare("DELETE FROM task_plans WHERE user_id IN (?,?)").run(userA,userB);
  db.prepare("DELETE FROM tasks WHERE user_id IN (?,?)").run(userA,userB);
  clock=Date.parse("2099-10-08T08:00:00.000Z");
});
after(()=>{db.close();hooks.deregister();rmSync(temp,{recursive:true,force:true});});

test("local creation undo is durable, idempotent, and user scoped",async()=>{
  const a=services(),created=await a.tasks.create({title:"Atšaukiama"});
  assert.equal(created.undo?.actionType,"local_task_created");
  assert.equal(a.actions.list()[0].canUndo,true);
  assert.throws(()=>services(userB).actions.undo(created.undo.operationId),error=>error.status===404);
  const first=a.actions.undo(created.undo.operationId);
  assert.equal(first.alreadyUndone,false);assert.equal(db.prepare("SELECT 1 FROM tasks WHERE id=?").get(created.id),undefined);
  const restarted=createActionJournalService(db,userA,notifications,{now});
  assert.equal(restarted.undo(created.undo.operationId).alreadyUndone,true);
});

test("completion and scheduling undo restore state and advance the version",async()=>{
  const a=services();let task=await a.tasks.create({title:"Suplanuota",scheduled_at:"2026-10-09T08:00:00.000Z",duration_minutes:45});
  task=await a.tasks.update({...ref(task),scheduled_at:"2026-10-09T09:00:00.000Z",duration_minutes:60});
  const moveOperation=task.undo.operationId,moveAfter=task.schedule_version;
  a.actions.undo(moveOperation);
  task=(await a.tasks.list()).items[0];
  assert.equal(task.scheduled_at,"2026-10-09T08:00:00.000Z");assert.equal(task.duration_minutes,45);assert.equal(task.schedule_version,moveAfter+1);
  assert.equal(db.prepare("SELECT duration_minutes FROM tasks WHERE user_id=? AND id=?").get(userA,task.id).duration_minutes,45);
  task=await a.tasks.update({...ref(task),completed:true});
  const completeAfter=task.schedule_version;a.actions.undo(task.undo.operationId);
  task=(await a.tasks.list()).items[0];
  assert.equal(task.completed,0);assert.equal(task.scheduled_at,"2026-10-09T08:00:00.000Z");assert.equal(task.schedule_version,completeAfter+1);
});

test("later changes and expired windows reject undo without mutation",async()=>{
  const a=services();let task=await a.tasks.create({title:"Konfliktas"});
  task=await a.tasks.update({...ref(task),scheduled_at:"2026-10-09T08:00:00.000Z"});const stale=task.undo.operationId;
  task=await a.tasks.update({...ref(task),title:"Pakeista vėliau"});
  assert.throws(()=>a.actions.undo(stale),error=>error.status===409);
  assert.equal((await a.tasks.list()).items[0].title,"Pakeista vėliau");
  task=await a.tasks.create({title:"Pavėluota"});clock+=ACTION_UNDO_TTL_MS+1;
  assert.throws(()=>a.actions.undo(task.undo.operationId),error=>error.status===410);
  assert.ok(db.prepare("SELECT 1 FROM tasks WHERE id=?").get(task.id));
});

test("mirrored and provider mutations never expose local undo",async()=>{
  const a=services();let task=await a.tasks.create({title:"Veidrodis"});
  db.prepare("UPDATE task_plans SET mirror_requested=1,mirror_account_id='account',mirror_connection_id=NULL WHERE user_id=? AND task_key=?").run(userA,task.key);
  task=(await a.tasks.list()).items[0];
  const changed=await a.tasks.update({...ref(task),completed:true});
  assert.equal(changed.undo,undefined);
});

test("calendar payload with disabled mirror still records planning undo",async()=>{
  const a=services();let task=await a.tasks.create({title:"Kalendoriaus tempimas"});
  task=await a.tasks.update({...ref(task),scheduled_at:"2099-10-09T08:00:00.000Z",duration_minutes:30,mirror_requested:false,mirror_account_id:"unused",mirror_connection_id:44});
  assert.equal(task.undo?.actionType,"local_task_planned");
  a.actions.undo(task.undo.operationId);task=(await a.tasks.list()).items[0];
  assert.equal(task.scheduled_at,null);
});

test("journal retains at most fifty actions per user",async()=>{
  const a=services();
  for(let index=0;index<55;index+=1)await a.tasks.create({title:`Ribota ${index}`});
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM action_journal WHERE user_id=?").get(userA).count,50);
});

test("legacy local task without a plan can be changed and undone",async()=>{
  const a=services();let task=await a.tasks.create({title:"Sena vietinė"});
  db.prepare("DELETE FROM task_plans WHERE user_id=? AND task_key=?").run(userA,task.key);
  task=(await a.tasks.list()).items[0];
  task=await a.tasks.update({...ref(task),completed:true});
  a.actions.undo(task.undo.operationId);
  task=(await a.tasks.list()).items[0];
  assert.equal(task.completed,0);assert.equal(task.schedule_version,2);
});

test("actions API enforces authentication, origin and idempotent undo",async()=>{
  const a=services(),task=await a.tasks.create({title:"Per API"});
  assert.equal((await actionsRoute.GET(request({cookie:""}))).status,401);
  assert.equal((await actionsRoute.POST(request({method:"POST",origin:"https://evil.example",body:{operationId:task.undo.operationId}}))).status,403);
  const response=await actionsRoute.POST(request({method:"POST",body:{operationId:task.undo.operationId}}));
  assert.equal(response.status,200);assert.equal((await response.json()).alreadyUndone,false);
  const repeated=await actionsRoute.POST(request({method:"POST",body:{operationId:task.undo.operationId}}));
  assert.equal(repeated.status,200);assert.equal((await repeated.json()).alreadyUndone,true);
});
