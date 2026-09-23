import {test,expect} from "@playwright/test";

test("same event IDs in different calendars keep separate timed and all-day blocks",async({page})=>{
  await page.clock.setFixedTime(new Date("2026-09-23T09:00:00Z"));
  const events=["A","B"].flatMap(calendarId=>[false,true].map(allDay=>({
    id:allDay?"shared-all-day":"shared-timed",calendarId,provider:"google",connectionId:"synthetic",
    key:JSON.stringify(["google","synthetic",calendarId,allDay?"shared-all-day":"shared-timed"]),version:"v1",
    summary:`${calendarId} ${allDay?"diena":"laikas"}`,calendarName:calendarId,editable:!allDay,readOnlyReason:"",attendeeCount:0,allDay,recurring:false,
    start:allDay?{date:"2026-09-23"}:{dateTime:"2026-09-23T08:00:00Z"},end:allDay?{date:"2026-09-24"}:{dateTime:"2026-09-23T09:00:00Z"},
  })));
  const errors:string[]=[];page.on("console",message=>{if(message.type()==="error")errors.push(message.text());});
  let patchedCalendar="";
  await page.route("**/api/google/events**",async route=>{
    if(route.request().method()==="PATCH"){
      const body=route.request().postDataJSON();patchedCalendar=body.calendarId;
      const event=events.find(event=>event.id===body.id&&event.calendarId===body.calendarId)!;
      event.start={dateTime:body.start};event.end={dateTime:body.end};event.version="v2";
      await route.fulfill({json:event});
    }else await route.fulfill({json:{items:events}});
  });
  await page.goto("/");await page.getByRole("button",{name:"Diena",exact:true}).click();
  for(const name of ["A laikas","B laikas"])await expect(page.getByRole("button",{name:`Redaguoti įvykį: ${name}`,exact:true})).toHaveCount(1);
  for(const name of ["A diena","B diena"])await expect(page.locator(".allDayEvent").filter({hasText:name})).toHaveCount(1);
  const a=page.getByRole("button",{name:"Redaguoti įvykį: A laikas",exact:true});const before=await a.innerText();
  const b=page.getByRole("button",{name:"Redaguoti įvykį: B laikas",exact:true}),beforeB=await b.innerText();
  await b.press("Shift+ArrowDown");
  await expect.poll(()=>patchedCalendar).toBe("B");await expect.poll(()=>b.innerText()).not.toBe(beforeB);
  await expect(a).toHaveText(before,{useInnerText:true});
  expect(errors.filter(error=>/same key|unique.*key/i.test(error))).toEqual([]);
});
