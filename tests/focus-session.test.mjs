import assert from "node:assert/strict";
import {test} from "node:test";
import {FOCUS_DURATION_SECONDS,parseFocusSession,remainingFocusSeconds,serializeFocusSession} from "../lib/focus-session.ts";

test("running focus restores from its absolute end without extending after clock changes",()=>{
  const startedAt=1_800_000_000_000,endsAt=startedAt+FOCUS_DURATION_SECONDS*1000;
  const raw=serializeFocusSession({taskKey:"local:1",remainingSeconds:FOCUS_DURATION_SECONDS,running:true,startedAt,endsAt});
  assert.deepEqual(parseFocusSession(raw,startedAt+10_250),{taskKey:"local:1",remainingSeconds:1490,running:true,startedAt,endsAt});
  assert.equal(parseFocusSession(raw,endsAt+1).remainingSeconds,0);assert.equal(parseFocusSession(raw,endsAt+1).running,false);
  assert.equal(parseFocusSession(raw,startedAt-60_000).remainingSeconds,FOCUS_DURATION_SECONDS);
});

test("paused and legacy focus sessions restore without starting the timer",()=>{
  assert.deepEqual(parseFocusSession(serializeFocusSession({taskKey:"remote",remainingSeconds:321,running:false,startedAt:1_700_000_000_000,endsAt:null})),{taskKey:"remote",remainingSeconds:321,running:false,startedAt:1_700_000_000_000,endsAt:null});
  assert.deepEqual(parseFocusSession(JSON.stringify({taskKey:"local:2",seconds:90})),{taskKey:"local:2",remainingSeconds:90,running:false,startedAt:null,endsAt:null});
});

test("invalid focus storage is ignored and remaining time is bounded",()=>{
  for(const raw of ["not json","null",JSON.stringify({version:1,taskKey:"",remainingSeconds:3,running:false,startedAt:null,endsAt:null}),JSON.stringify({version:1,taskKey:"x",remainingSeconds:FOCUS_DURATION_SECONDS+1,running:false,startedAt:null,endsAt:null}),JSON.stringify({version:1,taskKey:"x",remainingSeconds:3,running:true,startedAt:null,endsAt:null})])assert.equal(parseFocusSession(raw),null);
  assert.equal(remainingFocusSeconds(Date.now()+FOCUS_DURATION_SECONDS*2000),FOCUS_DURATION_SECONDS);assert.equal(remainingFocusSeconds(Date.now()-1),0);
});
