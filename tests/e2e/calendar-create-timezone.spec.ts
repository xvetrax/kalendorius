import {expect,test} from "@playwright/test";

test("new Google and Outlook events keep wall time in the selected timezone",async({page})=>{
  await page.clock.setFixedTime(new Date("2026-09-25T09:00:00Z"));
  const submissions:{provider:"google"|"outlook";body:Record<string,unknown>}[]=[];
  await page.route("**/api/google/status",route=>route.fulfill({json:{connected:true,configured:true,account:"google@example.test",tasksConnected:false,tasksStatus:"permission_required"}}));
  await page.route("**/api/microsoft/status",route=>route.fulfill({json:{connected:true,configured:true,account:"outlook@example.test"}}));
  await page.route("**/api/google/calendars",route=>route.fulfill({json:{items:[{id:"primary",name:"Google pagrindinis",primary:true,writable:true},{id:"other/calendar",name:"Google komanda",writable:true},{id:"readonly",name:"Google tik skaityti",writable:false}],enabled:["primary","other/calendar"],version:"google-v1"}}));
  await page.route("**/api/microsoft/calendars",route=>route.fulfill({json:{items:[{id:"primary",name:"Outlook pagrindinis",isDefault:true,writable:true},{id:"other/calendar",name:"Outlook komanda",writable:true},{id:"readonly",name:"Outlook tik skaityti",writable:false}],enabled:["primary","other/calendar"],version:"microsoft-v1"}}));
  await page.route("**/api/google/events**",async route=>{
    if(route.request().method()==="POST"){submissions.push({provider:"google",body:route.request().postDataJSON()});await route.fulfill({status:201,json:{id:"google-created"}});}
    else await route.fulfill({json:{items:[]}});
  });
  await page.route("**/api/microsoft/events**",async route=>{
    if(route.request().method()==="POST"){submissions.push({provider:"outlook",body:route.request().postDataJSON()});await route.fulfill({status:201,json:{id:"outlook-created"}});}
    else await route.fulfill({json:{items:[]}});
  });
  await page.goto("/");

  await page.getByRole("button",{name:"Naujas įvykis",exact:true}).click();
  let dialog=page.getByRole("dialog",{name:"Naujas įvykis"});
  await dialog.getByLabel("Paskyra").selectOption("google");await dialog.getByLabel("Kalendorius").selectOption("other/calendar");await expect(dialog.getByLabel("Kalendorius").locator('option[value="readonly"]')).toHaveCount(0);await dialog.getByLabel("Pavadinimas").fill("Google zona");
  await dialog.getByLabel("Pradžia").fill("2026-10-24T10:00");await dialog.getByLabel("Laiko zona").selectOption("Europe/Vilnius");await expect(dialog.getByLabel("Pradžia")).toHaveValue("2026-10-24T10:00");
  await dialog.getByLabel("Kartoti įvykį").check();await dialog.getByLabel("Įvykio kartojimo intervalas").fill("2");await dialog.getByLabel("Įvykio kartojimo pabaiga").selectOption("count");await dialog.getByLabel("Kartojamų įvykių skaičius").fill("5");
  await dialog.getByLabel("Trukmė").selectOption("60");await dialog.getByRole("button",{name:"Sukurti įvykį"}).click();await expect(dialog).toHaveCount(0);
  expect(submissions[0]).toEqual({provider:"google",body:expect.objectContaining({calendarId:"other/calendar",calendarVersion:"google-v1",summary:"Google zona",start:"2026-10-24T07:00:00.000Z",end:"2026-10-24T08:00:00.000Z",timeZone:"Europe/Vilnius",operationId:expect.stringMatching(/^[0-9a-f-]{36}$/),recurrence:{frequency:"daily",interval:2,end:{type:"count",count:5}}})});

  await page.getByRole("button",{name:"Naujas įvykis",exact:true}).click();dialog=page.getByRole("dialog",{name:"Naujas įvykis"});
  await dialog.getByLabel("Paskyra").selectOption("outlook");await dialog.getByLabel("Kalendorius").selectOption("other/calendar");await dialog.getByLabel("Pavadinimas").fill("Outlook zona");
  await dialog.getByLabel("Pradžia").fill("2026-10-24T10:00");await dialog.getByLabel("Laiko zona").selectOption("Europe/London");await expect(dialog.getByLabel("Pradžia")).toHaveValue("2026-10-24T10:00");
  await dialog.getByRole("button",{name:"Sukurti įvykį"}).click();await expect(dialog).toHaveCount(0);
  expect(submissions[1]).toEqual({provider:"outlook",body:expect.objectContaining({calendarId:"other/calendar",calendarVersion:"microsoft-v1",summary:"Outlook zona",start:"2026-10-24T09:00:00.000Z",end:"2026-10-24T09:30:00.000Z",timeZone:"Europe/London"})});
});

test("new event stays disabled when the explicit calendar selection is empty",async({page})=>{
  await page.route("**/api/google/status",route=>route.fulfill({json:{connected:true,configured:true,account:"google@example.test",tasksConnected:false,tasksStatus:"permission_required"}}));
  await page.route("**/api/microsoft/status",route=>route.fulfill({json:{connected:false,configured:true,account:null}}));
  await page.route("**/api/google/calendars",route=>route.fulfill({json:{items:[{id:"primary",name:"Google pagrindinis",primary:true,writable:true}],enabled:[],version:"google-v1"}}));
  await page.route("**/api/google/events**",route=>route.fulfill({json:{items:[]}}));
  await page.goto("/");
  await page.getByRole("button",{name:"Naujas įvykis",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Naujas įvykis"});
  await expect(dialog.getByText(/nepasirinktas rašomas kalendorius/)).toBeVisible();
  await expect(dialog.getByRole("button",{name:"Sukurti įvykį"})).toBeDisabled();
});

test("expired calendar session is shown in settings instead of crashing the page",async({page})=>{
  const pageErrors:string[]=[];page.on("pageerror",error=>pageErrors.push(error.message));
  await page.route("**/api/google/status",route=>route.fulfill({json:{connected:true,configured:true,account:"google@example.test",tasksConnected:false,tasksStatus:"permission_required"}}));
  await page.route("**/api/microsoft/status",route=>route.fulfill({json:{connected:false,configured:true,account:null}}));
  await page.route("**/api/google/calendars",route=>route.fulfill({status:401,json:{error:"Google sesija baigėsi. Atjunk ir vėl prijunk paskyrą."}}));
  await page.route("**/api/google/events**",route=>route.fulfill({status:401,json:{error:"Google sesija baigėsi."}}));
  await page.route("**/api/microsoft/events**",route=>route.fulfill({json:{items:[]}}));
  await page.goto("/");await page.getByRole("button",{name:"Nustatymai",exact:true}).click();
  const settings=page.getByRole("dialog",{name:"Nustatymai"});
  await expect(settings.getByRole("alert")).toContainText("Google sesija baigėsi. Atjunk ir vėl prijunk paskyrą.");
  await expect(settings).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("event create keeps one operation ID when fields change after an uncertain response",async({page})=>{
  const submissions:Record<string,unknown>[]=[];
  await page.route("**/api/google/status",route=>route.fulfill({json:{connected:true,configured:true,account:"google@example.test",tasksConnected:false,tasksStatus:"permission_required"}}));
  await page.route("**/api/microsoft/status",route=>route.fulfill({json:{connected:false,configured:true,account:null}}));
  await page.route("**/api/google/calendars",route=>route.fulfill({json:{items:[{id:"primary",name:"Google pagrindinis",primary:true,writable:true}],enabled:["primary"],version:"google-v1"}}));
  await page.route("**/api/google/events**",async route=>{
    if(route.request().method()==="POST"){submissions.push(route.request().postDataJSON() as Record<string,unknown>);return submissions.length===1?route.fulfill({status:502,json:{error:"Atsakymas neaiškus."}}):route.fulfill({status:201,json:{id:"created"}});}
    return route.fulfill({json:{items:[]}});
  });
  await page.goto("/");await page.getByRole("button",{name:"Naujas įvykis",exact:true}).click();const dialog=page.getByRole("dialog",{name:"Naujas įvykis"});await dialog.getByLabel("Pavadinimas").fill("Pirmas payload");await dialog.getByRole("button",{name:"Sukurti įvykį"}).click();await expect(dialog.getByRole("alert")).toContainText("Atsakymas neaiškus");
  await dialog.getByLabel("Pavadinimas").fill("Pakeistas payload");await dialog.getByRole("button",{name:"Sukurti įvykį"}).click();await expect(dialog).toHaveCount(0);expect(submissions).toHaveLength(2);expect(submissions[1].operationId).toBe(submissions[0].operationId);expect(submissions[1].summary).not.toBe(submissions[0].summary);
});
