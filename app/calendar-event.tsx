"use client";
import {createContext,useContext,useRef,useState} from "react";
import type {CalendarEvent} from "@/lib/calendar-events";
import {dateAtMinute, segmentStyle, type DaySegment} from "@/lib/calendar-layout";

export const EventActions=createContext<{report:(error:unknown)=>void;edit:(event:CalendarEvent)=>void;move:(event:CalendarEvent,start:Date,end:Date)=>Promise<void>}>({report:()=>{},edit:()=>{},move:async()=>{}});
export function EventBlock({event,compact=false,segment,continuesBefore=false,continuesAfter=false}:{event:CalendarEvent;compact?:boolean;segment?:DaySegment;continuesBefore?:boolean;continuesAfter?:boolean}) {
  const actions=useContext(EventActions),start=new Date(event.start.dateTime || event.start.date || 0),end=new Date(event.end.dateTime || event.end.date || 0);
  const duration=(end.getTime()-start.getTime())/60000;
  const [offset,setOffset]=useState<{x:number;y:number}|null>(null),[preview,setPreview]=useState<number|null>(null),[saving,setSaving]=useState(false);
  const gesture=useRef<{x:number;y:number;resize:boolean;next:number;grab:number}|null>(null),moved=useRef(false);
  async function commit(from:Date,to:Date) {setSaving(true);try {await actions.move(event,from,to);} finally {setSaving(false);setOffset(null);setPreview(null);}}
  if (compact) return <button className={`allDayEvent ${event.provider}${continuesBefore?" cont-before":""}${continuesAfter?" cont-after":""}`} onClick={()=>actions.edit(event)} title={event.summary}>{continuesBefore ? "← " : ""}{event.recurring ? "↻ " : ""}{event.summary}{continuesAfter ? " →" : ""}</button>;
  if (!segment) return null;
  const gestureSafe=event.editable && segment.gestureSafe;
  return <div className={`eventBlock calendarEvent ${event.provider} ${event.editable ? "editable" : "readOnly"}`} data-short={segment.height<45 || undefined} data-tiny={segment.height<24 || undefined} style={{...segmentStyle(segment,preview),transform:offset ? `translate(${offset.x}px,${offset.y}px)` : undefined,zIndex:offset ? 12 : undefined,pointerEvents:offset ? "none" : undefined}}>
    <button className="eventDetails" disabled={saving} aria-label={`Redaguoti įvykį: ${event.summary}`} title={gestureSafe ? "Tempk perkelti arba paspausk redaguoti. Shift+↑↓ — laikas, Shift+←→ — diena." : event.editable ? "Kelių dienų ar laiko keitimo dienos įvykį keisk paspaudęs redaguoti" : event.readOnlyReason}
      onClick={(e)=>{if (e.detail===0 || !moved.current) actions.edit(event);}}
      onKeyDown={(e)=>{if(!gestureSafe||!e.shiftKey)return;const steps:Record<string,number>={ArrowDown:15,ArrowUp:-15,ArrowRight:1440,ArrowLeft:-1440};const step=steps[e.key];if(!step)return;e.preventDefault();const ns=new Date(start.getTime()+step*60000);void commit(ns,new Date(ns.getTime()+duration*60000));}}
      onPointerDown={(e)=>{moved.current=false;if(!gestureSafe || e.button!==0) return;gesture.current={x:e.clientX,y:e.clientY,resize:false,next:duration,grab:e.clientY-e.currentTarget.closest(".eventBlock")!.getBoundingClientRect().top};e.currentTarget.setPointerCapture(e.pointerId);}}
      onPointerMove={(e)=>{const g=gesture.current;if(!g) return;const dx=e.clientX-g.x,dy=e.clientY-g.y;if(moved.current || Math.hypot(dx,dy)>5){moved.current=true;setOffset({x:dx,y:dy});}}}
      onPointerCancel={()=>{gesture.current=null;setOffset(null);}}
      onPointerUp={(e)=>{if(!gesture.current)return;const grab=gesture.current.grab;gesture.current=null;e.currentTarget.releasePointerCapture(e.pointerId);if(!moved.current)return;const lane=document.elementsFromPoint(e.clientX,e.clientY).find(el=>el instanceof HTMLElement && el.classList.contains("dayLane")) as HTMLElement|undefined;setOffset(null);if(!lane?.dataset.day)return;try {const date=dateAtMinute(new Date(lane.dataset.day+"T00:00:00"),e.clientY-lane.getBoundingClientRect().top-grab);void commit(date,new Date(date.getTime()+duration*60000));} catch(error) {actions.report(error);}}}>
      <span>{segment.continuesBefore ? "← Tęsinys · " : ""}{start.toLocaleTimeString("lt-LT",{hour:"2-digit",minute:"2-digit"})} · {Math.round(preview ?? duration)} min.{segment.continuesAfter ? " →" : ""}</span><strong>{event.summary}</strong><small>{event.provider === "outlook" ? "Outlook" : "Google"}{event.recurring ? " · ↻" : ""}{!event.editable ? " · tik skaityti" : ""}</small>
    </button>
    {gestureSafe && <button className="eventResize" aria-label={`Keisti įvykio trukmę: ${event.summary}`} title="Tempk arba naudok ↑ / ↓ (15 min.)" disabled={saving}
      onPointerDown={(e)=>{if(e.button!==0)return;e.preventDefault();gesture.current={x:e.clientX,y:e.clientY,resize:true,next:duration,grab:0};e.currentTarget.setPointerCapture(e.pointerId);}}
      onPointerMove={(e)=>{const g=gesture.current;if(!g?.resize)return;g.next=Math.min(1440,Math.max(15,Math.round((duration+e.clientY-g.y)/15)*15));setPreview(g.next);}}
      onPointerUp={(e)=>{const g=gesture.current;if(!g?.resize)return;gesture.current=null;e.currentTarget.releasePointerCapture(e.pointerId);if(g.next!==duration)void commit(start,new Date(start.getTime()+g.next*60000));else setPreview(null);}}
      onPointerCancel={()=>{gesture.current=null;setPreview(null);}}
      onKeyDown={(e)=>{if(e.key!=="ArrowDown" && e.key!=="ArrowUp")return;e.preventDefault();void commit(start,new Date(start.getTime()+Math.min(1440,Math.max(15,duration+(e.key==="ArrowDown"?15:-15)))*60000));}}>═</button>}
  </div>;
}
