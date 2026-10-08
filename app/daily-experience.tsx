"use client";

import {FormEvent, useEffect, useMemo, useRef, useState} from "react";
import type {CalendarEvent} from "@/lib/calendar-events";
import {buildDailySummary,dailyDurationLabel,parseQuickTaskInput,type DailySummary} from "@/lib/daily-experience";
import type {Task,TaskList} from "@/lib/task-service";
import {Icon,type IconName} from "@/app/icons";

function localInput(value:string|null) {
  if(!value)return "";
  const date=new Date(value);
  return new Date(date.getTime()-date.getTimezoneOffset()*60_000).toISOString().slice(0,16);
}

function sourceLabel(task:Task) {
  if(task.source==="local")return "Vietinė · šiame serveryje";
  const provider=task.source==="google"?"Google Tasks":"Microsoft To Do";
  return `${provider} · ${task.list_name||"Sąrašas"}${task.account_label||task.account_id?` · ${task.account_label||task.account_id}`:""}`;
}

function eventSourceLabel(event:CalendarEvent) {
  const provider=event.provider==="google"?"Google Calendar":"Outlook";
  return `${provider}${event.calendarName?` · ${event.calendarName}`:""}${event.accountLabel||event.accountEmail?` · ${event.accountLabel||event.accountEmail}`:""}`;
}

function useDialogFocus(panel:React.RefObject<HTMLElement|null>,onClose:()=>void) {
  const close=useRef(onClose);close.current=onClose;
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    panel.current?.querySelector<HTMLElement>("input,button,select,textarea")?.focus();
    function key(event:KeyboardEvent){
      if(event.key==="Escape"){event.preventDefault();close.current();return;}
      if(event.key!=="Tab")return;
      const controls=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')||[]).filter(element=>element.getClientRects().length>0);
      const first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
    document.addEventListener("keydown",key);
    return()=>{document.removeEventListener("keydown",key);previous?.focus();};
  },[panel]);
}

export function QuickTaskCapture({initial,lists,destination,projects,defaultProject,online,onDestination,onClose,onSave}:{
  initial:string;lists:TaskList[];destination:string;projects:string[];defaultProject:string;online:boolean;
  onDestination:(value:string)=>void;onClose:()=>void;onSave:(data:Record<string,unknown>)=>Promise<void>;
}) {
  const parsed=useMemo(()=>parseQuickTaskInput(initial),[initial]);
  const [title,setTitle]=useState(parsed.title),[duration,setDuration]=useState(parsed.durationMinutes);
  const [scheduledAt,setScheduledAt]=useState(localInput(parsed.scheduledAt));
  const [dueDate,setDueDate]=useState(parsed.dueDate||"");
  const [project,setProject]=useState(projects.includes(defaultProject)?defaultProject:projects[0]||"Asmeniniai");
  const [saving,setSaving]=useState(false),[error,setError]=useState("");
  const savingRef=useRef(false);
  const panel=useRef<HTMLElement>(null);
  const close=()=>{if(!savingRef.current)onClose();};
  useDialogFocus(panel,close);
  const selected=lists.find(list=>list.key===destination);
  const destinationValid=destination==="local"||Boolean(selected?.writable&&!selected.stale);
  async function submit(event:FormEvent){
    event.preventDefault();
    if(!online){setError("Nėra interneto ryšio.");return;}
    if(!title.trim()||duration<5||duration>1440||!destinationValid){setError("Patikrink pavadinimą, trukmę ir pasirinktą sąrašą.");return;}
    savingRef.current=true;setSaving(true);setError("");
    try{
      const payload:Record<string,unknown>={title:title.trim(),duration_minutes:duration,project,priority:"normal"};
      if(scheduledAt)payload.scheduled_at=new Date(scheduledAt).toISOString();
      if(dueDate){
        if(selected?.source==="google")payload.due_date=dueDate;
        else {const due=new Date(`${dueDate}T23:59:00`);payload.due_at=due.toISOString();}
      }
      await onSave(payload);
    }catch(value){savingRef.current=false;setError(value instanceof Error?value.message:"Nepavyko sukurti užduoties.");setSaving(false);}
  }
  return <div className="backdrop quickCaptureBackdrop" onMouseDown={event=>event.currentTarget===event.target&&close()}>
    <section ref={panel} className="modal quickCapture" role="dialog" aria-modal="true" aria-labelledby="quick-capture-title">
      <header><div><span className="eyebrow">GREITAS ĮVEDIMAS</span><h2 id="quick-capture-title">Nauja užduotis</h2></div><button type="button" aria-label="Uždaryti" disabled={saving} onClick={close}>×</button></header>
      {parsed.recognized.length>0&&<p className="quickParseSummary"><strong>Atpažinta:</strong> {parsed.recognized.join(" · ")}. Prieš išsaugodamas patikrink laukus.</p>}
      {error&&<p className="formError" role="alert">{error}</p>}
      <form className="modalForm" onSubmit={submit}>
        <label>Kur išsaugoti<select aria-label="Užduoties paskyra ir sąrašas" value={destination} disabled={saving} onChange={event=>onDestination(event.target.value)}>
          <option value="local">Vietinės · šiame serveryje</option>
          {destination!=="local"&&!lists.some(list=>list.key===destination)&&<option value={destination} disabled>Sąrašas nepasiekiamas</option>}
          {(["google","microsoft"] as const).map(source=><optgroup key={source} label={source==="google"?"Google Tasks":"Microsoft To Do"}>{lists.filter(list=>list.source===source).map(list=><option key={list.key} value={list.key} disabled={!list.writable||list.stale}>{list.account_label?`${list.account_label} · `:""}{list.name}{!list.writable?" · tik skaitymui":list.stale?" · neatnaujinta":""}</option>)}</optgroup>)}
        </select></label>
        <p className="quickDestination" role="status"><strong>Pasirinkta:</strong> {destination==="local"?"Vietinė paskyra · šiame serveryje":selected?`${selected.source==="google"?"Google Tasks":"Microsoft To Do"} · ${selected.account_label||selected.account_id} · ${selected.name}`:"Pasirink sąrašą"}</p>
        <label>Pavadinimas<input autoFocus value={title} onChange={event=>setTitle(event.target.value)} required maxLength={1024} placeholder="Ką reikia padaryti?"/></label>
        <div className="formRow"><label>Projektas<select value={project} onChange={event=>setProject(event.target.value)}>{projects.map(value=><option key={value}>{value}</option>)}</select></label><label>Trukmė, min.<input type="number" min="5" max="1440" step="5" value={duration} onChange={event=>setDuration(Number(event.target.value))}/></label></div>
        <div className="formRow"><label>Planuojamas darbo laikas<input type="datetime-local" value={scheduledAt} onChange={event=>setScheduledAt(event.target.value)}/></label><label>Termino diena<input type="date" value={dueDate} onChange={event=>setDueDate(event.target.value)}/></label></div>
        {selected?.source==="google"&&<p className="formHint">Google gaus tik termino dieną. Planuojamas darbo laikas saugomas šioje programėlėje.</p>}
        <p className="formHint">Jei nurodyti ir darbo laikas, ir terminas, jie saugomi kaip atskiri dalykai. <kbd>Enter</kbd> išsaugo, <kbd>Esc</kbd> atšaukia.</p>
        <div className="modalActions"><button type="button" disabled={saving} onClick={close}>Atšaukti</button><button className="newButton" disabled={saving||!online||!title.trim()||!destinationValid}>{saving?"Saugoma…":"Sukurti"}</button></div>
      </form>
    </section>
  </div>;
}

type PaletteItem={id:string;label:string;meta:string;icon:IconName;action:()=>void};
function paletteOptionId(id:string,index:number){return `command-${index}-${id.replace(/[^a-zA-Z0-9_-]/g,"-")}`;}
export function CommandPalette({tasks,events,onClose,onNewTask,onNewEvent,onToday,onFocus,onSettings,onTask,onEvent}:{
  tasks:Task[];events:CalendarEvent[];onClose:()=>void;onNewTask:()=>void;onNewEvent:()=>void;onToday:()=>void;onFocus:()=>void;onSettings:()=>void;onTask:(task:Task)=>void;onEvent:(event:CalendarEvent)=>void;
}) {
  const panel=useRef<HTMLElement>(null),input=useRef<HTMLInputElement>(null);useDialogFocus(panel,onClose);
  const [query,setQuery]=useState(""),[active,setActive]=useState(0);
  const items=useMemo(()=>{
    const run=(action:()=>void)=>()=>{onClose();action();};
    const commands:PaletteItem[]=[
      {id:"new-task",label:"Nauja užduotis",meta:"Greitas įvedimas",icon:"plus",action:run(onNewTask)},
      {id:"new-event",label:"Naujas įvykis",meta:"Kalendorius",icon:"calendar",action:run(onNewEvent)},
      {id:"today",label:"Mano diena",meta:"Šiandiena",icon:"calendar",action:run(onToday)},
      {id:"focus",label:"Pradėti fokusą",meta:"Fokusavimo rodinys",icon:"focus",action:run(onFocus)},
      {id:"settings",label:"Nustatymai",meta:"Paskyros ir programėlė",icon:"settings",action:run(onSettings)},
    ];
    const needle=query.trim().toLocaleLowerCase("lt-LT");
    const matchedCommands=commands.filter(item=>!needle||`${item.label} ${item.meta}`.toLocaleLowerCase("lt-LT").includes(needle));
    if(!needle)return matchedCommands;
    const taskItems=tasks.filter(task=>`${task.title} ${task.notes||""} ${sourceLabel(task)}`.toLocaleLowerCase("lt-LT").includes(needle)).slice(0,6).map<PaletteItem>(task=>({id:`task:${task.key}`,label:task.title,meta:sourceLabel(task),icon:"tasks",action:run(()=>onTask(task))}));
    const eventItems=events.filter(event=>`${event.summary} ${event.description||""} ${eventSourceLabel(event)}`.toLocaleLowerCase("lt-LT").includes(needle)).slice(0,6).map<PaletteItem>(event=>({id:`event:${event.key}`,label:event.summary,meta:eventSourceLabel(event),icon:"calendar",action:run(()=>onEvent(event))}));
    return [...matchedCommands,...taskItems,...eventItems];
  },[events,onClose,onEvent,onFocus,onNewEvent,onNewTask,onSettings,onTask,onToday,query,tasks]);
  useEffect(()=>setActive(0),[query]);
  function keyDown(event:React.KeyboardEvent<HTMLInputElement>){
    if(event.key==="ArrowDown"){event.preventDefault();setActive(value=>items.length?(value+1)%items.length:0);}
    else if(event.key==="ArrowUp"){event.preventDefault();setActive(value=>items.length?(value-1+items.length)%items.length:0);}
    else if(event.key==="Enter"&&items[active]){event.preventDefault();items[active].action();}
  }
  return <div className="backdrop commandBackdrop" onMouseDown={event=>event.currentTarget===event.target&&onClose()}>
    <section ref={panel} className="commandPalette" role="dialog" aria-modal="true" aria-labelledby="command-title">
      <h2 id="command-title" className="srOnly">Komandų paletė</h2>
      <div className="commandSearch"><Icon name="search"/><input ref={input} value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={keyDown} aria-label="Ieškoti komandų, užduočių ir įvykių" aria-controls="command-results" aria-activedescendant={items[active]?paletteOptionId(items[active].id,active):undefined} placeholder="Komanda, užduotis ar įvykis…"/><kbd>Esc</kbd></div>
      <div id="command-results" className="commandResults" role="listbox" aria-label="Rezultatai">{items.map((item,index)=><button id={paletteOptionId(item.id,index)} role="option" aria-selected={index===active} className={index===active?"active":""} key={item.id} onMouseEnter={()=>setActive(index)} onClick={item.action}><Icon name={item.icon}/><span><strong>{item.label}</strong><small>{item.meta}</small></span><kbd>↵</kbd></button>)}{!items.length&&<p>Nerasta komandų, užduočių ar įvykių.</p>}</div>
      <footer><span><kbd>↑↓</kbd> pasirinkti</span><span><kbd>Enter</kbd> atidaryti</span><span><kbd>Esc</kbd> uždaryti</span></footer>
    </section>
  </div>;
}

function time(value:Date){return value.toLocaleTimeString("lt-LT",{hour:"2-digit",minute:"2-digit"});}
function countdown(start:Date,now:Date){
  const minutes=Math.round((start.getTime()-now.getTime())/60_000);
  if(minutes<=0)return "Vyksta dabar";
  return `Po ${dailyDurationLabel(minutes)}`;
}

export function MyDayView({tasks,events,now,online,onPlan,onTask,onEvent,onDone,onFocus}:{
  tasks:Task[];events:CalendarEvent[];now:Date;online:boolean;onPlan:()=>void;onTask:(task:Task)=>void;onEvent:(event:CalendarEvent)=>void;onDone:(task:Task)=>void;onFocus:(task:Task)=>void;
}) {
  const summary:DailySummary=useMemo(()=>buildDailySummary(tasks,events,now),[events,now,tasks]);
  const occupied=Math.max(0,summary.workMinutes-summary.remainingMinutes);
  const capacity=Math.min(100,summary.workMinutes?occupied/summary.workMinutes*100:0);
  const urgent=Array.from(new Map([...summary.overdueTasks,...summary.tasks].map(task=>[task.key,task])).values());
  return <section className="myDay" aria-labelledby="my-day-title">
    <header className="myDayHero"><div><span className="eyebrow">MANO DIENA</span><h2 id="my-day-title">{now.toLocaleDateString("lt-LT",{weekday:"long",day:"numeric",month:"long"})}</h2><p>Vienoje vietoje matai kalendorių, terminus ir realią dienos talpą.</p></div><button className="newButton planDayButton" onClick={onPlan}><Icon name="calendar"/>Planuoti dieną</button></header>
    <div className="dayOverview">
      <article className="dayCard nextCard"><span className="dayCardLabel">ARTIMIAUSIA</span>{summary.nextEvent&&summary.nextEventStartsAt?<><button onClick={()=>onEvent(summary.nextEvent!)}><strong>{summary.nextEvent.summary}</strong><span>{time(summary.nextEventStartsAt)} · {countdown(summary.nextEventStartsAt,now)}</span></button><small>{eventSourceLabel(summary.nextEvent)}</small></>:<div className="dayCardEmpty"><strong>Ramu</strong><span>Šiandien daugiau suplanuotų įvykių nėra.</span></div>}</article>
      <article className="dayCard capacityCard"><span className="dayCardLabel">DIENOS TALPA · 09:00–17:00</span><div className="capacityValue"><strong>{dailyDurationLabel(summary.remainingMinutes)}</strong><span>liko laisva</span></div><div className="capacityBar" aria-label={`${Math.round(capacity)} procentai dienos užimta`}><i style={{width:`${capacity}%`}}/></div><dl><div><dt>Kalendorius</dt><dd>{dailyDurationLabel(summary.calendarBusyMinutes)}</dd></div><div><dt>Užduotys</dt><dd>{dailyDurationLabel(summary.plannedTaskMinutes)}</dd></div><div><dt>Darbo diena</dt><dd>{dailyDurationLabel(summary.workMinutes)}</dd></div></dl></article>
      <article className="dayCard gapsCard"><span className="dayCardLabel">LAISVI TARPAI</span>{summary.freeGaps.length?<ul>{summary.freeGaps.slice(0,4).map(gap=><li key={gap.start.toISOString()}><strong>{time(gap.start)}–{time(gap.end)}</strong><span>{dailyDurationLabel(Math.round((gap.end.getTime()-gap.start.getTime())/60_000))}</span></li>)}</ul>:<div className="dayCardEmpty"><strong>Diena užpildyta</strong><span>Laisvo tarpo darbo valandomis neliko.</span></div>}</article>
      <article className="dayCard allDayCard"><span className="dayCardLabel">VISAI DIENAI</span>{summary.allDayEvents.length?<ul>{summary.allDayEvents.map(event=><li key={event.key}><button onClick={()=>onEvent(event)}><strong>{event.summary}</strong><small>{eventSourceLabel(event)}</small></button></li>)}</ul>:<div className="dayCardEmpty"><strong>Nieko nėra</strong><span>Visos dienos įvykiai talpos nemažina.</span></div>}</article>
    </div>
    <section className="todayWork" aria-labelledby="today-work-title"><header><div><span className="eyebrow">DABAR SVARBIAUSIA</span><h3 id="today-work-title">Šiandienos užduotys</h3></div><b>{urgent.length}</b></header>{urgent.length?<div className="todayTaskList">{urgent.map(task=><article key={task.key} className={summary.overdueTasks.some(item=>item.key===task.key)?"overdue":""}><button className="todayDone" disabled={!online||Boolean(task.readonly_reason)} title={task.readonly_reason||undefined} aria-label={`Pažymėti atlikta: ${task.title}`} onClick={()=>onDone(task)}>✓</button><button className="todayTaskDetails" onClick={()=>onTask(task)}><strong>{task.title}</strong><span>{summary.overdueTasks.some(item=>item.key===task.key)?"Vėluoja · ":task.scheduled_at?`${time(new Date(task.scheduled_at))} · `:"Terminas šiandien · "}{sourceLabel(task)}</span>{task.readonly_reason&&<small>{task.readonly_reason}</small>}</button><button className="todayFocus" onClick={()=>onFocus(task)}><Icon name="focus"/>Fokusuoti</button></article>)}</div>:<div className="myDayEmpty"><strong>Šiandienos sąrašas tuščias</strong><span>Pridėk užduotį arba suplanuok darbą kalendoriuje.</span></div>}</section>
  </section>;
}
