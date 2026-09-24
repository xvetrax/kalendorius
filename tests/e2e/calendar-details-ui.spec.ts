import {test,expect} from "@playwright/test";

test("timed Google event details are sent with identity and version",async({page})=>{
  await page.clock.setFixedTime(new Date("2026-09-23T09:00:00Z"));
  const event={id:"detail-1",calendarId:"primary",provider:"google",connectionId:"connection-1",key:JSON.stringify(["google","connection-1","primary","detail-1"]),version:'"v1"',summary:"Detalus įvykis",editable:true,readOnlyReason:"",attendeeCount:0,allDay:false,recurring:false,canRespond:false,showAs:"busy",visibility:"default",reminder:{mode:"default"},start:{dateTime:"2026-09-23T10:00:00Z"},end:{dateTime:"2026-09-23T11:00:00Z"}};
  let submitted:Record<string,unknown>|null=null;
  await page.route("**/api/google/events**",async route=>{
    if(route.request().method()==="PATCH"){
      submitted=route.request().postDataJSON() as Record<string,unknown>;
      Object.assign(event,{version:'"v2"',showAs:submitted.showAs,visibility:submitted.visibility,reminder:submitted.reminder});
      await route.fulfill({json:event});
    }else await route.fulfill({json:{items:[event]}});
  });
  await page.goto("/");await page.getByRole("button",{name:"Diena",exact:true}).click();
  await page.getByRole("button",{name:"Redaguoti įvykį: Detalus įvykis"}).click();
  await page.getByLabel("Laisvas / užimtas").selectOption("free");
  await page.getByLabel("Matomumas").selectOption("private");
  await page.getByLabel("Priminimas").selectOption("minutes:30");
  await page.getByRole("button",{name:"Išsaugoti įvykį"}).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(submitted).toMatchObject({id:"detail-1",calendarId:"primary",connectionId:"connection-1",version:'"v1"',showAs:"free",visibility:"private",reminder:{mode:"minutes",minutes:30}});
});

test("custom Google reminder survives an unrelated edit",async({page})=>{
  await page.clock.setFixedTime(new Date("2026-09-23T09:00:00Z"));
  const event={id:"custom-1",calendarId:"primary",provider:"google",connectionId:"connection-1",key:JSON.stringify(["google","connection-1","primary","custom-1"]),version:'"v1"',summary:"Sudėtingas priminimas",editable:true,readOnlyReason:"",attendeeCount:0,allDay:false,recurring:false,canRespond:false,showAs:"busy",visibility:"default",reminder:{mode:"custom"},start:{dateTime:"2026-09-23T12:00:00Z"},end:{dateTime:"2026-09-23T13:00:00Z"}};
  let submitted:Record<string,unknown>|null=null;
  await page.route("**/api/google/events**",async route=>{
    if(route.request().method()==="PATCH"){submitted=route.request().postDataJSON() as Record<string,unknown>;event.summary=String(submitted.summary);event.version='"v2"';await route.fulfill({json:event});}
    else await route.fulfill({json:{items:[event]}});
  });
  await page.goto("/");await page.getByRole("button",{name:"Diena",exact:true}).click();
  await page.getByRole("button",{name:"Redaguoti įvykį: Sudėtingas priminimas"}).click();
  await page.getByLabel("Pavadinimas").fill("Atnaujintas įvykis");
  await page.getByRole("button",{name:"Išsaugoti įvykį"}).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(submitted).toMatchObject({summary:"Atnaujintas įvykis"});expect(submitted).not.toHaveProperty("reminder");
});

test("Outlook details use provider controls without rewriting unchanged Teams metadata",async({page})=>{
  await page.clock.setFixedTime(new Date("2026-09-23T09:00:00Z"));
  const event={id:"outlook-1",calendarId:"primary",provider:"outlook",connectionId:"connection-1",key:JSON.stringify(["outlook","connection-1","primary","outlook-1"]),version:'W/"v1"',summary:"Teams susitikimas",description:"<p>Teams susitikimo metaduomenys</p>",location:"Teams",hangoutLink:"https://teams.example.test/join",editable:true,readOnlyReason:"",attendeeCount:0,allDay:false,recurring:false,canRespond:false,showAs:"busy",visibility:"default",reminder:{mode:"minutes",minutes:15},start:{dateTime:"2026-09-23T10:00:00Z"},end:{dateTime:"2026-09-23T11:00:00Z"}};
  const submissions:Record<string,unknown>[]=[];
  await page.route("**/api/google/events**",route=>route.fulfill({json:{items:[]}}));
  await page.route("**/api/microsoft/events**",async route=>{
    if(route.request().method()==="PATCH"){
      const submitted=route.request().postDataJSON() as Record<string,unknown>;submissions.push(submitted);
      if("showAs" in submitted)event.showAs=String(submitted.showAs);if("visibility" in submitted)event.visibility=String(submitted.visibility);if("reminder" in submitted)event.reminder=submitted.reminder as typeof event.reminder;
      if("description" in submitted)event.description=String(submitted.description);if("location" in submitted)event.location=String(submitted.location);event.version=`W/"v${submissions.length+1}"`;
      await route.fulfill({json:event});
    }else await route.fulfill({json:{items:[event]}});
  });
  await page.goto("/");await page.getByRole("button",{name:"Diena",exact:true}).click();
  await page.getByRole("button",{name:"Redaguoti įvykį: Teams susitikimas"}).click();
  await page.getByLabel("Laisvas / užimtas").selectOption("oof");
  await page.getByLabel("Matomumas").selectOption("personal");
  await page.getByLabel("Priminimas").selectOption("minutes:60");
  await page.getByRole("button",{name:"Išsaugoti įvykį"}).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(submissions[0]).toMatchObject({id:"outlook-1",calendarId:"primary",connectionId:"connection-1",version:'W/"v1"',showAs:"oof",visibility:"personal",reminder:{mode:"minutes",minutes:60}});
  expect(submissions[0]).not.toHaveProperty("summary");expect(submissions[0]).not.toHaveProperty("description");expect(submissions[0]).not.toHaveProperty("location");
  await page.getByRole("button",{name:"Redaguoti įvykį: Teams susitikimas"}).click();
  await page.getByLabel("Aprašymas").fill("");await page.getByLabel("Vieta").fill("");
  await page.getByRole("button",{name:"Išsaugoti įvykį"}).click();await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(submissions[1]).toMatchObject({version:'W/"v2"',description:"",location:""});expect(submissions[1]).not.toHaveProperty("summary");
});
