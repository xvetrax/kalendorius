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
  const event={id:"outlook-1",calendarId:"primary",provider:"outlook",connectionId:"connection-1",key:JSON.stringify(["outlook","connection-1","primary","outlook-1"]),version:'W/"v1"',summary:"Teams susitikimas",description:"<p>Teams susitikimo metaduomenys</p>",location:"Teams",hangoutLink:"https://teams.example.test/join",editable:true,readOnlyReason:"",attendeeCount:0,allDay:false,recurring:false,canRespond:false,showAs:"busy",visibility:"default",reminder:{mode:"minutes",minutes:15},timeZone:"UTC",start:{dateTime:"2026-09-23T10:00:00Z"},end:{dateTime:"2026-09-23T11:00:00Z"}};
  const submissions:Record<string,unknown>[]=[];
  await page.route("**/api/google/events**",route=>route.fulfill({json:{items:[]}}));
  await page.route("**/api/microsoft/events**",async route=>{
    if(route.request().method()==="PATCH"){
      const submitted=route.request().postDataJSON() as Record<string,unknown>;submissions.push(submitted);
      if("showAs" in submitted)event.showAs=String(submitted.showAs);if("visibility" in submitted)event.visibility=String(submitted.visibility);if("reminder" in submitted)event.reminder=submitted.reminder as typeof event.reminder;
      if("description" in submitted)event.description=String(submitted.description);if("location" in submitted)event.location=String(submitted.location);if("timeZone" in submitted)event.timeZone=String(submitted.timeZone);
      event.start={dateTime:String(submitted.start)};event.end={dateTime:String(submitted.end)};event.version=`W/"v${submissions.length+1}"`;
      await route.fulfill({json:event});
    }else await route.fulfill({json:{items:[event]}});
  });
  await page.goto("/");await page.getByRole("button",{name:"Diena",exact:true}).click();
  await page.getByRole("button",{name:"Redaguoti įvykį: Teams susitikimas"}).click();
  await page.getByLabel("Laisvas / užimtas").selectOption("oof");
  await page.getByLabel("Matomumas").selectOption("personal");
  await page.getByLabel("Priminimas").selectOption("minutes:60");
  await page.getByLabel("Laiko zona").selectOption("Europe/Vilnius");
  await page.getByRole("button",{name:"Išsaugoti įvykį"}).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(submissions[0]).toMatchObject({id:"outlook-1",calendarId:"primary",connectionId:"connection-1",version:'W/"v1"',start:"2026-09-23T07:00:00.000Z",end:"2026-09-23T08:00:00.000Z",timeZone:"Europe/Vilnius",showAs:"oof",visibility:"personal",reminder:{mode:"minutes",minutes:60}});
  expect(submissions[0]).not.toHaveProperty("summary");expect(submissions[0]).not.toHaveProperty("description");expect(submissions[0]).not.toHaveProperty("location");
  await page.getByRole("button",{name:"Redaguoti įvykį: Teams susitikimas"}).click();
  await page.getByLabel("Aprašymas").fill("");await page.getByLabel("Vieta").fill("");
  await page.getByRole("button",{name:"Išsaugoti įvykį"}).click();await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(submissions[1]).toMatchObject({version:'W/"v2"',start:"2026-09-23T07:00:00.000Z",end:"2026-09-23T08:00:00.000Z",description:"",location:""});expect(submissions[1]).not.toHaveProperty("summary");expect(submissions[1]).not.toHaveProperty("timeZone");
});

test("all-day editor sends inclusive UI dates as an exclusive provider range",async({page})=>{
  await page.clock.setFixedTime(new Date("2026-09-23T09:00:00Z"));
  const event={id:"all-day-1",calendarId:"primary",provider:"google",connectionId:"connection-1",key:JSON.stringify(["google","connection-1","primary","all-day-1"]),version:'"v1"',summary:"Kelių dienų renginys",editable:true,readOnlyReason:"",attendeeCount:0,allDay:true,recurring:false,canRespond:false,showAs:"busy",visibility:"default",reminder:{mode:"default"},start:{date:"2026-09-23"},end:{date:"2026-09-25"}};
  let submitted:Record<string,unknown>|null=null;
  await page.route("**/api/google/events**",async route=>{
    if(route.request().method()==="PATCH"){submitted=route.request().postDataJSON() as Record<string,unknown>;event.start={date:String(submitted.start)};event.end={date:String(submitted.end)};event.version='"v2"';await route.fulfill({json:event});}
    else await route.fulfill({json:{items:[event]}});
  });
  await page.goto("/");await page.getByRole("button",{name:"Diena",exact:true}).click();
  await page.locator(".allDayEvent").filter({hasText:"Kelių dienų renginys"}).click();
  await expect(page.getByLabel("Pirma diena")).toHaveValue("2026-09-23");await expect(page.getByLabel("Paskutinė diena")).toHaveValue("2026-09-24");
  await page.getByLabel("Pirma diena").fill("2026-09-24");await page.getByLabel("Paskutinė diena").fill("2026-09-26");
  await page.getByRole("button",{name:"Išsaugoti įvykį"}).click();await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(submitted).toMatchObject({id:"all-day-1",calendarId:"primary",connectionId:"connection-1",version:'"v1"',allDay:true,start:"2026-09-24",end:"2026-09-27"});
});

test("recurring occurrence edits the master rule with the master version",async({page})=>{
  await page.clock.setFixedTime(new Date("2026-09-23T09:00:00Z"));
  const event={id:"occurrence-1",seriesId:"series-1",calendarId:"primary",provider:"google",connectionId:"connection-1",key:JSON.stringify(["google","connection-1","primary","occurrence-1"]),version:'"occurrence-v1"',summary:"Kartojamas susitikimas",editable:true,readOnlyReason:"",attendeeCount:0,allDay:false,recurring:true,canRespond:false,showAs:"busy",visibility:"default",reminder:{mode:"default"},timeZone:"Europe/Vilnius",start:{dateTime:"2026-09-23T10:00:00Z"},end:{dateTime:"2026-09-23T11:00:00Z"}};
  let submitted:Record<string,unknown>|null=null;
  await page.route("**/api/google/events**",async route=>{
    const request=route.request(),url=new URL(request.url());
    if(request.method()==="GET"&&url.searchParams.has("seriesId"))return route.fulfill({json:{seriesId:"series-1",version:'"master-v1"',startDate:"2026-09-23",supported:true,recurrence:{frequency:"weekly",interval:1,days_of_week:["wednesday"],end:{type:"never"}}}});
    if(request.method()==="PATCH"&&(request.postDataJSON() as Record<string,unknown>).scope==="series"){submitted=request.postDataJSON() as Record<string,unknown>;return route.fulfill({json:{seriesId:"series-1",version:'"master-v2"',startDate:"2026-09-23",supported:true,recurrence:submitted.recurrence}});}
    return route.fulfill({json:{items:[event]}});
  });
  await page.goto("/");await page.getByRole("button",{name:"Diena",exact:true}).click();await page.getByRole("button",{name:"Redaguoti įvykį: Kartojamas susitikimas"}).click();
  const dialog=page.getByRole("dialog",{name:"Kalendoriaus įvykis"});await expect(dialog.getByText("Visa serija",{exact:true})).toBeVisible();await dialog.getByLabel("Įvykio kartojimo dažnis").selectOption("monthly");await dialog.getByLabel("Įvykio kartojimo intervalas").fill("2");await dialog.getByRole("button",{name:"Išsaugoti visos serijos taisyklę"}).click();
  await expect(dialog).toHaveCount(0);expect(submitted).toMatchObject({scope:"series",seriesId:"series-1",calendarId:"primary",connectionId:"connection-1",version:'"master-v1"',recurrence:{frequency:"monthly",interval:2,day_of_month:23,end:{type:"never"}}});
});
