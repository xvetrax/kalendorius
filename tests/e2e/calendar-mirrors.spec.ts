import {test,expect} from "@playwright/test";

test("confirmed Outlook mirrors collapse into the task, while unrelated same-ID events remain",async({page})=>{
  await page.clock.setFixedTime(new Date("2026-09-23T09:00:00Z"));
  const task={id:1,key:"local:1",source:"local",title:"Susietas darbas",notes:"",completed:0,scheduled_at:"2026-09-23T08:00:00Z",duration_minutes:30,mirror_requested:1,mirror_event_id:"shared",project:"Darbas",priority:"normal",energy:"medium",tags:"",schedule_version:1};
  const events=["A","B"].map(calendarId=>({
    id:"shared",calendarId,provider:"outlook",connectionId:"synthetic",key:JSON.stringify(["outlook","synthetic",calendarId,"shared"]),version:"v1",
    mirrorTaskKey:calendarId==="A"?task.key:null,summary:calendarId==="A"?`✓ ${task.title}`:"Kitas įvykis",editable:true,readOnlyReason:"",attendeeCount:0,allDay:false,recurring:false,
    start:{dateTime:task.scheduled_at},end:{dateTime:"2026-09-23T08:30:00Z"},
  }));
  await page.route("**/api/tasks?envelope=1",route=>route.fulfill({json:{items:[task],warnings:[],lists:[]}}));
  await page.route("**/api/microsoft/events**",route=>route.fulfill({json:{items:events}}));
  await page.route("**/api/google/events**",route=>route.fulfill({json:{items:[]}}));
  await page.goto("/");await page.getByRole("button",{name:"Diena",exact:true}).click();
  await expect(page.getByRole("button",{name:`Redaguoti planą: ${task.title}`,exact:true})).toHaveCount(1);
  await expect(page.getByRole("button",{name:`Redaguoti įvykį: ✓ ${task.title}`,exact:true})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Redaguoti įvykį: Kitas įvykis",exact:true})).toHaveCount(1);
  await expect(page.locator(".dayLoad small")).toHaveText("1 įvykiai · 1 užduotys");
  await page.getByRole("button",{name:"Mėnuo",exact:true}).click();
  await expect(page.locator(".monthGrid span").filter({hasText:`✓ ${task.title}`})).toHaveCount(1);
  await expect(page.locator(".monthGrid span").filter({hasText:"Kitas įvykis"})).toHaveCount(1);
  // A moved source event is visible again until its time matches the local plan.
  events[0].start.dateTime="2026-09-23T10:00:00Z";events[0].end.dateTime="2026-09-23T10:30:00Z";
  await page.reload();await page.getByRole("button",{name:"Diena",exact:true}).click();
  await expect(page.getByRole("button",{name:`Redaguoti įvykį: ✓ ${task.title}`,exact:true})).toHaveCount(1);
  await expect(page.locator(".dayLoad small")).toHaveText("2 įvykiai · 1 užduotys");
});
