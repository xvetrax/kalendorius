import {expect,test} from "@playwright/test";

test("Microsoft recurrence can be configured from the task editor",async({page})=>{
  await page.clock.setFixedTime(new Date("2026-09-23T09:00:00Z"));
  const task={id:"task-1",key:'["microsoft","microsoft-account","list-a","task-1"]',source:"microsoft",account_id:"microsoft-account",list_id:"list-a",list_name:"Darbai",title:"Kartojama užduotis",notes:"",completed:0,due_at:"2026-09-23T12:00:00.000Z",scheduled_at:null,duration_minutes:30,mirror_requested:0,mirror_event_id:null,mirror_error:null,project:"Microsoft To Do",priority:"normal",energy:"medium",tags:"",schedule_version:0,legacy_schedule:0};
  let posted:any=null;
  await page.route("**/api/tasks?envelope=1",route=>route.fulfill({json:{items:[task],warnings:[],lists:[],cleanups:[]}}));
  await page.route("**/api/microsoft/events**",route=>route.fulfill({json:{items:[]}}));
  await page.route("**/api/google/events**",route=>route.fulfill({json:{items:[]}}));
  await page.route("**/api/tasks/steps**",route=>route.fulfill({json:{items:[],version:"steps-v1"}}));
  await page.route("**/api/tasks/reminder**",route=>route.fulfill({json:{enabled:false,at:null,source_time:null,version:"reminder-v1",recurring:false}}));
  await page.route("**/api/tasks/recurrence**",async route=>{
    if(route.request().method()==="PATCH"){
      posted=route.request().postDataJSON();
      await route.fulfill({json:{recurrence:posted.recurrence,supported:true,suggested_start_date:"2026-09-23",version:"recurrence-v2"}});
    }else await route.fulfill({json:{recurrence:null,supported:true,suggested_start_date:"2026-09-23",version:"recurrence-v1"}});
  });
  await page.goto("/");
  await page.locator(".taskCard").filter({hasText:task.title}).locator(".taskDetailsButton").click();
  const editor=page.getByRole("dialog",{name:"Užduotis ir jos planas"});
  await expect(editor.getByRole("region",{name:"Microsoft To Do kartojimas"})).toHaveCount(1);
  const recurrenceSwitch=editor.locator("label.onlineSwitch").filter({hasText:"Kartoti užduotį"});
  await recurrenceSwitch.click();
  await expect(recurrenceSwitch.getByRole("checkbox")).toBeChecked();
  await editor.getByLabel("Kartojimo dažnis").selectOption("weekly");
  await editor.getByLabel("Kartojimo intervalas").fill("2");
  await editor.getByLabel("Kartojimo pradžios diena").fill("2026-09-24");
  const wednesday=editor.locator(".recurrenceWeekdays label").filter({hasText:"Tr"});
  await wednesday.click();
  await expect(wednesday.getByRole("checkbox")).toBeChecked();
  await editor.getByRole("button",{name:"Išsaugoti kartojimą"}).click();
  await expect.poll(()=>posted).toMatchObject({source:"microsoft",account_id:"microsoft-account",list_id:"list-a",id:"task-1",version:"recurrence-v1",recurrence:{frequency:"weekly",interval:2,start_date:"2026-09-24",days_of_week:["monday","wednesday"]}});
  await expect(editor.getByRole("status")).toContainText("Microsoft To Do kartojimas išsaugotas");
  await editor.getByLabel("Kartojimo intervalas").fill("3");
  await expect(editor.getByRole("status")).toHaveCount(0);
  await editor.getByLabel("Kartojimo pradžios diena").fill("");
  await expect(editor.getByRole("region",{name:"Microsoft To Do kartojimas"}).getByRole("alert")).toContainText("Patikrink kartojimo intervalą");
  await expect(editor.getByRole("button",{name:"Išsaugoti kartojimą"})).toBeDisabled();
});
