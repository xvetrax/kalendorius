import assert from "node:assert/strict";
import {test} from "node:test";
import {enqueueFocusCancellation,FOCUS_DURATION_SECONDS,parseFocusCancellationQueue,parseFocusSession,remainingFocusSeconds,removeFocusCancellation,serializeFocusSession} from "../lib/focus-session.ts";

test("running focus restores from its absolute end without extending after clock changes",()=>{
  const startedAt=1_800_000_000_000,endsAt=startedAt+FOCUS_DURATION_SECONDS*1000;
  const notificationOperationId="123e4567-e89b-42d3-a456-426614174000";
  const raw=serializeFocusSession({taskKey:"local:1",remainingSeconds:FOCUS_DURATION_SECONDS,running:true,startedAt,endsAt,notificationOperationId});
  assert.deepEqual(parseFocusSession(raw,startedAt+10_250),{taskKey:"local:1",remainingSeconds:1490,running:true,startedAt,endsAt,notificationOperationId});
  assert.equal(parseFocusSession(raw,endsAt+1).remainingSeconds,0);assert.equal(parseFocusSession(raw,endsAt+1).running,false);
  assert.equal(parseFocusSession(raw,startedAt-60_000).remainingSeconds,FOCUS_DURATION_SECONDS);
});

test("paused and legacy focus sessions restore without starting the timer",()=>{
  assert.deepEqual(parseFocusSession(serializeFocusSession({taskKey:"remote",remainingSeconds:321,running:false,startedAt:1_700_000_000_000,endsAt:null,notificationOperationId:null})),{taskKey:"remote",remainingSeconds:321,running:false,startedAt:1_700_000_000_000,endsAt:null,notificationOperationId:null});
  assert.deepEqual(parseFocusSession(JSON.stringify({taskKey:"local:2",seconds:90})),{taskKey:"local:2",remainingSeconds:90,running:false,startedAt:null,endsAt:null,notificationOperationId:null});
});

test("invalid focus storage is ignored and remaining time is bounded",()=>{
  for(const raw of ["not json","null",JSON.stringify({version:1,taskKey:"",remainingSeconds:3,running:false,startedAt:null,endsAt:null}),JSON.stringify({version:1,taskKey:"x",remainingSeconds:FOCUS_DURATION_SECONDS+1,running:false,startedAt:null,endsAt:null}),JSON.stringify({version:1,taskKey:"x",remainingSeconds:3,running:true,startedAt:null,endsAt:null})])assert.equal(parseFocusSession(raw),null);
  assert.equal(remainingFocusSeconds(Date.now()+FOCUS_DURATION_SECONDS*2000),FOCUS_DURATION_SECONDS);assert.equal(remainingFocusSeconds(Date.now()-1),0);
});

test("pending focus cancellations are validated, deduplicated and retained until acknowledged",()=>{
  const first="123e4567-e89b-42d3-a456-426614174000",second="223e4567-e89b-42d3-a456-426614174000";
  let raw=enqueueFocusCancellation(null,first);
  raw=enqueueFocusCancellation(raw,first.toUpperCase());
  raw=enqueueFocusCancellation(raw,second);
  assert.deepEqual(parseFocusCancellationQueue(raw),[first,second]);
  assert.deepEqual(parseFocusCancellationQueue(removeFocusCancellation(raw,first)),[second]);
  assert.deepEqual(parseFocusCancellationQueue(JSON.stringify(["bad",second,42])),[second]);
});
