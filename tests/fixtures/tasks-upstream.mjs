// Test-only provider preload. It deliberately accepts only the OAuth refresh
// endpoints and the two task APIs so a test can never contact the network.
if (process.env.TASKS_TEST_FIXTURE !== "isolated") throw new Error("Test-only preload");

const clone = value => structuredClone(value);
const microsoftSeed = () => new Map([["shared-id", {
  id: "shared-id", title: "Microsoft užduotis", status: "notStarted", importance: "high",
  isReminderOn:false, reminderDateTime:null, "@odata.etag":"reminder-v1",
  body: {contentType: "text", content: "Microsoft pastaba"},
  dueDateTime: {dateTime: "2026-10-25T08:00:00.0000000", timeZone: "UTC"},
}]]);
const googleSeed = () => new Map([["shared-id", {
  id: "shared-id", title: "Google užduotis", status: "needsAction", notes: "Google pastaba",
  due: "2026-10-26T00:00:00.000Z",
}]]);

export const upstream = {
  calls: [], microsoft: microsoftSeed(), google: googleSeed(),
  reset() {
    this.calls.length = 0; this.microsoft = microsoftSeed(); this.google = googleSeed();
    this.microsoftLists = new Map([["microsoft-list", {id:"microsoft-list",displayName:"Microsoft darbai",wellknownListName:"defaultList"}]]);
    this.googleLists = new Map([["google-list", {id:"google-list",title:"Google darbai",etag:"google-list-v1",_revision:1}]]);
    this.microsoftListTasks = new Map([["microsoft-list",this.microsoft]]);
    this.googleListTasks = new Map([["google-list",this.google]]);
  },
  writes(source) { return this.calls.filter(call => call.source === source && call.method !== "GET"); },
};
upstream.reset();

function body(init) { return init?.body ? JSON.parse(String(init.body)) : undefined; }
function taskResponse(task) { return Response.json(clone(task)); }
function taskMap(source, listId) {
  const maps = upstream[`${source}ListTasks`];
  return maps.get(listId);
}
function taskApi(source, url, init) {
  const method = init?.method || "GET";
  const match = source === "google"
    ? url.pathname.match(/^\/tasks\/v1\/lists\/([^/]+)\/tasks(?:\/(.*))?$/)
    : url.pathname.match(/^\/v1\.0\/me\/todo\/lists\/([^/]+)\/tasks(?:\/(.*))?$/);
  upstream.calls.push({source, method, path: url.pathname + url.search, body: body(init),ifMatch:new Headers(init?.headers).get("If-Match")});
  if (!match) return Response.json({error: "Unknown fixture endpoint"}, {status: 404});
  const listId=decodeURIComponent(match[1]), map=taskMap(source,listId);
  if (!map) return Response.json({error: "Missing task list"}, {status: 404});
  if(source === "microsoft"&&match[2]){
    const checklist=match[2].match(/^([^/]+)\/checklistItems(?:\/([^/]+))?$/);
    if(checklist){
      const task=map.get(decodeURIComponent(checklist[1]));
      if(!task)return Response.json({error:"Missing task"},{status:404});
      const items=task.checklistItems||(task.checklistItems=[]),stepId=checklist[2]?decodeURIComponent(checklist[2]):null;
      if(!stepId&&method==="GET")return Response.json({value:items.map(clone)});
      if(!stepId&&method==="POST"){
        const created={id:`step-${upstream.calls.length}`,displayName:String(body(init)?.displayName||""),isChecked:body(init)?.isChecked===true};
        items.push(created);return taskResponse(created);
      }
      const index=items.findIndex(item=>item.id===stepId);
      if(index<0)return Response.json({error:"Missing checklist item"},{status:404});
      if(method==="GET")return taskResponse(items[index]);
      if(method==="PATCH"){Object.assign(items[index],body(init));return taskResponse(items[index]);}
      if(method==="DELETE"){items.splice(index,1);return new Response(null,{status:204});}
      return Response.json({error:"Unsupported fixture operation"},{status:405});
    }
  }
  if (source === "google" && match[2]?.endsWith("/move") && method === "POST") {
    const id=decodeURIComponent(match[2].slice(0,-"/move".length)),task=map.get(id);
    const destinationId=url.searchParams.get("destinationTasklist"),destination=destinationId ? taskMap(source,destinationId) : undefined;
    if (!task || destinationId&&!destination) return Response.json({error:"Missing task or destination list"},{status:404});
    if(destination){map.delete(id);destination.set(id,task);return taskResponse(task);}
    const parent=url.searchParams.get("parent"),previous=url.searchParams.get("previous");
    if(parent)task.parent=parent;else delete task.parent;
    const entries=[...map.entries()].filter(([key])=>key!==id),insertAfter=previous?entries.findIndex(([key])=>key===previous):-1;
    const target=insertAfter>=0?insertAfter+1:entries.findIndex(([,value])=>(value.parent||null)===(parent||null));
    entries.splice(target<0?entries.length:target,0,[id,task]);map.clear();for(const entry of entries)map.set(...entry);
    return taskResponse(task);
  }
  if (!match[2] && method === "GET") return Response.json(source === "google" ? {items: [...map.values()].map(clone)} : {value: [...map.values()].map(clone)});
  if (!match[2] && method === "POST") {
    const id = `${source}-created-${map.size + 1}`;
    const created = source === "google"
      ? {id, status: "needsAction", ...body(init)}
      : {id, status: "notStarted",isReminderOn:false,reminderDateTime:null, ...body(init)};
    map.set(id, created); return taskResponse(created);
  }
  if (!match[2]) return Response.json({error: "Unsupported fixture operation"}, {status: 405});
  const id = decodeURIComponent(match[2]);
  const task = map.get(id);
  if (!task) return Response.json({error: "Missing task"}, {status: 404});
  if (method === "GET") return taskResponse(task);
  if (method === "PATCH") {
    const ifMatch=new Headers(init?.headers).get("If-Match");
    if (ifMatch && ifMatch !== task["@odata.etag"]) return Response.json({error:"Version mismatch"},{status:412});
    Object.assign(task, body(init));
    if(source === "microsoft") task["@odata.etag"]=`reminder-v${upstream.calls.length}`;
    return taskResponse(task);
  }
  if (method === "DELETE") { map.delete(id); return new Response(null, {status: 204}); }
  return Response.json({error: "Unsupported fixture operation"}, {status: 405});
}

function listApi(source, url, init) {
  const method=init?.method || "GET", prefix=source === "google" ? "/tasks/v1/users/@me/lists" : "/v1.0/me/todo/lists";
  if (url.pathname !== prefix && !url.pathname.startsWith(prefix+"/")) return null;
  upstream.calls.push({source,method,path:url.pathname+url.search,body:body(init)});
  const lists=upstream[`${source}Lists`], tasks=upstream[`${source}ListTasks`];
  const suffix=url.pathname === prefix ? null : decodeURIComponent(url.pathname.slice(prefix.length+1));
  if (suffix?.includes("/")) { upstream.calls.pop(); return null; }
  if (!suffix && method === "GET") return Response.json(source === "google" ? {items:[...lists.values()].map(clone)} : {value:[...lists.values()].map(clone)});
  if (!suffix && method === "POST") {
    const id=`${source}-created-list-${lists.size}`;
    const created=source === "google"
      ? {id,title:String(body(init)?.title || "Untitled"),etag:`${id}-v1`,_revision:1}
      : {id,displayName:String(body(init)?.displayName || "Untitled"),isOwner:true,wellknownListName:"none"};
    lists.set(id,created);tasks.set(id,new Map());return taskResponse(created);
  }
  const list=lists.get(suffix);
  if (!list) return Response.json({error:"Missing task list"},{status:404});
  if (method === "PATCH") {
    if (source === "google" && init?.headers && new Headers(init.headers).get("If-Match") !== list.etag) return Response.json({error:"Version mismatch"},{status:412});
    if (source === "google") {list.title=String(body(init)?.title || list.title);list._revision++;list.etag=`${list.id}-v${list._revision}`;}
    else list.displayName=String(body(init)?.displayName || list.displayName);
    return taskResponse(list);
  }
  if (method === "DELETE") {
    if (source === "google" && init?.headers && new Headers(init.headers).get("If-Match") !== list.etag) return Response.json({error:"Version mismatch"},{status:412});
    lists.delete(suffix);tasks.delete(suffix);return new Response(null,{status:204});
  }
  return Response.json({error:"Unsupported fixture operation"},{status:405});
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === "oauth2.googleapis.com" || url.hostname === "login.microsoftonline.com") {
    return Response.json({access_token: "synthetic-access"});
  }
  if (url.hostname === "www.googleapis.com" && url.pathname === "/calendar/v3/calendars/primary/events" && !init.method) return Response.json({items:[]});
  if (url.hostname === "graph.microsoft.com" && url.pathname === "/v1.0/me/calendarView" && !init.method) return Response.json({value:[]});
  if (url.hostname === "tasks.googleapis.com") {
    const lists=listApi("google",url,init); if(lists) return lists;
    return taskApi("google", url, init);
  }
  if (url.hostname === "graph.microsoft.com") {
    const lists=listApi("microsoft",url,init); if(lists) return lists;
    return taskApi("microsoft", url, init);
  }
  throw new Error(`Fixture blocks external network: ${url.origin}`);
};
