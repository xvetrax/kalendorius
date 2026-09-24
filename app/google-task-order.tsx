"use client";

import {useEffect,useMemo,useRef,useState} from "react";
import type {GoogleTaskOrderSnapshot,Task} from "@/lib/task-service";

class OrderError extends Error {constructor(message:string,readonly status:number){super(message);}}
function referenceFor(task:Task){
  if(!task.account_id||!task.list_id)throw new Error("Trūksta Google Tasks užduoties nuorodos. Atnaujink užduočių sąrašą.");
  return {source:"google" as const,account_id:task.account_id,list_id:task.list_id,id:String(task.id)};
}
function message(value:unknown,fallback:string){return value&&typeof value==="object"&&"error" in value&&typeof value.error==="string"?value.error:fallback;}
async function readSnapshot(response:Response):Promise<GoogleTaskOrderSnapshot>{
  const body:unknown=await response.json().catch(()=>({}));
  if(!response.ok)throw new OrderError(message(body,"Google hierarchijos atnaujinti nepavyko."),response.status);
  if(!body||typeof body!=="object"||!("task_id" in body)||typeof body.task_id!=="string"||!("version" in body)||typeof body.version!=="string"||!("items" in body)||!Array.isArray(body.items)||!("parent_id" in body)||!("previous_id" in body))throw new Error("Gautas netinkamas Google hierarchijos atsakymas.");
  return body as GoogleTaskOrderSnapshot;
}

export function GoogleTaskOrder({task,disabled,onBusyChange,onChanged}:{task:Task;disabled:boolean;onBusyChange:(busy:boolean)=>void;onChanged:()=>void}){
  const mounted=useRef(false),generation=useRef(0);
  const [snapshot,setSnapshot]=useState<GoogleTaskOrderSnapshot|null>(null),[parentId,setParentId]=useState<string|null>(null),[previousId,setPreviousId]=useState<string|null>(null);
  const [busy,setBusy]=useState(false),[fresh,setFresh]=useState(false),[error,setError]=useState(""),[status,setStatus]=useState("");
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current+=1;onBusyChange(false);};},[onBusyChange]);
  function current(value:number){return mounted.current&&generation.current===value;}
  function begin(){const value=++generation.current;setBusy(true);onBusyChange(true);return value;}
  function finish(value:number){if(current(value)){setBusy(false);onBusyChange(false);}}
  function apply(next:GoogleTaskOrderSnapshot){setSnapshot(next);setParentId(next.parent_id);setPreviousId(next.previous_id);setFresh(true);}
  async function refresh(){
    const request=begin();setError("");setStatus("");
    try{const query=new URLSearchParams(referenceFor(task));const next=await readSnapshot(await fetch(`/api/tasks/order?${query}`));if(current(request))apply(next);}
    catch(caught){if(current(request)){setFresh(false);setError(caught instanceof Error?caught.message:"Google hierarchijos atnaujinti nepavyko.");}}
    finally{finish(request);}
  }
  useEffect(()=>{void refresh();/* eslint-disable-next-line react-hooks/exhaustive-deps */},[task.key]);
  const descendants=useMemo(()=>{
    const result=new Set<string>(),items=snapshot?.items||[],byId=new Map(items.map(item=>[item.id,item]));
    for(const item of items){let cursor=item.parent_id;const visited=new Set<string>();while(cursor&&!visited.has(cursor)){if(cursor===String(task.id)){result.add(item.id);break;}visited.add(cursor);cursor=byId.get(cursor)?.parent_id||null;}}
    return result;
  },[snapshot,task.id]);
  const parents=(snapshot?.items||[]).filter(item=>item.id!==String(task.id)&&item.can_be_parent&&!descendants.has(item.id));
  const siblings=(snapshot?.items||[]).filter(item=>item.id!==String(task.id)&&!item.hidden&&item.parent_id===parentId);
  const readonlyReason=snapshot?.readonly_reason||task.readonly_reason;
  const changed=Boolean(snapshot)&&(parentId!==snapshot?.parent_id||previousId!==snapshot?.previous_id);
  const mutationDisabled=disabled||busy||!fresh||!snapshot||Boolean(readonlyReason);
  function editParent(value:string){setParentId(value||null);setPreviousId(null);setError("");setStatus("");}
  function editPrevious(value:string){setPreviousId(value||null);setError("");setStatus("");}
  async function save(){
    if(!snapshot||mutationDisabled||!changed)return;
    const request=begin();setError("");setStatus("");
    try{
      const next=await readSnapshot(await fetch("/api/tasks/order",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({...referenceFor(task),version:snapshot.version,parent_id:parentId,previous_id:previousId})}));
      if(current(request)){apply(next);setStatus("Google Tasks hierarchija išsaugota.");onChanged();}
    }catch(caught){if(current(request)){setFresh(false);setError(caught instanceof OrderError&&caught.status===409?"Hierarchija pasikeitė Google Tasks. Spausk „Atnaujinti“ ir patikrink pasirinkimą.":caught instanceof Error?caught.message:"Google hierarchijos pakeitimo patvirtinti nepavyko.");}}
    finally{finish(request);}
  }
  return <section className="microsoftReminder googleTaskOrder" aria-labelledby="google-task-order-title">
    <div className="microsoftReminderHeading"><div><h3 id="google-task-order-title">Google Tasks hierarchija</h3><p>Parink tėvinę užduotį ir vietą tarp to paties lygio užduočių.</p></div><button type="button" disabled={disabled||busy} onClick={()=>void refresh()}>{busy&&!snapshot?"Atnaujinama…":"Atnaujinti"}</button></div>
    {readonlyReason&&<p className="formHint">{readonlyReason}</p>}{error&&<p role="alert" className="formError">{error}</p>}{status&&<p role="status" className="reminderSuccess">{status}</p>}
    {!snapshot?<p className="formHint">Kraunama…</p>:<div className="microsoftReminderFields">
      <label>Tėvinė užduotis<select aria-label="Tėvinė užduotis" value={parentId||""} disabled={mutationDisabled} onChange={event=>editParent(event.target.value)}><option value="">Viršutinis lygis</option>{parents.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <label>Vieta šiame lygyje<select aria-label="Ankstesnė užduotis" value={previousId||""} disabled={mutationDisabled} onChange={event=>editPrevious(event.target.value)}><option value="">Pirma šiame lygyje</option>{siblings.map(item=><option key={item.id} value={item.id}>Po „{item.title}“</option>)}</select></label>
      <div className="modalActions"><button type="button" className="newButton" disabled={mutationDisabled||!changed} onClick={()=>void save()}>{busy?"Saugoma…":"Išsaugoti hierarchiją"}</button></div>
    </div>}
  </section>;
}
