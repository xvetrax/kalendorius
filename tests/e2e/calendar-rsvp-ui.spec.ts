import {test,expect} from "@playwright/test";

test("invited attendee can submit and reload a Google RSVP",async({page})=>{
  await page.clock.setFixedTime(new Date("2026-09-23T09:00:00Z"));
  const event={id:"invite-1",calendarId:"primary",provider:"google",connectionId:"connection-1",key:JSON.stringify(["google","connection-1","primary","invite-1"]),version:'"v1"',summary:"Komandos aptarimas",editable:false,readOnlyReason:"Šiame etape redaguojami tik tavo organizuojami įvykiai.",attendeeCount:2,attendees:[{email:"me@example.test",self:true,responseStatus:"needsAction"},{email:"host@example.test",responseStatus:"accepted"}],allDay:false,recurring:false,canRespond:true,responseStatus:"needsAction",start:{dateTime:"2026-09-23T10:00:00Z"},end:{dateTime:"2026-09-23T11:00:00Z"}};
  let submitted:Record<string,unknown>|null=null;
  await page.route("**/api/google/events**",async route=>{
    if(route.request().method()==="PUT"){
      const body=route.request().postDataJSON() as Record<string,unknown>;submitted=body;event.responseStatus=String(body.responseStatus);event.version='"v2"';
      await route.fulfill({json:{ok:true,responseStatus:event.responseStatus}});
    }else await route.fulfill({json:{items:[event]}});
  });
  await page.goto("/");await page.getByRole("button",{name:"Diena",exact:true}).click();
  await page.getByRole("button",{name:"Redaguoti įvykį: Komandos aptarimas"}).click();
  await expect(page.getByRole("group",{name:"Dalyvavimo atsakymas"})).toContainText("Dar neatsakyta");
  await page.getByRole("button",{name:"Galbūt",exact:true}).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(submitted).toEqual({id:"invite-1",calendarId:"primary",connectionId:"connection-1",version:'"v1"',responseStatus:"tentative"});
  await page.getByRole("button",{name:"Redaguoti įvykį: Komandos aptarimas"}).click();
  await expect(page.getByRole("group",{name:"Dalyvavimo atsakymas"})).toContainText("Galbūt dalyvausi");
  await expect(page.getByRole("button",{name:"Galbūt",exact:true})).toHaveAttribute("aria-pressed","true");
});
