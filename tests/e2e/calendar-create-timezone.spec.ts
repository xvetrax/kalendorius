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
  await dialog.getByLabel("Trukmė").selectOption("60");await dialog.getByRole("button",{name:"Sukurti įvykį"}).click();await expect(dialog).toHaveCount(0);
  expect(submissions[0]).toEqual({provider:"google",body:expect.objectContaining({calendarId:"other/calendar",calendarVersion:"google-v1",summary:"Google zona",start:"2026-10-24T07:00:00.000Z",end:"2026-10-24T08:00:00.000Z",timeZone:"Europe/Vilnius"})});

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
