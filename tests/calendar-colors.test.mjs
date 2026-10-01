import assert from "node:assert/strict";
import test from "node:test";
import {calendarColorStyle,resolveCalendarAccountColors} from "../lib/calendar-colors.ts";

test("duplicate provider colors become stable colors per account and calendar",()=>{
  const accounts=[
    {provider:"google",accountId:"personal",colorKey:"google:personal",items:[{id:"primary",color:"#a4bdfc"},{id:"unique",color:"#34a853"}]},
    {provider:"google",accountId:"work",colorKey:"google:work",items:[{id:"primary",color:"#a4bdfc"},{id:"missing"}]},
  ];
  const first=resolveCalendarAccountColors(accounts),second=resolveCalendarAccountColors(accounts);
  assert.deepEqual(first,second);
  assert.notEqual(first[0].items[0].color,first[1].items[0].color);
  assert.match(first[0].items[0].color,/^#[0-9a-f]{6}$/);
  assert.match(first[1].items[1].color,/^#[0-9a-f]{6}$/);
  assert.equal(first[0].items[1].color,"#34a853");
});

test("calendar card style only accepts normalized hexadecimal colors",()=>{
  assert.deepEqual(calendarColorStyle("#34A853"),{
    borderLeftColor:"#34a853",
    backgroundColor:"color-mix(in srgb, #34a853 24%, var(--surface))",
    color:"var(--ink)",
  });
  assert.equal(calendarColorStyle("red; background:url(x)"),undefined);
});
