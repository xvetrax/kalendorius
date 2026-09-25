import assert from "node:assert/strict";
import {test} from "node:test";
import {calendarTimeZones,canonicalCalendarTimeZone,isCalendarTimeZone,matchingCalendarTimeZone,unambiguousZonedProviderDateTime,zonedInstant,zonedLocalInput,zonedProviderDateTime} from "../lib/calendar-time-zone.ts";

test("calendar wall times round-trip independently of the process timezone",()=>{
  const previous=process.env.TZ;process.env.TZ="America/New_York";
  try{
    assert.equal(zonedInstant("2026-10-25T10:30","Europe/Vilnius"),"2026-10-25T08:30:00.000Z");
    assert.equal(zonedLocalInput("2026-07-25T08:30:25.123Z","Europe/Vilnius"),"2026-07-25T11:30");
    assert.equal(zonedProviderDateTime("2026-07-25T08:30:25.123Z","Europe/Vilnius"),"2026-07-25T11:30:25");
  }finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});

test("calendar wall times reject DST gaps and repeated hours, including half-hour transitions",()=>{
  assert.throws(()=>zonedInstant("2026-03-29T03:30","Europe/Vilnius"),/neegzistuoja/);
  assert.throws(()=>unambiguousZonedProviderDateTime("2026-10-25T00:30:00Z","Europe/Vilnius"),/kartojasi/);
  assert.throws(()=>zonedInstant("2026-10-25T03:30","Europe/Vilnius"),/kartojasi/);
  assert.throws(()=>zonedInstant("2026-10-04T02:15","Australia/Lord_Howe"),/neegzistuoja/);
  assert.throws(()=>zonedInstant("2026-04-05T01:45","Australia/Lord_Howe"),/kartojasi/);
});

test("calendar timezone catalog and validation reject malformed input",()=>{
  assert.equal(calendarTimeZones()[0],"UTC");assert.equal(isCalendarTimeZone("Europe/Vilnius"),true);assert.equal(isCalendarTimeZone("Not/AZone"),false);assert.equal(isCalendarTimeZone("+01:00"),false);
  assert.equal(canonicalCalendarTimeZone("Europe/Kyiv"),canonicalCalendarTimeZone("Europe/Kiev"));
  assert.equal(matchingCalendarTimeZone("Europe/Kyiv",["Europe/London","Europe/Kiev"]),"Europe/Kiev");assert.equal(matchingCalendarTimeZone("Pacific/Auckland",["Europe/Kiev"]),null);
  for(const value of ["2026-02-30T10:30","2026-10-25T24:00","invalid",""])assert.throws(()=>zonedInstant(value,"Europe/Vilnius"));
  assert.throws(()=>zonedInstant("2026-10-25T10:30","Not/AZone"));assert.equal(zonedLocalInput("invalid","UTC"),"");
});
