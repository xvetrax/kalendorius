"use client";

import {useEffect,useState} from "react";
import type {ActionSummary} from "@/lib/action-journal";

function statusLabel(action:ActionSummary){
  if(action.status==="undone")return "Atšaukta";
  if(action.status==="conflict")return "Pasikeitė vėliau";
  if(action.status==="expired")return "Nebegalioja";
  return "Galima atšaukti";
}
export function ActionHistoryPanel({version,online,onUndo}:{version:number;online:boolean;onUndo:(action:ActionSummary)=>Promise<void>}){
  const [items,setItems]=useState<ActionSummary[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState(""),[now,setNow]=useState(()=>Date.now());
  useEffect(()=>{
    let active=true;setLoading(true);setError("");
    fetch("/api/actions",{cache:"no-store"}).then(async response=>{
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(typeof data.error==="string"?data.error:"Veiksmų istorijos gauti nepavyko.");
      if(active)setItems(Array.isArray(data.items)?data.items:[]);
    }).catch(cause=>{if(active)setError(cause instanceof Error?cause.message:"Veiksmų istorijos gauti nepavyko.");})
      .finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[version]);
  useEffect(()=>{
    const expiries=items.filter(action=>action.status==="available"&&action.canUndo).map(action=>Date.parse(action.undoExpiresAt)).filter(value=>value>now);
    if(!expiries.length)return;
    const timer=window.setTimeout(()=>setNow(Date.now()),Math.max(0,Math.min(...expiries)-Date.now()+20));
    return()=>window.clearTimeout(timer);
  },[items,now]);
  async function undo(action:ActionSummary){
    if(busy)return;setBusy(action.operationId);setError("");
    try{await onUndo(action);setItems(current=>current.map(item=>item.operationId===action.operationId?{...item,status:"undone",canUndo:false}:item));}
    catch(cause){setError(cause instanceof Error?cause.message:"Veiksmo atšaukti nepavyko.");}
    finally{setBusy(null);}
  }
  return <section className="actionHistory" aria-label="Paskutiniai veiksmai">
    {loading?<p className="formHint" role="status">Kraunama veiksmų istorija…</p>:error?<p className="formError" role="alert">{error}</p>:!items.length?<p className="formHint">Atšaukiamų veiksmų dar nėra.</p>:<ul>{items.map(action=>{const canUndo=action.status==="available"&&action.canUndo&&Date.parse(action.undoExpiresAt)>now,current=action.status==="available"&&!canUndo?{...action,status:"expired" as const,canUndo:false}:action;return <li key={action.operationId}><div><strong>{action.label}</strong><small>{new Date(action.createdAt).toLocaleString("lt-LT")} · {statusLabel(current)}</small></div>{canUndo&&<button type="button" disabled={!online||busy===action.operationId} onClick={()=>void undo(action)}>{busy===action.operationId?"Atšaukiama…":"Atšaukti"}</button>}</li>;})}</ul>}
  </section>;
}
