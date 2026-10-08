import {expect,test} from "@playwright/test";

test("Mano diena sujungia kalendorių, terminus, laisvus tarpus ir paskyrų kilmę",async({page})=>{
  await page.clock.setFixedTime(new Date("2026-10-07T05:00:00.000Z"));
  const scheduled="2026-10-07T10:30:00.000Z";
  await page.route("**/api/tasks?envelope=1",route=>route.fulfill({json:{items:[
    {id:1,key:"local:1",source:"local",title:"Paruošti pasiūlymą",notes:"",due_at:null,scheduled_at:scheduled,duration_minutes:60,completed:0,project:"Darbas",priority:"high",tags:"",energy:"medium",schedule_version:0,legacy_schedule:0,mirror_requested:0,mirror_event_id:null,mirror_account_id:null,mirror_connection_id:null,mirror_error:null},
    {id:"g-1",key:"google:g:list:g-1",source:"google",account_id:"g",list_id:"list",list_name:"Mano užduotys",title:"Apmokėti sąskaitą",notes:"",due_date:"2026-10-07",due_at:null,scheduled_at:null,duration_minutes:30,completed:0,project:"Asmeniniai",priority:"normal",tags:"",energy:"medium",schedule_version:0,legacy_schedule:0,mirror_requested:0,mirror_event_id:null,mirror_account_id:null,mirror_connection_id:null,mirror_error:null,readonly_reason:"Šis sąrašas rodomas tik skaitymui."},
  ],warnings:[],lists:[],cleanups:[]}}));
  const event={id:"meeting",key:"google:work:primary:meeting",provider:"google",connectionId:"work",calendarId:"primary",calendarName:"Darbo kalendorius",accountLabel:"darbas@example.test",summary:"Komandos susitikimas",start:{dateTime:"2026-10-07T07:00:00.000Z"},end:{dateTime:"2026-10-07T08:00:00.000Z"},allDay:false,editable:true,readOnlyReason:"",attendeeCount:0,recurring:false,canRespond:false,showAs:"busy",visibility:"default",reminder:{mode:"default"}};
  await page.route("**/api/google/events**",route=>route.fulfill({json:{items:[event],loadedConnectionIds:["work"],activeConnectionIds:["work"]}}));
  await page.route("**/api/microsoft/events**",route=>route.fulfill({json:{items:[],loadedConnectionIds:[],activeConnectionIds:[]}}));
  await page.goto("/");
  await page.getByRole("button",{name:"Mano diena",exact:true}).click();
  await expect(page.getByRole("heading",{name:/spalio 7/})).toBeVisible();
  await expect(page.getByRole("textbox",{name:"Filtruoti dabartinį rodinį"})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Atidaryti komandų paletę"})).toBeVisible();
  await expect(page.getByText("Komandos susitikimas",{exact:true})).toBeVisible();
  await expect(page.getByText(/darbas@example\.test/)).toBeVisible();
  const myDay=page.locator(".myDay");
  await expect(myDay.getByText("Paruošti pasiūlymą",{exact:true})).toBeVisible();
  await expect(myDay.getByText("Apmokėti sąskaitą",{exact:true})).toBeVisible();
  await expect(myDay.getByText("Šis sąrašas rodomas tik skaitymui.",{exact:true})).toBeVisible();
  await expect(myDay.getByRole("button",{name:"Pažymėti atlikta: Apmokėti sąskaitą"})).toBeDisabled();
  await expect(page.getByText("LAISVI TARPAI",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:/Planuoti dieną/})).toBeVisible();
});

test("komandų paletė valdoma klaviatūra ir atidaro greitą įvedimą",async({page})=>{
  await page.goto("/");
  await page.keyboard.press("Control+K");
  const palette=page.getByRole("dialog",{name:"Komandų paletė"});
  await expect(palette).toBeVisible();
  const search=palette.getByLabel("Ieškoti komandų, užduočių ir įvykių");
  await expect(search).toBeFocused();
  await search.fill("Nauja užduotis");
  await search.press("Enter");
  await expect(page.getByRole("dialog",{name:"Nauja užduotis"})).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog",{name:"Nauja užduotis"})).toHaveCount(0);
  await page.keyboard.press("Control+Shift+A");
  await expect(page.getByRole("dialog",{name:"Nauja užduotis"})).toBeVisible();
});

test("šoninis greitas įvedimas parodo parserio peržiūrą ir aiškų tikslą prieš POST",async({page})=>{
  await page.clock.setFixedTime(new Date("2026-10-07T07:00:00.000Z"));
  await page.goto("/");
  await page.locator(".filters").getByRole("button",{name:"Darbas",exact:true}).click();
  const input=page.locator('input[placeholder*="Pridėti"]');
  await input.fill("Paruošti ataskaitą rytoj 14:30 45 min");
  await input.press("Enter");
  const dialog=page.getByRole("dialog",{name:"Nauja užduotis"});
  await expect(dialog.locator(".quickParseSummary")).toContainText("45 min.");
  await expect(dialog.getByLabel("Pavadinimas")).toHaveValue("Paruošti ataskaitą");
  await expect(dialog.getByLabel("Trukmė, min.")).toHaveValue("45");
  await expect(dialog.getByLabel("Planuojamas darbo laikas")).toHaveValue("2026-10-08T14:30");
  await expect(dialog.getByLabel("Projektas")).toHaveValue("Darbas");
  await expect(dialog.getByText(/Pasirinkta:.*Vietinė paskyra/)).toBeVisible();
  const requestPromise=page.waitForRequest(request=>request.url().endsWith("/api/tasks")&&request.method()==="POST");
  await dialog.getByRole("button",{name:"Sukurti",exact:true}).click();
  const body=(await requestPromise).postDataJSON();
  expect(body).toMatchObject({title:"Paruošti ataskaitą",duration_minutes:45,project:"Darbas",source:"local"});
  expect(new Date(body.scheduled_at).toISOString()).toBe("2026-10-08T11:30:00.000Z");
});

test("Mano diena po vidurnakčio pati užkrauna naujos dienos intervalą",async({page})=>{
  await page.clock.install({time:new Date("2026-10-07T20:59:30.000Z")});
  const ranges:string[]=[];
  await page.route("**/api/google/events**",route=>{
    ranges.push(new URL(route.request().url()).searchParams.get("timeMin")||"");
    return route.fulfill({json:{items:[],loadedConnectionIds:[],activeConnectionIds:[]}});
  });
  await page.route("**/api/microsoft/events**",route=>route.fulfill({json:{items:[],loadedConnectionIds:[],activeConnectionIds:[]}}));
  await page.goto("/");
  await page.getByRole("button",{name:"Mano diena",exact:true}).click();
  await expect.poll(()=>ranges.length).toBeGreaterThan(1);
  const before=ranges.at(-1);
  await page.clock.runFor(61_000);
  await expect.poll(()=>ranges.at(-1)).not.toBe(before);
  expect(new Date(ranges.at(-1)!).getTime()-new Date(before!).getTime()).toBe(24*60*60*1000);
  await expect.poll(()=>page.evaluate(async()=>{
    const request=indexedDB.open("dienos-planas-offline",1);
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const metaRequest=db.transaction("meta","readonly").objectStore("meta").get("active-user");
    const meta=await new Promise<{value?:string}|undefined>((resolve,reject)=>{metaRequest.onsuccess=()=>resolve(metaRequest.result);metaRequest.onerror=()=>reject(metaRequest.error);});
    if(!meta?.value){db.close();return null;}
    const snapshotRequest=db.transaction("snapshots","readonly").objectStore("snapshots").get(meta.value);
    const snapshot=await new Promise<{day?:string}|undefined>((resolve,reject)=>{snapshotRequest.onsuccess=()=>resolve(snapshotRequest.result);snapshotRequest.onerror=()=>reject(snapshotRequest.error);});
    db.close();return snapshot?.day||null;
  })).toBe("2026-10-08");
});

test("išsaugojimo metu Escape neuždaro greito įvedimo ir nesukuria dublikato",async({page})=>{
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let writes=0;
  await page.route("**/api/tasks",async route=>{
    if(route.request().method()!=="POST")return route.continue();
    writes+=1;
    await gate;
    await route.continue();
  });
  await page.goto("/");
  const title=`Lėtas išsaugojimas ${Date.now()}`;
  const input=page.locator('input[placeholder*="Pridėti"]');
  await input.fill(title);
  await input.press("Enter");
  const dialog=page.getByRole("dialog",{name:"Nauja užduotis"});
  const request=page.waitForRequest(value=>value.url().endsWith("/api/tasks")&&value.method()==="POST");
  await dialog.getByRole("button",{name:"Sukurti",exact:true}).click();
  await request;
  await expect(dialog.getByRole("button",{name:"Saugoma…",exact:true})).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Pavadinimas")).toHaveValue(title);
  release();
  await expect(dialog).toHaveCount(0);
  expect(writes).toBe(1);
});
