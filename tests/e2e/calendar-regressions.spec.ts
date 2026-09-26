import {expect,test,type Page} from "@playwright/test";

const day="2026-09-23";
function event(provider:"google"|"outlook",id:string,summary:string,hour:number){
  return {id,calendarId:"primary",provider,connectionId:`${provider}-connection`,key:JSON.stringify([provider,`${provider}-connection`,"primary",id]),version:provider==="google"?'"google-v1"':'W/"outlook-v1"',summary,editable:true,readOnlyReason:"",attendeeCount:0,allDay:false,recurring:false,canRespond:false,showAs:"busy",visibility:"default",reminder:{mode:provider==="google"?"default":"minutes",...(provider==="outlook"?{minutes:15}:{})},timeZone:"UTC",start:{dateTime:`${day}T${String(hour).padStart(2,"0")}:00:00Z`},end:{dateTime:`${day}T${String(hour+1).padStart(2,"0")}:00:00Z`}};
}
function task(overrides:Record<string,unknown>={}){
  return {id:"task-1",key:'["google","account","list","task-1"]',source:"google",account_id:"account",list_id:"list",list_name:"Darbai",title:"Google dienos užduotis",notes:"",completed:0,due_date:day,due_at:null,scheduled_at:null,duration_minutes:45,mirror_requested:0,mirror_event_id:null,mirror_error:null,project:"Google Tasks",priority:"normal",energy:"medium",tags:"",schedule_version:0,legacy_schedule:0,...overrides};
}
async function mockTasks(page:Page,items:ReturnType<typeof task>[]=[]){
  await page.route("**/api/tasks?envelope=1",route=>route.fulfill({json:{items,warnings:[],lists:[],cleanups:[]}}));
}

test("Google and Outlook events keep distinct colors and open from month view",async({page})=>{
  await page.clock.setFixedTime(new Date(`${day}T09:00:00Z`));
  const google=event("google","google-1","Google spalva",8),outlook=event("outlook","outlook-1","Outlook spalva",10);
  let googleItems=[google];
  await mockTasks(page);
  await page.route("**/api/google/events**",route=>route.fulfill({json:{items:googleItems}}));
  await page.route("**/api/microsoft/events**",route=>route.fulfill({json:{items:[outlook]}}));
  await page.goto("/");await page.getByRole("button",{name:"Diena",exact:true}).click();
  const googleColor=await page.locator(".eventBlock.google").evaluate(element=>getComputedStyle(element).backgroundColor);
  const outlookColor=await page.locator(".eventBlock.outlook").evaluate(element=>getComputedStyle(element).backgroundColor);
  expect(googleColor).not.toBe(outlookColor);
  await page.getByRole("button",{name:"Mėnuo",exact:true}).click();
  await page.locator(".monthGrid span").filter({hasText:"Google spalva"}).click();
  await expect(page.getByRole("dialog",{name:"Kalendoriaus įvykis"}).getByLabel("Pavadinimas")).toHaveValue("Google spalva");
  await page.getByRole("dialog",{name:"Kalendoriaus įvykis"}).getByRole("button",{name:"Uždaryti"}).click();
  await page.locator(".monthGrid span").filter({hasText:"Outlook spalva"}).click();
  await expect(page.getByRole("dialog",{name:"Kalendoriaus įvykis"}).getByLabel("Pavadinimas")).toHaveValue("Outlook spalva");
  await page.getByRole("dialog",{name:"Kalendoriaus įvykis"}).getByRole("button",{name:"Uždaryti"}).click();googleItems=[];
  await page.getByRole("button",{name:"Atnaujinti duomenis"}).click();await expect(page.locator(".monthGrid span").filter({hasText:"Google spalva"})).toHaveCount(0);
});

test("Google and Outlook events can be deleted with identity and version",async({page})=>{
  await page.clock.setFixedTime(new Date(`${day}T09:00:00Z`));
  const state={google:[event("google","google-delete","Trinti Google",8)],outlook:[event("outlook","outlook-delete","Trinti Outlook",10)]};
  const deleted:URL[]=[];await mockTasks(page);
  await page.route("**/api/google/events**",async route=>{if(route.request().method()==="DELETE"){deleted.push(new URL(route.request().url()));state.google=[];await route.fulfill({json:{ok:true}});}else await route.fulfill({json:{items:state.google}});});
  await page.route("**/api/microsoft/events**",async route=>{if(route.request().method()==="DELETE"){deleted.push(new URL(route.request().url()));state.outlook=[];await route.fulfill({json:{ok:true}});}else await route.fulfill({json:{items:state.outlook}});});
  await page.goto("/");await page.getByRole("button",{name:"Diena",exact:true}).click();
  for(const title of ["Trinti Google","Trinti Outlook"]){
    await page.getByRole("button",{name:`Redaguoti įvykį: ${title}`}).click();page.once("dialog",dialog=>dialog.accept());
    await page.getByRole("dialog",{name:"Kalendoriaus įvykis"}).getByRole("button",{name:"Ištrinti įvykį"}).click();
    await expect(page.getByRole("button",{name:`Redaguoti įvykį: ${title}`})).toHaveCount(0);
  }
  expect(deleted).toHaveLength(2);
  expect(Object.fromEntries(deleted[0].searchParams)).toMatchObject({id:"google-delete",calendarId:"primary",connectionId:"google-connection",version:'"google-v1"'});
  expect(Object.fromEntries(deleted[1].searchParams)).toMatchObject({id:"outlook-delete",calendarId:"primary",connectionId:"outlook-connection",version:'W/"outlook-v1"'});
});

test("Google due-date task appears on its day, opens in month view and shows a drag target",async({page})=>{
  await page.clock.setFixedTime(new Date(`${day}T09:00:00Z`));await mockTasks(page,[task()]);
  await page.route("**/api/google/events**",route=>route.fulfill({json:{items:[]}}));await page.route("**/api/microsoft/events**",route=>route.fulfill({json:{items:[]}}));
  await page.goto("/");await page.getByRole("button",{name:"Diena",exact:true}).click();
  await expect(page.locator(".allDayDueTask").filter({hasText:"Google dienos užduotis"})).toBeVisible();
  const handle=page.locator(".taskCard").filter({hasText:"Google dienos užduotis"}).locator("em"),lane=page.locator(`.dayLane[data-day="${day}"]`),targetSlot=page.getByRole("button",{name:`${day} 10:00 – naujas įvykis`});
  const handleBox=await handle.boundingBox(),targetBox=await targetSlot.boundingBox();expect(handleBox).toBeTruthy();expect(targetBox).toBeTruthy();
  await page.mouse.move(handleBox!.x+handleBox!.width/2,handleBox!.y+handleBox!.height/2);await page.mouse.down();await page.mouse.move(targetBox!.x+targetBox!.width/2,targetBox!.y+targetBox!.height/2,{steps:8});
  await expect(lane.locator(".dropHint")).toBeVisible();await page.mouse.move(2,2);await page.mouse.up();await expect(page.locator(".dropHint")).toHaveCount(0);
  await page.getByRole("button",{name:"Mėnuo",exact:true}).click();await page.locator(".monthGrid span").filter({hasText:"Google dienos užduotis"}).click();
  await expect(page.getByRole("dialog",{name:"Užduotis ir jos planas"}).getByLabel("Pavadinimas")).toHaveValue("Google dienos užduotis");
});

test("cross-day task drag hides the source block and highlights only the target",async({page})=>{
  await page.clock.setFixedTime(new Date(`${day}T09:00:00Z`));await mockTasks(page,[task({title:"Perkeliama užduotis",due_date:null,scheduled_at:`${day}T08:00:00Z`})]);
  await page.route("**/api/google/events**",route=>route.fulfill({json:{items:[]}}));await page.route("**/api/microsoft/events**",route=>route.fulfill({json:{items:[]}}));
  await page.goto("/");
  const source=page.locator(".taskTime").filter({hasText:"Perkeliama užduotis"}),handle=source.locator(".taskBlockEdit"),target=page.locator('.dayLane[data-day="2026-09-24"]'),targetSlot=page.getByRole("button",{name:"2026-09-24 12:00 – naujas įvykis"});
  await handle.scrollIntoViewIfNeeded();const handleBox=await handle.boundingBox(),targetBox=await targetSlot.boundingBox();expect(handleBox).toBeTruthy();expect(targetBox).toBeTruthy();
  await page.mouse.move(handleBox!.x+handleBox!.width/2,handleBox!.y+10);await page.mouse.down();await page.mouse.move(targetBox!.x+targetBox!.width/2,targetBox!.y+targetBox!.height/2,{steps:8});
  await expect(source).toHaveCSS("opacity","0");await expect(target.locator(".dropHint")).toBeVisible();await expect(page.locator(".dropHint")).toHaveCount(1);
  await page.mouse.move(2,2);await page.mouse.up();await expect(source).toHaveCSS("opacity","1");await expect(page.locator(".dropHint")).toHaveCount(0);
});

test("dark theme keeps backup text readable and primary actions purple",async({page})=>{
  await mockTasks(page);await page.route("**/api/google/events**",route=>route.fulfill({json:{items:[]}}));await page.route("**/api/microsoft/events**",route=>route.fulfill({json:{items:[]}}));
  await page.goto("/");await page.getByRole("button",{name:"Nustatymai",exact:true}).click();await page.getByRole("button",{name:"Tamsi",exact:true}).click();await expect(page.locator("html")).toHaveAttribute("data-theme","dark");
  const backupButton=page.locator(".backupButtons .ghostButton").first();await expect(backupButton).toHaveCSS("background-color","rgb(26, 32, 48)");await expect(backupButton).toHaveCSS("color","rgb(231, 235, 245)");
  await page.getByRole("dialog",{name:"Nustatymai"}).getByRole("button",{name:"Uždaryti"}).click();
  await expect(page.getByRole("button",{name:"Naujas įvykis",exact:true})).toHaveCSS("background-color","rgb(101, 84, 217)");
});
