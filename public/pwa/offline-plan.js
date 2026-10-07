(() => {
  "use strict";
  const DB_NAME="dienos-planas-offline",DB_VERSION=1,SNAPSHOT_STORE="snapshots",META_STORE="meta",ACTIVE_KEY="active-user";
  const message=document.getElementById("offline-message"),plan=document.getElementById("offline-plan"),title=document.getElementById("offline-plan-title"),age=document.getElementById("offline-plan-age"),items=document.getElementById("offline-plan-items");

  function openDb(){return new Promise((resolve,reject)=>{const request=indexedDB.open(DB_NAME,DB_VERSION);request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(SNAPSHOT_STORE))db.createObjectStore(SNAPSHOT_STORE,{keyPath:"userKey"});if(!db.objectStoreNames.contains(META_STORE))db.createObjectStore(META_STORE,{keyPath:"key"});};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
  function requestValue(request){return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
  function valid(snapshot){return snapshot&&snapshot.version===1&&typeof snapshot.userKey==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(snapshot.day)&&Number.isFinite(snapshot.capturedAt)&&Number.isFinite(snapshot.expiresAt)&&Array.isArray(snapshot.items)&&snapshot.items.every(item=>item&&["event","task"].includes(item.kind)&&typeof item.title==="string"&&item.title.length<=1024&&typeof item.source==="string"&&item.source.length<=4096&&typeof item.allDay==="boolean");}
  function timeLabel(item){if(item.allDay||!item.start)return "Visa diena";const start=new Date(item.start);if(!Number.isFinite(start.getTime()))return "Laikas";const from=start.toLocaleTimeString("lt-LT",{hour:"2-digit",minute:"2-digit"});if(!item.end)return from;const end=new Date(item.end);return Number.isFinite(end.getTime())?`${from}–${end.toLocaleTimeString("lt-LT",{hour:"2-digit",minute:"2-digit"})}`:from;}
  function render(snapshot){
    message.textContent="Rodomas paskutinis šiame įrenginyje išsaugotas dienos planas. Interneto ryšys būtinas atnaujinimui ir pakeitimams.";
    title.textContent=new Date(`${snapshot.day}T12:00:00`).toLocaleDateString("lt-LT",{weekday:"long",year:"numeric",month:"long",day:"numeric"});
    age.textContent=`Išsaugota ${new Date(snapshot.capturedAt).toLocaleString("lt-LT",{dateStyle:"short",timeStyle:"short"})}`;
    items.replaceChildren();
    if(!snapshot.items.length){const empty=document.createElement("li");empty.className="emptyPlan";empty.textContent="Šiai dienai įvykių ar užduočių nebuvo.";items.append(empty);}
    for(const item of snapshot.items){const row=document.createElement("li"),time=document.createElement("time"),content=document.createElement("div"),name=document.createElement("strong"),source=document.createElement("small");time.textContent=timeLabel(item);name.textContent=item.title;source.textContent=`${item.kind==="event"?"Įvykis":"Užduotis"} · ${item.source}`;content.append(name,source);row.append(time,content);items.append(row);}
    plan.hidden=false;
  }
  async function load(){
    if(!("indexedDB" in window))throw new Error("unsupported");
    const db=await openDb();
    try{const metaTransaction=db.transaction(META_STORE,"readonly"),meta=await requestValue(metaTransaction.objectStore(META_STORE).get(ACTIVE_KEY));if(!meta||typeof meta.value!=="string")return;const snapshotTransaction=db.transaction(SNAPSHOT_STORE,"readonly"),snapshot=await requestValue(snapshotTransaction.objectStore(SNAPSHOT_STORE).get(meta.value));if(!valid(snapshot)||snapshot.expiresAt<=Date.now())return;render(snapshot);}finally{db.close();}
  }
  load().catch(()=>undefined).finally(()=>{if(plan.hidden)message.textContent="Galiojančio offline dienos plano šiame įrenginyje nėra. Prisijunk prie interneto ir atverk norimą dieną.";});
})();
