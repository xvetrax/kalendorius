"use client";

import {useEffect,useState} from "react";
import type {CalendarEvent,CalendarSeriesSnapshot} from "@/lib/calendar-events";
import {calendarRecurrenceWeekdays,defaultCalendarRecurrence,parseCalendarRecurrence,type CalendarRecurrence} from "@/lib/calendar-recurrence";

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
  const [snapshot,setSnapshot]=useState<CalendarSeriesSnapshot|null>(null),[rule,setRule]=useState<CalendarRecurrence|null>(null),[busy,setBusy]=useState(false),[fresh,setFresh]=useState(false),[error,setError]=useState(""),[status,setStatus]=useState("");
  const seriesId=event.seriesId;
  async function refresh(){
    if(!seriesId)return;setBusy(true);setError("");setStatus("");
    try{const query=new URLSearchParams({seriesId,calendarId:event.calendarId,connectionId:event.connectionId}),response=await fetch(`/api/${event.provider==="outlook"?"microsoft":"google"}/events?${query}`),body:unknown=await response.json().catch(()=>({}));if(!response.ok)throw new Error(message(body,"Serijos taisyklės įkelti nepavyko."));const next=body as CalendarSeriesSnapshot;setSnapshot(next);setRule(next.recurrence);setFresh(true);}
    catch(caught){setFresh(false);setError(caught instanceof Error?caught.message:"Serijos taisyklės įkelti nepavyko.");}finally{setBusy(false);}
  }
  useEffect(()=>{void refresh();/* eslint-disable-next-line react-hooks/exhaustive-deps */},[event.key,seriesId]);
  async function save(){
    if(!snapshot||!rule||!seriesId||snapshot.readonlyReason)return;setBusy(true);setError("");setStatus("");
    try{const response=await fetch(`/api/${event.provider==="outlook"?"microsoft":"google"}/events`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({scope:"series",seriesId,calendarId:event.calendarId,connectionId:event.connectionId,version:snapshot.version,recurrence:rule})}),body:unknown=await response.json().catch(()=>({}));if(!response.ok)throw new Error(message(body,"Serijos taisyklės išsaugoti nepavyko."));const next=body as CalendarSeriesSnapshot;setSnapshot(next);setRule(next.recurrence);setFresh(true);setStatus("Visos serijos kartojimo taisyklė išsaugota.");onChanged?.();}
    catch(caught){setFresh(false);setError(caught instanceof Error?caught.message:"Serijos taisyklės išsaugoti nepavyko.");}finally{setBusy(false);}
  }
  if(!seriesId)return null;
  const startDate=snapshot?.startDate||(event.allDay?event.start.date!:event.start.dateTime!.slice(0,10));
  const changed=Boolean(snapshot&&rule&&JSON.stringify(rule)!==JSON.stringify(snapshot.recurrence)),invalid=!rule||!parseCalendarRecurrence(rule,{startDate,allDay:event.allDay,timeZone:event.timeZone});
  const readonlyReason=snapshot?.readonlyReason;
  return <section className="microsoftReminder microsoftRecurrence calendarRecurrence" aria-labelledby="calendar-series-title"><div className="microsoftReminderHeading"><div><h3 id="calendar-series-title">Visa serija</h3><p>Čia keičiama visos serijos taisyklė. Viršuje išsaugomi tik šio egzemplioriaus laukai.</p></div><button type="button" disabled={busy} onClick={()=>void refresh()}>{busy&&!snapshot?"Kraunama…":"Atnaujinti"}</button></div>
    {readonlyReason&&<p className="formHint">{readonlyReason}</p>}{error&&<p className="formError" role="alert">{error}</p>}{status&&<p className="reminderSuccess" role="status">{status}</p>}
    {snapshot?.supported&&rule&&<><CalendarRecurrenceFields value={rule} startDate={startDate} onChange={setRule} disabled={busy||!fresh} allowDisable={false}/><div className="modalActions"><button type="button" className="newButton" disabled={busy||!fresh||!changed||Boolean(invalid)} onClick={()=>void save()}>{busy?"Saugoma…":"Išsaugoti visos serijos taisyklę"}</button></div></>}
    <p className="formHint">„Šį ir būsimus“ šiame etape nesiūloma: saugiam veiksmui reikia perskirti seriją ir perkelti visas tiekėjo išimtis.</p>
  </section>;
}
