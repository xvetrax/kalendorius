import assert from "node:assert/strict";
import {test} from "node:test";
import {calendarOccurrencesBefore,defaultCalendarRecurrence,futureCalendarRecurrence,graphCalendarRecurrence,googleCalendarRecurrence,parseCalendarRecurrence,parseGoogleCalendarRecurrence,parseGraphCalendarRecurrence,splitCalendarRecurrence} from "../lib/calendar-recurrence.ts";

const timed={startDate:"2026-10-26",allDay:false,timeZone:"Europe/Vilnius"},allDay={startDate:"2026-10-26",allDay:true};
const rules=[
  {frequency:"daily",interval:2,end:{type:"never"}},
  {frequency:"weekly",interval:2,days_of_week:["monday","wednesday"],end:{type:"count",count:8}},
  {frequency:"monthly",interval:1,day_of_month:26,end:{type:"date",date:"2027-03-26"}},
  {frequency:"yearly",interval:1,day_of_month:26,month:10,end:{type:"never"}},
];

test("calendar recurrence validates all supported patterns and end conditions",()=>{
  for(const rule of rules)assert.deepEqual(parseCalendarRecurrence(rule,timed),rule);
  for(const invalid of [
    {...rules[0],interval:0},{...rules[0],extra:true},{...rules[1],days_of_week:[]},{...rules[1],days_of_week:["monday","monday"]},
    {...rules[2],day_of_month:32},{...rules[2],end:{type:"date",date:"2026-10-25"}},{...rules[3],month:13},{...rules[0],end:{type:"count",count:1000}},
  ])assert.equal(parseCalendarRecurrence(invalid,timed),null,JSON.stringify(invalid));
  assert.deepEqual(defaultCalendarRecurrence("weekly",timed),{frequency:"weekly",interval:1,days_of_week:["monday"],end:{type:"never"}});
});

test("Google recurrence round-trips daily, weekly, monthly and yearly rules",()=>{
  for(const rule of rules){const encoded=googleCalendarRecurrence(rule,timed),decoded=parseGoogleCalendarRecurrence(encoded,timed);assert.deepEqual(decoded,rule,encoded[0]);}
  assert.deepEqual(googleCalendarRecurrence({...rules[0],end:{type:"date",date:"2026-11-02"}},allDay),["RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261102"]);
  assert.equal(parseGoogleCalendarRecurrence(["RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=2TU"],timed),null);
  assert.equal(parseGoogleCalendarRecurrence(["RRULE:FREQ=DAILY;COUNT=3;UNTIL=20261102"],allDay),null);
});

test("Graph recurrence round-trips supported structured rules",()=>{
  for(const rule of rules){const encoded=graphCalendarRecurrence(rule,timed),decoded=parseGraphCalendarRecurrence(encoded,timed);assert.deepEqual(decoded,rule,JSON.stringify(encoded));}
  assert.equal(parseGraphCalendarRecurrence({pattern:{type:"relativeMonthly",interval:1,daysOfWeek:["monday"],index:"first"},range:{type:"noEnd",startDate:timed.startDate}},timed),null);
  assert.equal(parseGraphCalendarRecurrence({pattern:{type:"daily",interval:1},range:{type:"noEnd",startDate:"2026-10-27"}},timed),null);
});

test("Graph recurrence accepts provider default fields and preserves the series week start",()=>{
  const provider={pattern:{type:"weekly",interval:2,month:0,dayOfMonth:0,daysOfWeek:["monday","wednesday"],firstDayOfWeek:"sunday",index:"first"},range:{type:"noEnd",startDate:"2026-10-26",endDate:"0001-01-01",recurrenceTimeZone:"FLE Standard Time",numberOfOccurrences:0}};
  const rule=parseGraphCalendarRecurrence(provider,timed);assert.deepEqual(rule,{frequency:"weekly",interval:2,days_of_week:["monday","wednesday"],end:{type:"never"}});
  assert.deepEqual(graphCalendarRecurrence(rule,{...timed,providerTimeZone:"FLE Standard Time",providerWeekStart:"sunday"}),{pattern:{type:"weekly",interval:2,daysOfWeek:["monday","wednesday"],firstDayOfWeek:"sunday"},range:{type:"noEnd",startDate:"2026-10-26",recurrenceTimeZone:"FLE Standard Time"}});
});

test("series split counts occurrences and gives each half a valid end",()=>{
  const context={startDate:"2026-10-05",allDay:false,timeZone:"Europe/Vilnius"},original={frequency:"weekly",interval:1,days_of_week:["monday","wednesday"],end:{type:"count",count:8}};
  assert.equal(calendarOccurrencesBefore(original,context,"2026-10-19"),4);
  assert.deepEqual(futureCalendarRecurrence(original,context,"2026-10-19"),{...original,end:{type:"count",count:4}});
  assert.deepEqual(splitCalendarRecurrence(original,{frequency:"daily",interval:2,end:{type:"count",count:5}},context,"2026-10-19"),{
    truncated:{...original,end:{type:"count",count:4}},future:{frequency:"daily",interval:2,end:{type:"count",count:5}},before:4,
  });
});

test("series split rejects the first date, non-occurrences, and dates beyond the end",()=>{
  const context={startDate:"2026-10-05",allDay:true},rule={frequency:"weekly",interval:1,days_of_week:["monday"],end:{type:"date",date:"2026-10-26"}};
  assert.equal(splitCalendarRecurrence(rule,rule,context,"2026-10-05"),null);
  assert.equal(calendarOccurrencesBefore(rule,context,"2026-10-06"),null);
  assert.equal(futureCalendarRecurrence(rule,context,"2026-11-02"),null);
  assert.deepEqual(splitCalendarRecurrence(rule,{...rule,end:{type:"never"}},context,"2026-10-19"),{
    truncated:{...rule,end:{type:"date",date:"2026-10-18"}},future:{...rule,end:{type:"never"}},before:2,
  });
});
