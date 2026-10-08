"use client";
import {createContext,useContext,useEffect,useRef,useState} from "react";
import type {CalendarEvent} from "@/lib/calendar-events";
import {datesAtMinute, minuteOfDay, segmentStyle, type DaySegment} from "@/lib/calendar-layout";
import {calendarColorStyle} from "@/lib/calendar-colors";
import {usePwaRuntime} from "@/app/pwa-runtime";
import {calendarLaneAt,dragHintFor,laneDateCandidates,RepeatedHourChoice,scrollCalendarAtPointer} from "@/app/calendar-drag";

type DragHint={day:string;minute:number;height:number}|null;
export const EventActions=createContext<{report:(error:unknown)=>void;edit:(event:CalendarEvent)=>void;move:(event:CalendarEvent,start:Date,end:Date)=>Promise<void>;setDragHint:(hint:DragHint)=>void}>({report:()=>{},edit:()=>{},move:async()=>{},setDragHint:()=>{}});
function eventOrigin(event:CalendarEvent){const calendar=event.calendarName||event.calendarId||(event.provider==="outlook"?"Outlook":"Google");return event.accountLabel&&event.accountLabel!==calendar?`${event.accountLabel} · ${calendar}`:calendar;}
export function EventBlock({event,compact=false,segment,continuesBefore=false,continuesAfter=false}:{event:CalendarEvent;compact?:boolean;segment?:DaySegment;continuesBefore?:boolean;continuesAfter?:boolean}) {
  const actions=useContext(EventActions),start=new Date(event.start.dateTime || event.start.date || 0),end=new Date(event.end.dateTime || event.end.date || 0);
  const {online}=usePwaRuntime();
  const duration=(end.getTime()-start.getTime())/60000;
  const [offset,setOffset]=useState<{x:number;y:number}|null>(null),[preview,setPreview]=useState<number|null>(null),[saving,setSaving]=useState(false);
  const [repeated,setRepeated]=useState<{mode:"move"|"resize";candidates:Date[]}|null>(null);
  const gesture=useRef<{x:number;y:number;mode:"move"|"resize";grabOffset:number}|null>(null),moved=useRef(false);
  useEffect(()=>{if(!online){gesture.current=null;setOffset(null);setPreview(null);setRepeated(null);actions.setDragHint(null);}},[online,actions]);
  async function commit(from:Date,to:Date) {if(!online){setOffset(null);setPreview(null);actions.report(new Error("Nėra interneto ryšio. Prisijungus keitimą galėsi pakartoti."));return;}setSaving(true);try {await actions.move(event,from,to);} finally {setSaving(false);setOffset(null);setPreview(null);}}
  if (compact) return <button className={`allDayEvent ${event.provider}${continuesBefore?" cont-before":""}${continuesAfter?" cont-after":""}`} style={calendarColorStyle(event.calendarColor)} onClick={()=>actions.edit(event)} title={`${event.summary} · ${eventOrigin(event)}`} aria-label={`${event.summary} · ${eventOrigin(event)}`}>{continuesBefore ? "← " : ""}{event.recurring ? "↻ " : ""}{event.summary}{continuesAfter ? " →" : ""}</button>;
  if (!segment) return null;
  const moveSafe=event.editable&&online,resizeSafe=moveSafe&&!segment.continuesAfter;
  function sourceGrabOffset(target:HTMLElement,clientY:number){
    const lane=target.closest(".dayLane") as HTMLElement|null;if(!lane)return 0;
    const candidates=laneDateCandidates(lane,clientY),within=candidates.filter(candidate=>candidate>=start&&candidate<=end);
    const instant=(within.length?within:candidates).sort((a,b)=>Math.abs(a.getTime()-start.getTime())-Math.abs(b.getTime()-start.getTime()))[0];
    return instant?instant.getTime()-start.getTime():0;
  }
  function chooseMove(candidate:Date,grabOffset:number){const nextStart=new Date(candidate.getTime()-grabOffset);return {start:nextStart,end:new Date(nextStart.getTime()+duration*60000)};}
  function finishChoice(candidate:Date){const pending=repeated;setRepeated(null);if(!pending)return;if(pending.mode==="move")void commit(candidate,new Date(candidate.getTime()+duration*60000));else void commit(start,candidate);}
  function keyboardMove(dayStep:number,minuteStep:number){
    if(dayStep){const target=new Date(start);target.setDate(target.getDate()+dayStep);const candidates=datesAtMinute(target,minuteOfDay(start));if(candidates.length===2){setRepeated({mode:"move",candidates});return;}if(candidates.length===1){void commit(candidates[0],new Date(candidates[0].getTime()+duration*60000));return;}actions.report(new Error("Pasirinktas laikas tą dieną neegzistuoja dėl vasaros laiko."));return;}
    const next=new Date(start.getTime()+minuteStep*60000);void commit(next,new Date(next.getTime()+duration*60000));
  }
  return <div className={`eventBlock calendarEvent ${event.provider} ${event.editable ? "editable" : "readOnly"}`} data-short={segment.height<45 || undefined} data-tiny={segment.height<24 || undefined} style={{...segmentStyle(segment,preview),...calendarColorStyle(event.calendarColor),transform:offset ? `translate(${offset.x}px,${offset.y}px)` : undefined,zIndex:offset ? 12 : undefined,pointerEvents:offset ? "none" : undefined}}>
    <button className="eventDetails" disabled={saving} aria-label={`Redaguoti įvykį: ${event.summary}`} aria-description={eventOrigin(event)} title={`${eventOrigin(event)}. ${moveSafe ? "Tempk perkelti arba paspausk redaguoti. Shift+↑↓ — laikas, Shift+←→ — diena." : event.readOnlyReason}`}
      onClick={(e)=>{if (e.detail===0 || !moved.current) actions.edit(event);}}
      onKeyDown={(e)=>{if(!moveSafe||!e.shiftKey)return;const steps:Record<string,[number,number]>={ArrowDown:[0,15],ArrowUp:[0,-15],ArrowRight:[1,0],ArrowLeft:[-1,0]};const step=steps[e.key];if(!step)return;e.preventDefault();keyboardMove(...step);}}
      onPointerDown={(e)=>{moved.current=false;if(!moveSafe || e.button!==0) return;gesture.current={x:e.clientX,y:e.clientY,mode:"move",grabOffset:sourceGrabOffset(e.currentTarget,e.clientY)};e.currentTarget.setPointerCapture(e.pointerId);}}
      onPointerMove={(e)=>{const g=gesture.current;if(!online||g?.mode!=="move") return;const dx=e.clientX-g.x,dy=e.clientY-g.y;if(moved.current || Math.hypot(dx,dy)>5){moved.current=true;setOffset({x:dx,y:dy});scrollCalendarAtPointer(e.currentTarget,e.clientY);const lane=calendarLaneAt(e.clientX,e.clientY),candidate=lane&&laneDateCandidates(lane,e.clientY)[0];if(lane&&candidate)actions.setDragHint(dragHintFor(lane,candidate,duration));else actions.setDragHint(null);}}}
      onPointerCancel={()=>{gesture.current=null;setOffset(null);actions.setDragHint(null);}}
      onPointerUp={(e)=>{const g=gesture.current;if(g?.mode!=="move")return;gesture.current=null;e.currentTarget.releasePointerCapture(e.pointerId);actions.setDragHint(null);if(!online){setOffset(null);return;}if(!moved.current)return;const lane=calendarLaneAt(e.clientX,e.clientY),candidates=lane?laneDateCandidates(lane,e.clientY):[];setOffset(null);if(!candidates.length){actions.report(new Error("Pasirinktas laikas neegzistuoja dėl vasaros laiko."));return;}const movedCandidates=candidates.map(candidate=>chooseMove(candidate,g.grabOffset).start);if(movedCandidates.length===2){setRepeated({mode:"move",candidates:movedCandidates});return;}void commit(movedCandidates[0],new Date(movedCandidates[0].getTime()+duration*60000));}}>
      <span>{segment.continuesBefore ? "← Tęsinys · " : ""}{start.toLocaleTimeString("lt-LT",{hour:"2-digit",minute:"2-digit"})} · {Math.round(preview ?? duration)} min.{segment.continuesAfter ? " →" : ""}</span><strong>{event.summary}</strong><small>{eventOrigin(event)}{event.recurring ? " · ↻" : ""}{!event.editable ? " · tik skaityti" : ""}</small>
    </button>
    {resizeSafe && <button className="eventResize" aria-label={`Keisti įvykio trukmę: ${event.summary}`} title="Tempk per dienas arba naudok ↑ / ↓ (15 min.)" disabled={saving}
      onPointerDown={(e)=>{if(e.button!==0)return;e.preventDefault();gesture.current={x:e.clientX,y:e.clientY,mode:"resize",grabOffset:0};e.currentTarget.setPointerCapture(e.pointerId);}}
      onPointerMove={(e)=>{const g=gesture.current;if(!online||g?.mode!=="resize")return;scrollCalendarAtPointer(e.currentTarget,e.clientY);const lane=calendarLaneAt(e.clientX,e.clientY),candidate=lane&&laneDateCandidates(lane,e.clientY)[0];if(!lane||!candidate||candidate<=start){actions.setDragHint(null);return;}actions.setDragHint(dragHintFor(lane,candidate,15));setPreview((candidate.getTime()-start.getTime())/60000);}}
      onPointerUp={(e)=>{const g=gesture.current;if(g?.mode!=="resize")return;gesture.current=null;e.currentTarget.releasePointerCapture(e.pointerId);actions.setDragHint(null);if(!online){setPreview(null);return;}const lane=calendarLaneAt(e.clientX,e.clientY),candidates=(lane?laneDateCandidates(lane,e.clientY):[]).filter(candidate=>candidate>start);if(!candidates.length){setPreview(null);actions.report(new Error("Pabaiga turi būti vėliau už pradžią ir negali patekti į neegzistuojančią DST valandą."));return;}if(candidates.length===2){setRepeated({mode:"resize",candidates});return;}if(candidates[0].getTime()!==end.getTime())void commit(start,candidates[0]);else setPreview(null);}}
      onPointerCancel={()=>{gesture.current=null;setPreview(null);actions.setDragHint(null);}}
      onKeyDown={(e)=>{if(e.key!=="ArrowDown" && e.key!=="ArrowUp")return;e.preventDefault();void commit(start,new Date(start.getTime()+Math.max(15,duration+(e.key==="ArrowDown"?15:-15))*60000));}}>═</button>}
    {repeated&&<RepeatedHourChoice title={repeated.mode==="move"?"Pasirink, į kurį laiko egzempliorių perkelti įvykį.":"Pasirink, kuriuo laiko egzemplioriumi baigiasi įvykis."} candidates={repeated.candidates} onChoose={finishChoice} onCancel={()=>{setRepeated(null);setPreview(null);}}/>}
  </div>;
}
