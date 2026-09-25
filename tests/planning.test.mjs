import assert from "node:assert/strict";
import test from "node:test";
import { buildOutlookEvent, normalizeGraphDateTime } from "../lib/planning.ts";

test("Microsoft To Do laiko blokas visada kuriamas kaip free", () => {
  const event = buildOutlookEvent({ kind: "task-time-block", summary: "Užduotis", start: "2026-10-25T00:30:00.000Z", end: "2026-10-25T01:00:00.000Z", showAs: "busy", isReminderOn: true, addMeet: true });
  assert.equal(event.showAs, "free");
  assert.equal(event.isReminderOn, false);
  assert.equal(event.isOnlineMeeting, false);
  assert.equal("onlineMeetingProvider" in event, false);
});

test("įprastas Outlook susitikimas pagal nutylėjimą lieka busy", () => {
  const event = buildOutlookEvent({ summary: "Susitikimas", start: "2026-03-29T00:30:00Z", end: "2026-03-29T01:30:00Z" });
  assert.equal(event.showAs, "busy");
});

test("Outlook susitikimas naudoja pasirinktos IANA zonos vietinį laiką",()=>{
  const event=buildOutlookEvent({summary:"Susitikimas",start:"2026-10-24T07:00:00Z",end:"2026-10-24T08:00:00Z",timeZone:"Europe/Vilnius"});
  assert.deepEqual(event.start,{dateTime:"2026-10-24T10:00:00",timeZone:"Europe/Vilnius"});assert.deepEqual(event.end,{dateTime:"2026-10-24T11:00:00",timeZone:"Europe/Vilnius"});
  assert.throws(()=>buildOutlookEvent({summary:"Blogas",start:"2026-10-24T07:00:00Z",end:"2026-10-24T08:00:00Z",timeZone:"+03:00"}),/laiko zona/);
  assert.throws(()=>buildOutlookEvent({summary:"DST",start:"2026-10-24T23:30:00Z",end:"2026-10-25T00:30:00Z",timeZone:"Europe/Vilnius"}),/kartojasi/);
});

test("Graph UTC data gauna zonos žymę tik kai jos nėra", () => {
  assert.equal(normalizeGraphDateTime("2026-03-29T00:30:00.0000000", "UTC"), "2026-03-29T00:30:00.0000000Z");
  assert.equal(normalizeGraphDateTime("2026-03-29T03:30:00+03:00", "UTC"), "2026-03-29T03:30:00+03:00");
});
