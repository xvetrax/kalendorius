import {expect,test} from "@playwright/test";

test("Google and Outlook events convert between timed and all-day modes",async({page})=>{
  await page.clock.setFixedTime(new Date("2026-09-23T09:00:00Z"));
  const googleEvent:any={id:"google-convert",calendarId:"primary",provider:"google",connectionId:"google-connection",key:JSON.stringify(["google","google-connection","primary","google-convert"]),version:'"g1"',summary:"Google konvertavimas",editable:true,readOnlyReason:"",attendeeCount:0,allDay:false,recurring:false,canRespond:false,showAs:"busy",visibility:"default",reminder:{mode:"default"},timeZone:"Europe/Vilnius",start:{dateTime:"2026-09-23T10:00:00Z"},end:{dateTime:"2026-09-23T11:00:00Z"}};
  const outlookEvent:any={id:"outlook-convert",calendarId:"primary",provider:"outlook",connectionId:"outlook-connection",key:JSON.stringify(["outlook","outlook-connection","primary","outlook-convert"]),version:'W/"o1"',summary:"Outlook konvertavimas",editable:true,readOnlyReason:"",attendeeCount:0,allDay:true,recurring:false,canRespond:false,showAs:"free",visibility:"default",reminder:{mode:"none"},start:{date:"2026-09-24"},end:{date:"2026-09-26"}};
  let googleSubmission:Record<string,unknown>|null=null,outlookSubmission:Record<string,unknown>|null=null;
  await page.route("**/api/google/events**",async route=>{
    if(route.request().method()==="PATCH"){const submitted=route.request().postDataJSON() as Record<string,unknown>;googleSubmission=submitted;Object.assign(googleEvent,{version:'"g2"',allDay:true,start:{date:String(submitted.start)},end:{date:String(submitted.end)}});delete googleEvent.timeZone;await route.fulfill({json:googleEvent});}
    else await route.fulfill({json:{items:[googleEvent]}});
  });
  await page.route("**/api/microsoft/events**",async route=>{
    if(route.request().method()==="PATCH"){const submitted=route.request().postDataJSON() as Record<string,unknown>;outlookSubmission=submitted;Object.assign(outlookEvent,{version:'W/"o2"',allDay:false,timeZone:String(submitted.timeZone),start:{dateTime:String(submitted.start)},end:{dateTime:String(submitted.end)}});await route.fulfill({json:outlookEvent});}
    else await route.fulfill({json:{items:[outlookEvent]}});
  });
  await page.goto("/");

  await page.getByRole("button",{name:"Redaguoti įvykį: Google konvertavimas"}).click();
  let dialog=page.getByRole("dialog",{name:"Kalendoriaus įvykis"});await dialog.getByLabel("Visos dienos įvykis").check();
  await expect(dialog.getByLabel("Pirma diena")).toHaveValue("2026-09-23");await expect(dialog.getByLabel("Paskutinė diena")).toHaveValue("2026-09-23");
  await dialog.getByRole("button",{name:"Išsaugoti įvykį"}).click();await expect(dialog).toHaveCount(0);
  expect(googleSubmission).toMatchObject({id:"google-convert",version:'"g1"',allDay:true,start:"2026-09-23",end:"2026-09-24"});expect(googleSubmission).not.toHaveProperty("timeZone");

  await page.locator(".allDayEvent").filter({hasText:"Outlook konvertavimas"}).first().click();dialog=page.getByRole("dialog",{name:"Kalendoriaus įvykis"});await dialog.getByLabel("Visos dienos įvykis").uncheck();
  await expect(dialog.getByLabel("Pradžia")).toHaveValue("2026-09-24T09:00");await expect(dialog.getByLabel("Pabaiga")).toHaveValue("2026-09-24T10:00");await expect(dialog.getByLabel("Laiko zona")).toHaveValue("UTC");
  await dialog.getByRole("button",{name:"Išsaugoti įvykį"}).click();await expect(dialog).toHaveCount(0);
  expect(outlookSubmission).toMatchObject({id:"outlook-convert",version:'W/"o1"',allDay:false,start:"2026-09-24T09:00:00.000Z",end:"2026-09-24T10:00:00.000Z",timeZone:"UTC"});
});
