import {expect,test} from "@playwright/test";

test("Google task hierarchy can be changed from the task editor",async({page})=>{
  const task={id:"task-1",key:'["google","google-account","list-a","task-1"]',source:"google",account_id:"google-account",list_id:"list-a",list_name:"Darbai",title:"Perkeliama užduotis",notes:"",completed:0,due_date:null,due_at:null,scheduled_at:null,duration_minutes:30,mirror_requested:0,mirror_event_id:null,mirror_error:null,project:"Google Tasks",priority:"normal",energy:"medium",tags:"",schedule_version:0,legacy_schedule:0};
  const items=[
    {id:"parent",title:"Projektas",parent_id:null,hidden:false,completed:false,can_be_parent:true},
    {id:"first",title:"Pirma",parent_id:"parent",hidden:false,completed:false,can_be_parent:true},
    {id:"task-1",title:task.title,parent_id:null,hidden:false,completed:false,can_be_parent:true},
  ];
  let mutation:any=null;
  await page.route("**/api/tasks?envelope=1",route=>route.fulfill({json:{items:[task],warnings:[],lists:[{key:'["google","google-account","list-a"]',source:"google",account_id:"google-account",list_id:"list-a",name:"Darbai",writable:true}],cleanups:[]}}));
  await page.route("**/api/microsoft/events**",route=>route.fulfill({json:{items:[]}}));
  await page.route("**/api/google/events**",route=>route.fulfill({json:{items:[]}}));
  await page.route("**/api/tasks/order**",async route=>{
    if(route.request().method()==="PATCH"){
      mutation=route.request().postDataJSON();
      await route.fulfill({json:{task_id:"task-1",parent_id:mutation.parent_id,previous_id:mutation.previous_id,items,version:"order-v2"}});
    }else await route.fulfill({json:{task_id:"task-1",parent_id:null,previous_id:null,items,version:"order-v1"}});
  });
  await page.goto("/");
  await page.locator(".taskCard").filter({hasText:task.title}).locator(".taskDetailsButton").click();
  const editor=page.getByRole("dialog",{name:"Užduotis ir jos planas"}),order=editor.getByRole("region",{name:"Google Tasks hierarchija"});
  await order.getByLabel("Tėvinė užduotis").selectOption("parent");
  await order.getByLabel("Ankstesnė užduotis").selectOption("first");
  await order.getByRole("button",{name:"Išsaugoti hierarchiją"}).click();
  await expect.poll(()=>mutation).toMatchObject({source:"google",account_id:"google-account",list_id:"list-a",id:"task-1",version:"order-v1",parent_id:"parent",previous_id:"first"});
  await expect(order.getByRole("status")).toContainText("Google Tasks hierarchija išsaugota");
  await expect(order.getByRole("button",{name:"Išsaugoti hierarchiją"})).toBeDisabled();
});
