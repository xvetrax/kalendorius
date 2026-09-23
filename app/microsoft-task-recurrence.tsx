"use client";

import {useEffect,useRef,useState} from "react";
import type {Task} from "@/lib/task-service";
import {parseTaskRecurrence,recurrenceWeekdays,type TaskRecurrence} from "@/lib/task-recurrence";

type Snapshot={recurrence:TaskRecurrence|null;supported:boolean;suggested_start_date:string|null;version:string;readonly_reason?:string};
class RecurrenceError extends Error {constructor(message:string,readonly status:number){super(message);}}
const weekdayLabels:Record<typeof recurrenceWeekdays[number],string>={monday:"Pr",tuesday:"An",wednesday:"Tr",thursday:"Kt",friday:"Pn",saturday:"Št",sunday:"Sk"};

function referenceFor(task:Task) {
  if(!task.account_id||!task.list_id)throw new Error("Trūksta Microsoft To Do užduoties nuorodos. Atnaujink užduočių sąrašą.");
  return {source:"microsoft" as const,account_id:task.account_id,list_id:task.list_id,id:String(task.id)};
}
function message(value:unknown,fallback:string){return value&&typeof value==="object"&&"error" in value&&typeof value.error==="string"?value.error:fallback;}
async function readSnapshot(response:Response):Promise<Snapshot>{
  const body:unknown=await response.json().catch(()=>({}));
  if(!response.ok)throw new RecurrenceError(message(body,"Kartojimo atnaujinti nepavyko."),response.status);
  if(!body||typeof body!=="object"||!("recurrence" in body)||!("supported" in body)||typeof body.supported!=="boolean"||!("version" in body)||typeof body.version!=="string"||!("suggested_start_date" in body)||body.suggested_start_date!==null&&typeof body.suggested_start_date!=="string")throw new Error("Gautas netinkamas Microsoft To Do kartojimo atsakymas.");
  const parsed=body.recurrence===null?null:parseTaskRecurrence(body.recurrence);
  if(body.recurrence!==null&&!parsed)throw new Error("Microsoft To Do grąžino nepalaikomą kartojimo taisyklę.");
  return {...body,recurrence:parsed} as Snapshot;
}
function localDate(){const now=new Date();return new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,10);}

export function MicrosoftTaskRecurrence({task,disabled,onBusyChange}:{task:Task;disabled:boolean;onBusyChange:(busy:boolean)=>void}){
  const mounted=useRef(false),generation=useRef(0);
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[enabled,setEnabled]=useState(false),[frequency,setFrequency]=useState<TaskRecurrence["frequency"]>("daily");
  const [interval,setIntervalValue]=useState(1),[startDate,setStartDate]=useState(""),[weekdays,setWeekdays]=useState<TaskRecurrence["days_of_week"]>(["monday"]);
  const [day,setDay]=useState(1),[month,setMonth]=useState(1),[busy,setBusy]=useState(false),[fresh,setFresh]=useState(false),[error,setError]=useState(""),[status,setStatus]=useState("");
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current+=1;onBusyChange(false);};},[onBusyChange]);
  function current(value:number){return mounted.current&&generation.current===value;}
  function begin(){const value=++generation.current;setBusy(true);onBusyChange(true);return value;}
  function finish(value:number){if(!current(value))return;setBusy(false);onBusyChange(false);}
  function edit(action:()=>void){action();setError("");setStatus("");}
  function apply(next:Snapshot){
    const rule=next.recurrence;setSnapshot(next);setEnabled(Boolean(rule));setFrequency(rule?.frequency||"daily");setIntervalValue(rule?.interval||1);
    setStartDate(rule?.start_date||next.suggested_start_date||localDate());setWeekdays(rule?.days_of_week||["monday"]);setDay(rule?.day_of_month||1);setMonth(rule?.month||1);setFresh(true);
  }
  async function refresh(){
    const request=begin();setError("");setStatus("");
    try{const query=new URLSearchParams(referenceFor(task));const next=await readSnapshot(await fetch(`/api/tasks/recurrence?${query}`));if(current(request))apply(next);}
    catch(caught){if(current(request)){setFresh(false);setError(caught instanceof Error?caught.message:"Kartojimo atnaujinti nepavyko.");}}
    finally{finish(request);}
  }
  useEffect(()=>{void refresh();/* eslint-disable-next-line react-hooks/exhaustive-deps */},[task.key]);
  function draft():TaskRecurrence|null{
    const base={frequency,interval,start_date:startDate};
    if(frequency==="daily")return parseTaskRecurrence(base);
    if(frequency==="weekly")return parseTaskRecurrence({...base,days_of_week:weekdays});
    if(frequency==="monthly")return parseTaskRecurrence({...base,day_of_month:day});
    return parseTaskRecurrence({...base,day_of_month:day,month});
  }
  async function save(){
    if(!snapshot||disabled||busy||!fresh||snapshot.readonly_reason||task.readonly_reason)return;
    const recurrence=enabled?draft():null;if(enabled&&!recurrence){setError("Patikrink kartojimo intervalą, pradžios datą ir pasirinktas dienas.");return;}
    const request=begin();setError("");setStatus("");
    try{
      const next=await readSnapshot(await fetch("/api/tasks/recurrence",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({...referenceFor(task),version:snapshot.version,recurrence})}));
      if(current(request)){apply(next);setStatus("Microsoft To Do kartojimas išsaugotas.");}
    }catch(caught){if(current(request)){setFresh(false);setError(caught instanceof RecurrenceError&&caught.status===409?"Kartojimas pasikeitė Microsoft To Do. Spausk „Atnaujinti“ ir patikrink taisyklę.":"Kartojimo pakeitimo patvirtinti nepavyko. Spausk „Atnaujinti“ prieš kartodamas.");}}
    finally{finish(request);}
  }
  const readonlyReason=snapshot?.readonly_reason||task.readonly_reason;
  const rule=enabled?draft():null,invalidDraft=enabled&&!rule,changed=Boolean(snapshot)&&JSON.stringify(rule)!==JSON.stringify(snapshot?.recurrence);
  const mutationDisabled=disabled||busy||!fresh||!snapshot||Boolean(readonlyReason);
  return <section className="microsoftReminder microsoftRecurrence" aria-labelledby="microsoft-recurrence-title">
    <div className="microsoftReminderHeading"><div><h3 id="microsoft-recurrence-title">Microsoft To Do kartojimas</h3><p>Paprastos taisyklės be pabaigos. Terminas ir vietinis darbo planas nesikeičia.</p></div><button type="button" onClick={()=>void refresh()} disabled={disabled||busy}>{busy&&!snapshot?"Atnaujinama…":"Atnaujinti"}</button></div>
    {readonlyReason&&<p className="formHint">{readonlyReason}</p>}{error&&<p role="alert" className="formError">{error}</p>}{status&&<p role="status" className="reminderSuccess">{status}</p>}
    <div className="microsoftReminderFields">
      <label className="onlineSwitch"><input type="checkbox" checked={enabled} disabled={mutationDisabled} onChange={event=>edit(()=>setEnabled(event.target.checked))}/><i/>Kartoti užduotį</label>
      {enabled&&<><div className="formRow"><label>Dažnis<select aria-label="Kartojimo dažnis" value={frequency} disabled={mutationDisabled} onChange={event=>edit(()=>setFrequency(event.target.value as TaskRecurrence["frequency"]))}><option value="daily">Kasdien</option><option value="weekly">Kas savaitę</option><option value="monthly">Kas mėnesį</option><option value="yearly">Kas metus</option></select></label><label>Kas kiek<input aria-label="Kartojimo intervalas" type="number" min="1" max="999" value={interval} disabled={mutationDisabled} onChange={event=>edit(()=>setIntervalValue(Number(event.target.value)))}/></label></div><label>Pradžios diena<input aria-label="Kartojimo pradžios diena" type="date" value={startDate} disabled={mutationDisabled} onChange={event=>edit(()=>setStartDate(event.target.value))}/></label>
        {frequency==="weekly"&&<fieldset className="recurrenceWeekdays"><legend>Savaitės dienos</legend>{recurrenceWeekdays.map(value=><label key={value}><input type="checkbox" checked={weekdays?.includes(value)||false} disabled={mutationDisabled} onChange={event=>edit(()=>setWeekdays(current=>event.target.checked?[...(current||[]),value]:(current||[]).filter(day=>day!==value)))}/>{weekdayLabels[value]}</label>)}</fieldset>}
        {(frequency==="monthly"||frequency==="yearly")&&<label>Mėnesio diena<input aria-label="Mėnesio diena" type="number" min="1" max="31" value={day} disabled={mutationDisabled} onChange={event=>edit(()=>setDay(Number(event.target.value)))}/></label>}
        {frequency==="yearly"&&<label>Mėnuo<input aria-label="Kartojimo mėnuo" type="number" min="1" max="12" value={month} disabled={mutationDisabled} onChange={event=>edit(()=>setMonth(Number(event.target.value)))}/></label>}</>}
      {invalidDraft&&!error&&<p role="alert" className="formError">Patikrink kartojimo intervalą, pradžios datą ir pasirinktas dienas.</p>}
      <div className="modalActions"><button type="button" className="newButton" disabled={mutationDisabled||!changed||invalidDraft} onClick={()=>void save()}>{busy?"Saugoma…":"Išsaugoti kartojimą"}</button></div>
    </div>
  </section>;
}
