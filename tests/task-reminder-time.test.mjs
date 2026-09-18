import assert from "node:assert/strict";
import {test} from "node:test";
import {reminderLocalInput,reminderLocalInstant} from "../lib/task-reminder-time.ts";

test("Vilnius reminder dates retain wall time and reject nonexistent or repeated DST hours",()=>{
  const previous=process.env.TZ;process.env.TZ="Europe/Vilnius";
  try {
    assert.equal(reminderLocalInstant("2026-10-25T10:30"),"2026-10-25T08:30:00.000Z");
    assert.equal(reminderLocalInput("2026-07-25T08:30:25.123Z"),"2026-07-25T11:30");
    assert.throws(()=>reminderLocalInstant("2026-03-29T03:30"),/neegzistuoja/);
    assert.throws(()=>reminderLocalInstant("2026-10-25T03:30"),/kartojasi/);
    for(const value of ["2026-02-30T10:30","2026-10-25T24:00","invalid",""])assert.throws(()=>reminderLocalInstant(value));
  } finally {if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});

test("reminder conversion uses the browser zone and catches half-hour transitions",()=>{
  const previous=process.env.TZ;
  try {
    process.env.TZ="UTC";assert.equal(reminderLocalInstant("2026-10-25T03:30"),"2026-10-25T03:30:00.000Z");
    process.env.TZ="Australia/Lord_Howe";assert.throws(()=>reminderLocalInstant("2026-04-05T01:45"),/kartojasi/);assert.throws(()=>reminderLocalInstant("2026-10-04T02:15"),/neegzistuoja/);
  } finally {if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
