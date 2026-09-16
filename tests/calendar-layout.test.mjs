import assert from "node:assert/strict";
import test from "node:test";
import {layoutDay, dateAtMinute, dayBounds, touchesDay} from "../lib/calendar-layout.ts";
process.env.TZ = "Europe/Vilnius";
const day = new Date("2026-09-15T00:00:00");
const item = (key, start, end) => ({key, start:new Date(`2026-09-15T${start}:00`), end:new Date(`2026-09-15T${end}:00`)});
test("overlapping events and tasks share columns, disjoint groups regain full width", () => {
  const result = layoutDay([item("event","09:00","10:00"),item("task","09:30","11:00"),item("later","12:00","13:00")], day);
  assert.deepEqual(result.map(x=>[x.key,x.column,x.columns]), [["event",0,2],["task",1,2],["later",0,1]]);
});
test("minimum clickable block height participates in overlap packing", () => {
  const result=layoutDay([item("a","09:00","09:15"),item("b","09:15","09:30")],day);
  assert.equal(result[1].columns,2);
});
test("midnight intervals clip on both days, exclusive end never leaks", () => {
  const interval={key:"night",start:new Date("2026-09-14T23:30:00"),end:new Date("2026-09-15T01:00:00")};
  const before=layoutDay([interval],new Date("2026-09-14T12:00:00"))[0],after=layoutDay([interval],day)[0];
  assert.equal(before.top,1410); assert.equal(before.height,30); assert.equal(before.continuesAfter,true);
  assert.equal(after.top,0);assert.equal(after.height,60);assert.equal(after.continuesBefore,true);assert.equal(after.gestureSafe,false);
  assert.equal(touchesDay(interval.start,new Date("2026-09-15T00:00:00"),day),false);
});
test("full-day snapping includes midnight and 23:45", () => {
  assert.equal(dateAtMinute(day,-10).getHours(),0);
  assert.equal(dateAtMinute(day,1500).getHours(),23);assert.equal(dateAtMinute(day,1500).getMinutes(),45);
});
test("DST day bounds use calendar days, unsafe wall times are rejected", () => {
  const spring=new Date("2026-03-29T00:00:00"),fall=new Date("2026-10-25T00:00:00");
  assert.equal((dayBounds(spring).end-dayBounds(spring).start)/3600000,23);
  assert.equal((dayBounds(fall).end-dayBounds(fall).start)/3600000,25);
  assert.throws(()=>dateAtMinute(spring,210),/laiko/);assert.throws(()=>dateAtMinute(fall,210),/laiko/);
  assert.equal(dateAtMinute(spring,270).getHours(),4);
});
test("invalid intervals are excluded and output is deterministic", () => {
  const items=[item("b","09:00","10:00"),item("a","09:00","10:00"),item("invalid","12:00","11:00")];
  assert.deepEqual(layoutDay(items,day),layoutDay([...items].reverse(),day));assert.equal(layoutDay(items,day).length,2);
});
