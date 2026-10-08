import {expect,test} from "@playwright/test";

test("Microsoft steps use versioned task identity for add, toggle and delete",async({page})=>{
  const task={id:"task-1",key:'["microsoft","microsoft-account","list-a","task-1"]',source:"microsoft",account_id:"microsoft-account",list_id:"list-a",list_name:"Darbai",title:"Užduotis su žingsniais",notes:"",completed:0,due_at:null,scheduled_at:null,duration_minutes:30,mirror_requested:0,mirror_event_id:null,mirror_error:null,project:"Microsoft To Do",priority:"normal",energy:"medium",tags:"",schedule_version:0,legacy_schedule:0};
  let items=[{id:"step-a",displayName:"Paruošti",isChecked:false}],version=1;
  const mutations:{method:string;body:any}[]=[];
  await page.route("**/api/tasks?envelope=1",route=>route.fulfill({json:{items:[task],warnings:[],lists:[],cleanups:[]}}));
  await page.route("**/api/microsoft/events**",route=>route.fulfill({json:{items:[]}}));
  await page.route("**/api/google/events**",route=>route.fulfill({json:{items:[]}}));
  await page.route("**/api/tasks/reminder**",route=>route.fulfill({json:{enabled:false,at:null,source_time:null,version:"reminder-v1",recurring:false}}));
  await page.route("**/api/tasks/recurrence**",route=>route.fulfill({json:{recurrence:null,supported:true,suggested_start_date:"2026-09-23",version:"recurrence-v1"}}));
  await page.route("**/api/tasks/steps**",async route=>{
    const method=route.request().method();
    if(method==="GET")return route.fulfill({json:{items,version:`steps-v${version}`}});
    const body=route.request().postDataJSON();mutations.push({method,body});
    if(method==="PATCH")items=items.map(item=>item.id===body.step_id?{...item,isChecked:body.isChecked}:item);
    if(method==="POST")items=[...items,{id:"step-b",displayName:body.displayName,isChecked:false}];
    if(method==="DELETE")items=items.filter(item=>item.id!==body.step_id);
    version+=1;await route.fulfill({status:method==="POST"?201:200,json:{items,version:`steps-v${version}`}});
  });
  await page.goto("/");
  await page.locator(".taskCard").filter({hasText:task.title}).locator(".taskDetailsButton").click();
  const editor=page.getByRole("dialog",{name:"Užduotis ir jos planas"}),steps=editor.getByRole("region",{name:"Žingsniai"});
  await steps.getByRole("checkbox",{name:"Paruošti"}).click();
  await expect(steps.getByRole("checkbox",{name:"Paruošti"})).toBeChecked();
  await steps.getByPlaceholder("Naujas žingsnis…").fill("Patikrinti");
  await steps.getByRole("button",{name:"Pridėti"}).click();
  await expect(steps.getByText("Patikrinti",{exact:true})).toBeVisible();
  await steps.getByRole("button",{name:"Pašalinti žingsnį „Patikrinti“"}).click();
  await expect(steps.getByText("Patikrinti",{exact:true})).toHaveCount(0);
  expect(mutations).toEqual([
    {method:"PATCH",body:{source:"microsoft",account_id:"microsoft-account",list_id:"list-a",id:"task-1",version:"steps-v1",step_id:"step-a",isChecked:true}},
    {method:"POST",body:{source:"microsoft",account_id:"microsoft-account",list_id:"list-a",id:"task-1",version:"steps-v2",displayName:"Patikrinti"}},
    {method:"DELETE",body:{source:"microsoft",account_id:"microsoft-account",list_id:"list-a",id:"task-1",version:"steps-v3",step_id:"step-b"}},
  ]);
});
