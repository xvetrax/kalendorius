"use client";

import {useEffect,useRef,useState} from "react";
import type {CalendarEvent,CalendarSeriesSnapshot} from "@/lib/calendar-events";
import {calendarRecurrenceWeekdays,defaultCalendarRecurrence,futureCalendarRecurrence,parseCalendarRecurrence,type CalendarRecurrence} from "@/lib/calendar-recurrence";
import {zonedLocalInput} from "@/lib/calendar-time-zone";

const labels:Record<typeof calendarRecurrenceWeekdays[number],string>={monday:"Pr",tuesday:"An",wednesday:"Tr",thursday:"Kt",friday:"Pn",saturday:"Št",sunday:"Sk"};
function localDate(){const now=new Date();return new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,10);}
function message(value:unknown,fallback:string){return value&&typeof value==="object"&&"error" in value&&typeof value.error==="string"?value.error:fallback;}

export function CalendarRecurrenceFields({value,startDate,onChange,disabled=false,allowDisable=true}:{value:CalendarRecurrence|null;startDate:string;onChange:(value:CalendarRecurrence|null)=>void;disabled?:boolean;allowDisable?:boolean}){
  const context={startDate:startDate||localDate(),allDay:true};
  function enable(enabled:boolean){onChange(enabled?defaultCalendarRecurrence("daily",context):null);}
  function change(patch:Partial<CalendarRecurrence>){if(value)onChange({...value,...patch} as CalendarRecurrence);}
  function frequency(next:CalendarRecurrence["frequency"]){if(value)onChange({...defaultCalendarRecurrence(next,context),interval:value.interval,end:value.end});}
  function ending(type:CalendarRecurrence["end"]["type"]){if(!value)return;change({end:type==="never"?{type:"never"}:type==="count"?{type:"count",count:10}:{type:"date",date:startDate||localDate()}});}
  const invalid=Boolean(value&&!parseCalendarRecurrence(value,context));
  return <section className="microsoftReminder microsoftRecurrence calendarRecurrence">
    {allowDisable&&<span className="fieldLabel recurrenceLabel">Pasikartojimas</span>}
    {allowDisable&&<label className="onlineSwitch"><input type="checkbox" checked={Boolean(value)} disabled={disabled||!startDate} onChange={event=>enable(event.target.checked)}/><i/>Kartoti įvykį</label>}
    {value&&<div className="microsoftReminderFields">
      <div className="formRow"><label>Dažnis<select aria-label="Įvykio kartojimo dažnis" value={value.frequency} disabled={disabled} onChange={event=>frequency(event.target.value as CalendarRecurrence["frequency"])}><option value="daily">Kasdien</option><option value="weekly">Kas savaitę</option><option value="monthly">Kas mėnesį</option><option value="yearly">Kas metus</option></select></label><label>Kas kiek<input aria-label="Įvykio kartojimo intervalas" type="number" min="1" max="999" value={value.interval} disabled={disabled} onChange={event=>change({interval:Number(event.target.value)})}/></label></div>
      {value.frequency==="weekly"&&<fieldset className="recurrenceWeekdays"><legend>Savaitės dienos</legend>{calendarRecurrenceWeekdays.map(day=><label key={day}><input type="checkbox" checked={value.days_of_week?.includes(day)||false} disabled={disabled} onChange={event=>change({days_of_week:event.target.checked?[...(value.days_of_week||[]),day]:(value.days_of_week||[]).filter(item=>item!==day)})}/>{labels[day]}</label>)}</fieldset>}
      {(value.frequency==="monthly"||value.frequency==="yearly")&&<label>Mėnesio diena<input aria-label="Įvykio mėnesio diena" type="number" min="1" max="31" value={value.day_of_month} disabled={disabled} onChange={event=>change({day_of_month:Number(event.target.value)})}/></label>}
      {value.frequency==="yearly"&&<label>Mėnuo<input aria-label="Įvykio kartojimo mėnuo" type="number" min="1" max="12" value={value.month} disabled={disabled} onChange={event=>change({month:Number(event.target.value)})}/></label>}
      <label>Pabaiga<select aria-label="Įvykio kartojimo pabaiga" value={value.end.type} disabled={disabled} onChange={event=>ending(event.target.value as CalendarRecurrence["end"]["type"])}><option value="never">Be pabaigos</option><option value="date">Pasirinktą dieną</option><option value="count">Po įvykių skaičiaus</option></select></label>
      {value.end.type==="date"&&<label>Paskutinė diena<input aria-label="Įvykio kartojimo paskutinė diena" type="date" min={startDate} value={value.end.date} disabled={disabled} onChange={event=>change({end:{type:"date",date:event.target.value}})}/></label>}
      {value.end.type==="count"&&<label>Įvykių skaičius<input aria-label="Kartojamų įvykių skaičius" type="number" min="1" max="999" value={value.end.count} disabled={disabled} onChange={event=>change({end:{type:"count",count:Number(event.target.value)}})}/></label>}
      {invalid&&<p role="alert" className="formError">Patikrink kartojimo intervalą, dienas ir pabaigą.</p>}
    </div>}
  </section>;
}

export function CalendarSeriesRecurrence({event,onChanged}:{event:CalendarEvent;onChanged?:()=>void}){
  const [snapshot,setSnapshot]=useState<CalendarSeriesSnapshot|null>(null),[rule,setRule]=useState<CalendarRecurrence|null>(null),[scope,setScope]=useState<"series"|"future">("series"),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[fresh,setFresh]=useState(false),[error,setError]=useState(""),[status,setStatus]=useState("");
  const operationId=useRef<string | null>(null);
  const seriesId=event.seriesId;
  const targetDate=event.allDay?(event.originalStart?.date||event.start.date||""):zonedLocalInput(event.originalStart?.dateTime||event.start.dateTime||"",event.timeZone||"UTC").slice(0,10);
  function ruleFor(next:CalendarSeriesSnapshot,nextScope:"series"|"future"){
    if(!next.recurrence)return null;
    return nextScope==="future"?futureCalendarRecurrence(next.recurrence,{startDate:next.startDate,allDay:event.allDay,timeZone:event.timeZone},targetDate):next.recurrence;
  }
  async function refresh(){
    if(!seriesId)return;setBusy(true);setError("");setStatus("");
    try{const query=new URLSearchParams({seriesId,calendarId:event.calendarId,connectionId:event.connectionId}),response=await fetch(`/api/${event.provider==="outlook"?"microsoft":"google"}/events?${query}`),body:unknown=await response.json().catch(()=>({}));if(!response.ok)throw new Error(message(body,"Serijos taisyklės įkelti nepavyko."));const next=body as CalendarSeriesSnapshot;setSnapshot(next);setRule(ruleFor(next,scope));setConfirmed(false);operationId.current=null;setFresh(true);}
    catch(caught){setFresh(false);setError(caught instanceof Error?caught.message:"Serijos taisyklės įkelti nepavyko.");}finally{setBusy(false);}
  }
  useEffect(()=>{void refresh();/* eslint-disable-next-line react-hooks/exhaustive-deps */},[event.key,seriesId]);
  async function save(){
    if(!snapshot||!rule||!seriesId||snapshot.readonlyReason)return;setBusy(true);setError("");setStatus("");
    try{
      const split=scope==="future";
      if(split&&!confirmed)throw new Error("Patvirtink, kad būsimos tiekėjo išimtys bus atstatytos.");
      if(split)operationId.current??=crypto.randomUUID();
      const payload=split?{scope:"future",seriesId,occurrenceId:event.id,calendarId:event.calendarId,connectionId:event.connectionId,version:snapshot.version,occurrenceVersion:event.version,operationId:operationId.current,targetDate,targetStart:event.allDay?event.start.date:event.start.dateTime,targetEnd:event.allDay?event.end.date:event.end.dateTime,allDay:event.allDay,...(!event.allDay?{timeZone:event.timeZone||"UTC"}:{}),originalRecurrence:snapshot.recurrence,recurrence:rule,confirmResetExceptions:true}:{scope:"series",seriesId,calendarId:event.calendarId,connectionId:event.connectionId,version:snapshot.version,recurrence:rule};
      const response=await fetch(`/api/${event.provider==="outlook"?"microsoft":"google"}/events`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(payload)}),body:unknown=await response.json().catch(()=>({}));if(!response.ok)throw new Error(message(body,"Serijos taisyklės išsaugoti nepavyko."));const next=body as CalendarSeriesSnapshot;setSnapshot(next);setRule(next.recurrence);setFresh(true);setStatus(split?"Serija perskirta nuo pasirinkto įvykio.":"Visos serijos kartojimo taisyklė išsaugota.");operationId.current=null;onChanged?.();}
    catch(caught){setFresh(scope==="future");setError(caught instanceof Error?caught.message:"Serijos taisyklės išsaugoti nepavyko.");}finally{setBusy(false);}
  }
  if(!seriesId)return null;
  const startDate=snapshot?.startDate||(event.allDay?event.start.date!:event.start.dateTime!.slice(0,10));
  const futureRule=snapshot?.recurrence?futureCalendarRecurrence(snapshot.recurrence,{startDate:snapshot.startDate,allDay:event.allDay,timeZone:event.timeZone},targetDate):null;
  const editStartDate=scope==="future"?targetDate:startDate;
  const changed=Boolean(snapshot&&rule&&(scope==="future"||JSON.stringify(rule)!==JSON.stringify(snapshot.recurrence))),invalid=!rule||!parseCalendarRecurrence(rule,{startDate:editStartDate,allDay:event.allDay,timeZone:event.timeZone});
  const readonlyReason=snapshot?.readonlyReason;
  function chooseScope(next:"series"|"future"){setScope(next);setRule(snapshot?ruleFor(snapshot,next):null);setConfirmed(false);setError("");setStatus("");}
  return <section className="microsoftReminder microsoftRecurrence calendarRecurrence" aria-labelledby="calendar-series-title"><div className="microsoftReminderHeading"><div><h3 id="calendar-series-title">Pasikartojimo serija</h3><p>Pasirink, kurią serijos dalį keisti. Viršuje išsaugomi tik šio egzemplioriaus laukai.</p></div><button type="button" disabled={busy} onClick={()=>void refresh()}>{busy&&!snapshot?"Kraunama…":"Atnaujinti"}</button></div>
    {readonlyReason&&<p className="formHint">{readonlyReason}</p>}{error&&<p className="formError" role="alert">{error}</p>}{status&&<p className="reminderSuccess" role="status">{status}</p>}
    {snapshot?.supported&&<fieldset className="recurrenceScope"><legend>Keitimo apimtis</legend><label><input type="radio" name={`recurrence-scope-${event.key}`} checked={scope==="series"} disabled={busy} onChange={()=>chooseScope("series")}/>Visa serija</label><label><input type="radio" name={`recurrence-scope-${event.key}`} checked={scope==="future"} disabled={busy||!futureRule} onChange={()=>chooseScope("future")}/>Šis ir visi būsimi</label></fieldset>}
    {snapshot?.supported&&scope==="future"&&!futureRule&&<p className="formHint">Pirmojo serijos įvykio atskirti negalima — jam pasirink „Visa serija“.</p>}
    {snapshot?.supported&&rule&&<><CalendarRecurrenceFields value={rule} startDate={editStartDate} onChange={setRule} disabled={busy||!fresh} allowDisable={false}/>{scope==="future"&&<div className="recurrenceSplitWarning"><p><strong>Bus sukurta nauja serija nuo {targetDate}.</strong> Individualūs būsimi pakeitimai ir atšaukimai tiekėjo kalendoriuje bus atstatyti.</p><label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/>Suprantu ir patvirtinu būsimų išimčių atstatymą</label></div>}<div className="modalActions"><button type="button" className="newButton" disabled={busy||!fresh||!changed||Boolean(invalid)||(scope==="future"&&!confirmed)} onClick={()=>void save()}>{busy?"Saugoma…":scope==="future"?"Perskirti ir išsaugoti būsimus":"Išsaugoti visos serijos taisyklę"}</button></div></>}
  </section>;
}
