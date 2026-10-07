"use client";

import {createPortal} from "react-dom";
import {useEffect,useRef} from "react";
import {autoScrollDelta,datesAtMinute,minuteOfDay} from "@/lib/calendar-layout";

export function calendarLaneAt(x:number,y:number){
  return document.elementsFromPoint(x,y).find(element=>element instanceof HTMLElement&&element.classList.contains("dayLane")) as HTMLElement|undefined;
}

export function laneDateCandidates(lane:HTMLElement,clientY:number,grab=0){
  const day=lane.dataset.day;
  if(!day)return [];
  return datesAtMinute(new Date(`${day}T00:00:00`),clientY-lane.getBoundingClientRect().top-grab);
}

export function scrollCalendarAtPointer(source:HTMLElement,clientY:number){
  const grid=source.closest(".timeGrid") as HTMLElement|null;
  if(!grid)return;
  const rect=grid.getBoundingClientRect(),delta=autoScrollDelta(clientY,rect.top,rect.bottom);
  if(delta)grid.scrollTop+=delta;
}

export function dragHintFor(lane:HTMLElement,date:Date,durationMinutes:number){
  return {day:lane.dataset.day||"",minute:minuteOfDay(date),height:Math.min(durationMinutes,1440-minuteOfDay(date))};
}

function offsetLabel(date:Date){
  const offset=-date.getTimezoneOffset(),sign=offset>=0?"+":"-",absolute=Math.abs(offset);
  return `UTC${sign}${String(Math.floor(absolute/60)).padStart(2,"0")}:${String(absolute%60).padStart(2,"0")}`;
}

export function RepeatedHourChoice({title,candidates,onChoose,onCancel}:{title:string;candidates:Date[];onChoose:(date:Date)=>void;onCancel:()=>void}){
  const panel=useRef<HTMLElement>(null),cancel=useRef(onCancel);cancel.current=onCancel;
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    function key(event:KeyboardEvent){
      if(event.key==="Escape"){event.preventDefault();cancel.current();return;}
      if(event.key!=="Tab")return;
      const controls=Array.from(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled)")||[]),first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
    document.addEventListener("keydown",key);
    return()=>{document.removeEventListener("keydown",key);previous?.focus();};
  },[]);
  if(typeof document==="undefined"||candidates.length!==2)return null;
  return createPortal(<div className="modalBackdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)onCancel();}}><section ref={panel} className="modal repeatedHourDialog" role="dialog" aria-modal="true" aria-labelledby="repeated-hour-title"><h2 id="repeated-hour-title">Pasirink pasikartojančią valandą</h2><p>{title} Ši valanda tą dieną pasitaiko du kartus.</p><div className="repeatedHourActions">{candidates.map((candidate,index)=><button type="button" className="newButton" key={candidate.toISOString()} onClick={()=>onChoose(candidate)}>{index===0?"Pirmas kartas":"Antras kartas"}<small>{candidate.toLocaleTimeString("lt-LT",{hour:"2-digit",minute:"2-digit"})} · {offsetLabel(candidate)}</small></button>)}</div><button type="button" className="ghostButton" onClick={onCancel}>Atšaukti</button></section></div>,document.body);
}
