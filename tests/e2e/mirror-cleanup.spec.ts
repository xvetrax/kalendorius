import {expect,test} from "@playwright/test";

test("orphan Outlook cleanup is reachable and retryable from settings",async({page})=>{
  await page.clock.setFixedTime(new Date("2026-09-23T09:00:00Z"));
  const cleanup={task_key:'["google","google-account","list-a","gone"]',source:"google",title:"Pašalinta užduotis",
    mirror_event_id:"event-x",mirror_account_id:"microsoft-account",orphaned_at:"2026-09-23 10:00:00",can_retry:true};
  let pending=true,posted:any=null;
  await page.route("**/api/tasks?envelope=1",route=>route.fulfill({json:{items:[],warnings:[],lists:[],cleanups:pending?[cleanup]:[]}}));
  await page.route("**/api/tasks/mirror-cleanup",async route=>{posted=route.request().postDataJSON();pending=false;await route.fulfill({json:{ok:true}});});
  await page.goto("/");await page.getByRole("button",{name:"Nustatymai",exact:true}).click();
  await expect(page.getByRole("region",{name:"Likusių Outlook blokų valymas"})).toContainText("Pašalinta užduotis");
  await page.getByRole("button",{name:"Pašalinti bloką"}).click();
  await expect.poll(()=>posted).toEqual({task_key:cleanup.task_key,orphaned_at:cleanup.orphaned_at,mirror_event_id:cleanup.mirror_event_id});
  await expect(page.getByRole("region",{name:"Likusių Outlook blokų valymas"})).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Likęs Outlook blokas pašalintas");
});
