"use client";

import { createContext, DragEvent, FormEvent, useContext, useEffect, useMemo, useRef, useState } from "react";
import {createPortal} from "react-dom";
import type { Task, TaskList } from "@/lib/task-service";
import type { CalendarEvent as CalEvent } from "@/lib/calendar-events";
import { EventActions, EventBlock } from "@/app/calendar-event";
import { dateAtMinute, dayBounds, layoutDay, minuteOfDay, segmentStyle, touchesDay, type DaySegment } from "@/lib/calendar-layout";

import {Icon, type IconName} from "@/app/icons";
import {usePreferences} from "@/app/ui-preferences";
import {TaskListManager} from "@/app/task-list-manager";
import { MicrosoftTaskReminder } from "@/app/microsoft-task-reminder";

type View = "calendar" | "tasks" | "focus";
type Mode = "day" | "workweek" | "week" | "month";
type IntegrationStatus = { connected: boolean; configured: boolean; account: string | null; tasksConnected?: boolean; tasksStatus?: "disconnected" | "connected" | "permission_required" | "api_unavailable" };

const hours = Array.from({ length: 24 }, (_, i) => i);
const dayNames = ["Pr", "An", "Tr", "Kt", "Pn", "Št", "Sk"];
const projects = ["Asmeniniai", "Darbas", "Mokymasis"];
const TaskActions = createContext<{ report:(error:unknown)=>void; edit: (task: Task) => void; complete: (task: Task) => void; resize: (task: Task, minutes: number) => Promise<void>; move: (task:Task, date:Date | null) => Promise<void> }>({ report:()=>{}, edit: () => {}, complete: () => {}, resize: async () => {}, move:async () => {} });

function monday(date: Date) { const d = new Date(date); const weekday = d.getDay() || 7; d.setDate(d.getDate() - weekday + 1); d.setHours(0, 0, 0, 0); return d; }
function sameDay(a: Date, b: Date) { return a.toDateString() === b.toDateString(); }
function localInput(date: Date) { return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function durationLabel(value: number) { return value < 60 ? `${value} min.` : `${Math.floor(value / 60)} val.${value % 60 ? ` ${value % 60} min.` : ""}`; }
function monthStart(date: Date) { return monday(new Date(date.getFullYear(), date.getMonth(), 1)); }
function addDays(date: Date, amount: number) { const next = new Date(date); next.setDate(next.getDate() + amount); return next; }
class HttpError extends Error {status:number;constructor(message:string,status:number){super(message);this.status=status;}}
async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(typeof data.error === "string" ? data.error : "Veiksmo atlikti nepavyko.", response.status);
  return data as T;
}

export default function Planner() {
  const loadVersion = useRef(0);
  const {theme,chooseTheme,collapsed,collapse}=usePreferences();
  const searchInput=useRef<HTMLInputElement>(null);
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [taskListManagerOpen,setTaskListManagerOpen]=useState(false);
  const [isMobile,setIsMobile]=useState(false);
  const [mobilePanelOpen,setMobilePanelOpen]=useState(false);
  const [taskDestination, setTaskDestination] = useState("local");
  const [taskLists,setTaskLists] = useState<TaskList[]>([]);
  const [googleTasks,setGoogleTasks] = useState(false);
  const [googleTasksStatus,setGoogleTasksStatus] = useState<IntegrationStatus["tasksStatus"]>("disconnected");
  const [editingEvent,setEditingEvent]=useState<{event:CalEvent;start?:string;end?:string}|null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [view, setView] = useState<View>("calendar");
  const [mode, setMode] = useState<Mode>("workweek");
  const [anchor, setAnchor] = useState(new Date(0));
  const [clock,setClock]=useState<Date|null>(null);
  useEffect(()=>{const now=new Date();setClock(now);setAnchor(now);const timer=window.setInterval(()=>setClock(new Date()),60000);return ()=>window.clearInterval(timer);},[]);
  const [tasks, setTasks] = useState<Task[]>([]); const [events, setEvents] = useState<CalEvent[]>([]);
  const [outlook, setOutlook] = useState(false); const [google, setGoogle] = useState(false);
  const [outlookReady, setOutlookReady] = useState(false); const [googleReady, setGoogleReady] = useState(false);
  const [outlookAccount, setOutlookAccount] = useState<string | null>(null); const [googleAccount, setGoogleAccount] = useState<string | null>(null);
  const [quickTitle, setQuickTitle] = useState(""); const [search, setSearch] = useState(""); const [project, setProject] = useState("Visi");
  const [eventDate, setEventDate] = useState<Date | null>(null); const [taskModal, setTaskModal] = useState(false);
  const [toast, setToast] = useState(""); const [loading, setLoading] = useState(true); const [mirrorFree, setMirrorFree] = useState(false);
  const [focusTask, setFocusTask] = useState<Task | null>(null); const [seconds, setSeconds] = useState(25 * 60); const [running, setRunning] = useState(false);
  const restoredFocus = useRef(false);

  const panelOpen=view==="calendar" && (isMobile ? mobilePanelOpen : !collapsed);
  function changeView(next:View) {setView(next);setMobilePanelOpen(false);}
  useEffect(()=>{
    const query=window.matchMedia("(max-width: 760px)");
    setIsMobile(query.matches);if(query.matches)setMode("day");
    const update=()=>{setIsMobile(query.matches);setMobilePanelOpen(false);};
    query.addEventListener("change",update);
    const shortcut=(event:KeyboardEvent)=>{
      if((event.metaKey || event.ctrlKey) && event.key.toLowerCase()==="k" && !document.querySelector('[role="dialog"]')){
        event.preventDefault();searchInput.current?.focus();searchInput.current?.select();
      }
    };
    window.addEventListener("keydown",shortcut);
    return ()=>{query.removeEventListener("change",update);window.removeEventListener("keydown",shortcut);};
  },[]);
  const days = useMemo(() => { if (mode === "day") { const d = new Date(anchor); d.setHours(0, 0, 0, 0); return [d]; } const start = monday(anchor); return Array.from({ length: mode === "workweek" ? 5 : 7 }, (_, i) => addDays(start, i)); }, [anchor, mode]);
  const monthDays = useMemo(() => { const start = monthStart(anchor); return Array.from({ length: 42 }, (_, i) => addDays(start, i)); }, [anchor]);
  const openTasks = tasks.filter((task) => !task.completed);
  const filtered = openTasks.filter((task) => (project === "Visi" || (task.project || "Asmeniniai") === project) && `${task.title} ${task.notes || ""}`.toLowerCase().includes(search.toLowerCase()));
  const unplanned = filtered.filter((task) => !task.scheduled_at);
  const todayEvents = clock ? events.filter((event) => sameDay(new Date(event.start.dateTime || event.start.date || 0), clock)) : [];
  const todayTasks = clock ? openTasks.filter((task) => task.scheduled_at && sameDay(new Date(task.scheduled_at), clock)) : [];
  const todayMinutes = todayTasks.reduce((sum, task) => sum + (task.duration_minutes || 30), 0);

  async function load() {
    const version = ++loadVersion.current;
    const rangeStart = mode === "month" ? monthDays[0] : days[0];
    const last = mode === "month" ? monthDays[41] : days[days.length - 1];
    const query = new URLSearchParams({timeMin:rangeStart.toISOString(), timeMax:addDays(last, 1).toISOString()});
    const tasksRequest = fetch("/api/tasks?envelope=1").then(responseJson<{items:Task[];warnings:string[];lists:TaskList[]}>);
    const googleStatus = () => fetch("/api/google/status").then(responseJson<IntegrationStatus>);
    const results = await Promise.allSettled([
      fetch("/api/microsoft/status").then(responseJson<IntegrationStatus>),
      tasksRequest.then(googleStatus,googleStatus),
      tasksRequest,
      fetch(`/api/microsoft/events?${query}`).then(responseJson<{items:CalEvent[]}>),
      fetch(`/api/google/events?${query}`).then(responseJson<{items:CalEvent[]}>),
    ] as const);
    if (version !== loadVersion.current) return;
    const [ms, gs, ts, me, ge] = results;
    if (ms.status === "fulfilled") { setOutlook(ms.value.connected); setOutlookReady(ms.value.configured); setOutlookAccount(ms.value.account); }
    if (gs.status === "fulfilled") { setGoogle(gs.value.connected); setGoogleReady(gs.value.configured); setGoogleAccount(gs.value.account); setGoogleTasks(Boolean(gs.value.tasksConnected)); setGoogleTasksStatus(gs.value.tasksStatus); }
    if (ts.status === "fulfilled") {
      setTasks(ts.value.items); setTaskLists(ts.value.lists);
      if (ts.value.warnings.length) setToast(ts.value.warnings.join(" "));
    }
    setEvents((previous) => [
      ...(me.status === "fulfilled" ? me.value.items : previous.filter((event) => event.provider === "outlook")),
      ...(ge.status === "fulfilled" ? ge.value.items : previous.filter((event) => event.provider === "google")),
    ]);
    const rejected=results.filter((r):r is PromiseRejectedResult=>r.status==="rejected");
    if (rejected.length) {
      const auth=rejected.find(r=>r.reason instanceof HttpError && r.reason.status===401);
      setToast(auth ? `${(auth.reason as HttpError).message} Atidaryk nustatymus ir prisijunk iš naujo.` : "Dalies duomenų atnaujinti nepavyko. Išsaugoti duomenys tebėra rodomi.");
    }
    setLoading(false);
  }
  useEffect(() => { if(!clock)return;load().catch(() => { setToast("Nepavyko atnaujinti duomenų"); setLoading(false); }); }, [anchor, mode, Boolean(clock)]);
  useEffect(() => { try {const saved = localStorage.getItem("mirror-free"); setMirrorFree(saved === "true");} catch {} }, []);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search); const result = params.get("oauth"); const provider = params.get("integration") === "microsoft" ? "Microsoft" : "Google";
    if (result === "connected") setToast(`${provider} paskyra prijungta.`);
    if (result === "tasks-permission-required") {setToast("Google prijungtas, tačiau Tasks leidimas nesuteiktas. Jį gali suteikti nustatymuose.");setSettingsOpen(true);}
    if (result === "error") setToast(`${provider} prisijungti nepavyko. Bandyk dar kartą.`);
    if (result === "not-configured") setToast(`${provider} OAuth dar nesukonfigūruotas serveryje.`);
    if (result) window.history.replaceState({}, "", window.location.pathname);
  }, []);
  useEffect(() => { if (!running) return; const id = window.setInterval(() => setSeconds((value) => Math.max(0, value - 1)), 1000); return () => clearInterval(id); }, [running]);
  useEffect(() => { if (!seconds) { setRunning(false); setToast("Fokusavimo sesija baigta — metas atsikvėpti."); } }, [seconds]);
  useEffect(() => { if (restoredFocus.current || !tasks.length || focusTask) return; restoredFocus.current=true; try { const raw=localStorage.getItem("focus-session"); if (!raw) return; const data=JSON.parse(raw); if (typeof data.seconds!=="number" || !data.taskKey) return; const task=tasks.find(t=>t.key===data.taskKey && !t.completed); if (task) { setFocusTask(task); setSeconds(data.seconds); } } catch {} }, [tasks]);
  useEffect(() => { try { if (focusTask && seconds>0) localStorage.setItem("focus-session",JSON.stringify({taskKey:focusTask.key,seconds})); else localStorage.removeItem("focus-session"); } catch {} }, [focusTask,seconds]);

  function report(error: unknown) { setToast(error instanceof Error ? error.message : "Veiksmo atlikti nepavyko."); }
  async function createTask(data: Record<string, unknown>) {
    const destination=taskLists.find(list=>list.key === taskDestination);
    if(taskDestination !== "local" && (!destination || !destination.writable || destination.stale)) throw new Error("Pasirink prieinamą užduočių sąrašą. Jei sąrašas pasenęs, atnaujink duomenis.");
    const target=destination ? {source:destination.source,account_id:destination.account_id,list_id:destination.list_id} : {source:"local"};
    const task = await responseJson<Task>(await fetch("/api/tasks", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...data,...target})}));
    setTasks((current) => [...current, task]); await load();
  }
  async function patchTask(task: Task, patch: Record<string, unknown>) {
    ++loadVersion.current;
    const updated = await responseJson<Task>(await fetch("/api/tasks", {method:"PATCH",headers:{"content-type":"application/json"},
      body:JSON.stringify({id:task.id,source:task.source,account_id:task.account_id,list_id:task.list_id,schedule_version:task.schedule_version,...patch})}));
    setTasks((current) => current.map((item) => item.key === updated.key ? updated : item));
    if (updated.mirror_error) setToast(updated.mirror_error);
    await load();
    return updated;
  }
  async function deleteTask(task:Task) {
    ++loadVersion.current;
    const query=new URLSearchParams({id:String(task.id),source:task.source,...(task.account_id ? {account_id:task.account_id,list_id:task.list_id!} : {})});
    await responseJson(await fetch(`/api/tasks?${query}`,{method:"DELETE"}));
    setTasks(current=>current.filter(item=>item.key!==task.key));
    setEditingTask(null);setToast("Užduotis ištrinta.");await load();
  }
  async function saveEvent(event:CalEvent,patch:Record<string,unknown>) {
    ++loadVersion.current;
    try {
      const updated=await responseJson<CalEvent>(await fetch(`/api/${event.provider==="outlook"?"microsoft":"google"}/events`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({id:event.id,calendarId:event.calendarId,connectionId:event.connectionId,version:event.version,...patch})}));
      setEvents(current=>current.map(item=>item.key===event.key ? {...item,...updated} : item));
      setToast("Įvykio pakeitimai išsaugoti.");await load();
    } catch(error) {await load();throw error;}
  }
  async function moveEvent(event:CalEvent,start:Date,end:Date) {
    if(event.attendeeCount) {setEditingEvent({event,start:start.toISOString(),end:end.toISOString()});return;}
    try {await saveEvent(event,{start:start.toISOString(),end:end.toISOString()});setToast(`„${event.summary}" perkeltas.`);} catch(error) {report(error);}
  }
  async function quickAdd(event: FormEvent) {
    event.preventDefault(); if (!quickTitle.trim()) return;
    try { await createTask({title:quickTitle,project:project === "Visi" ? "Asmeniniai" : project,duration_minutes:30}); setQuickTitle(""); }
    catch (error) { report(error); }
  }
  async function planTask(task: Task, start: Date) {
    try {
      const updated = await patchTask(task, {scheduled_at:start.toISOString(),duration_minutes:task.duration_minutes || 30,
        mirror_requested: Boolean(task.mirror_requested || (mirrorFree && outlook))});
      setToast(updated.mirror_error || `„${task.title}“ suplanuota ${start.toLocaleString("lt-LT", {weekday:"short",hour:"2-digit",minute:"2-digit"})}`);
    } catch (error) { report(error); await load(); }
  }
  function dropTask(event: DragEvent<HTMLDivElement>, day: Date) {
    event.preventDefault();
    try {
      const raw = event.dataTransfer.getData("application/task"); if (!raw) return;
      const dragged = JSON.parse(raw); const task = tasks.find((item) => item.key === dragged.key); if (!task) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const start = dateAtMinute(day, event.clientY - rect.top); void planTask(task, start);
    } catch (error) { report(error); }
  }
  async function unscheduleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    try {
      const raw = event.dataTransfer.getData("application/task"); if (!raw) return;
      const task = tasks.find((item) => item.key === JSON.parse(raw).key); if (!task) return;
      const updated = await patchTask(task, {scheduled_at:null,mirror_requested:false});
      setToast(updated.mirror_error || "Užduotis grąžinta į neplanuotas.");
    } catch (error) { report(error); }
  }
  function move(amount: number) { const next = new Date(anchor); mode === "month" ? next.setMonth(next.getMonth() + amount) : next.setDate(next.getDate() + amount * (mode === "day" ? 1 : 7)); setAnchor(next); }
  function startFocus(task: Task) { setFocusTask(task); setSeconds(25 * 60); setRunning(false); setView("focus"); }
  async function disconnect(provider: "microsoft" | "google") {
    const name = provider === "microsoft" ? "Microsoft" : "Google";
    if (!window.confirm(`Atjungti ${name} paskyrą šiame įrenginyje?`)) return;
    try { await responseJson(await fetch(`/api/${provider}/status`, { method: "DELETE" })); setToast(`${name} paskyra atjungta.`); await load(); }
    catch (error) { setToast(error instanceof Error ? error.message : "Paskyros atjungti nepavyko."); }
  }

  return <EventActions.Provider value={{report,edit:(event)=>setEditingEvent({event}),move:moveEvent}}><TaskActions.Provider value={{report,edit:setEditingTask,move:async (task,date) => {if (date) await planTask(task,date);else {try {const updated=await patchTask(task,{scheduled_at:null,mirror_requested:false});setToast(updated.mirror_error || "Užduotis grąžinta į neplanuotas.");} catch(error) {report(error);}}},complete:(task) => { void patchTask(task, {completed:!task.completed}).catch(report); },resize:async (task,minutes) => { try {const updated=await patchTask(task,{duration_minutes:minutes});setToast(updated.mirror_error || `Trukmė pakeista: ${durationLabel(minutes)}`);} catch(error) {report(error);} }}}><main className={`appShell ${panelOpen ? "withPanel" : "withoutPanel"}`} data-mobile-panel={mobilePanelOpen || undefined}>
    <aside className="rail" aria-label="Pagrindinė navigacija">
      <button className="brand" aria-label="Dienos planas – šiandien" onClick={()=>{changeView("calendar");setAnchor(new Date());}}><span className="brandMark"><Icon name="calendar"/></span><span>Dienos planas<small>Tavo laikas. Tavo ritmu.</small></span></button>
      <div className="navCaption">DARBO ERDVĖ</div>
      <nav aria-label="Rodiniai"><Rail active={view==="calendar"} icon="calendar" label="Kalendorius" onClick={()=>changeView("calendar")}/><Rail active={view==="tasks"} icon="tasks" label="Užduotys" badge={openTasks.length} onClick={()=>changeView("tasks")}/><Rail active={view==="focus"} icon="focus" label="Fokusas" onClick={()=>changeView("focus")}/><Rail active={settingsOpen} icon="settings" label="Nustatymai" onClick={()=>setSettingsOpen(true)}/></nav>
      <div className="navFooter"><span className="eyebrow">TAVO KALENDORIAI</span><span><i className="providerDot outlook"/>{outlook ? "Outlook prijungtas" : "Outlook neprijungtas"}</span><span><i className="providerDot google"/>{google ? "Google prijungtas" : "Google neprijungtas"}</span><button onClick={()=>setSettingsOpen(true)}>Tvarkyti paskyras →</button><small>Privati darbo erdvė</small></div>
    </aside>
    <section className="mainSurface">
      <header className="topHeader">
        <div className="pageHeading"><span className="eyebrow">DIENOS PLANAS</span><h1>{view==="calendar" ? "Laikas tavo dienai" : view==="tasks" ? "Visi tavo darbai" : "Erdvė susikaupti"}</h1></div>
        <div className="search"><Icon name="search"/><input ref={searchInput} aria-label="Ieškoti užduočių ir įvykių" value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>{if(e.key==="Escape")setSearch("");}} placeholder="Ieškoti užduočių ir įvykių"/>{search ? <button aria-label="Išvalyti paiešką" onClick={()=>{setSearch("");searchInput.current?.focus();}}>×</button> : <kbd>⌘ / Ctrl K</kbd>}</div>
        <div className="headerActions"><button className="iconButton" aria-label="Atnaujinti duomenis" title="Atnaujinti duomenis" disabled={loading} onClick={()=>{setLoading(true);void load().catch(error=>{setLoading(false);report(error);});}}>↻</button><button className="iconButton" aria-label="Išvaizdos nustatymai" title="Išvaizdos nustatymai" onClick={()=>setSettingsOpen(true)}><Icon name={theme==="dark" ? "moon" : "sun"}/></button>{view==="calendar" && <button className="iconButton panelToggle" aria-label={panelOpen ? "Slėpti užduočių juostą" : "Rodyti užduočių juostą"} title={panelOpen ? "Slėpti užduočių juostą" : "Rodyti užduočių juostą"} aria-expanded={panelOpen} aria-controls="task-panel" onClick={()=>{if(isMobile)setMobilePanelOpen(!mobilePanelOpen);else collapse(!collapsed);}}><Icon name="panel"/></button>}<button className="newButton" aria-label={view==="calendar" ? "Naujas įvykis" : "Nauja užduotis"} onClick={()=>view==="calendar" ? setEventDate(new Date()) : setTaskModal(true)}><Icon name="plus"/><span>{view==="calendar" ? "Įvykis" : "Užduotis"}</span></button></div>
      </header>
      {toast && <button role="status" className="toast" onClick={() => setToast("")}>{toast}<span>×</span></button>}
      {view === "calendar" && !clock && <div className="loading" role="status" aria-label="Kraunamas kalendorius"><i/><i/><i/></div>}
      {view === "calendar" && clock && <Calendar mode={mode} setMode={setMode} anchor={anchor} setAnchor={setAnchor} days={days} monthDays={monthDays} events={events.filter(event=>event.summary.toLowerCase().includes(search.toLowerCase()))} tasks={tasks.filter(task=>`${task.title} ${task.notes || ""}`.toLowerCase().includes(search.toLowerCase()))} loading={loading} move={move} onDrop={dropTask} onCreate={setEventDate}/>} 
      {view === "tasks" && <TaskBoard tasks={tasks.filter((task) => `${task.title} ${task.notes || ""}`.toLowerCase().includes(search.toLowerCase()))} onDone={(task) => { void patchTask(task, { completed: !task.completed }).catch(report); }} onFocus={startFocus} onAdd={() => setTaskModal(true)}/>} 
      {view === "focus" && <Focus task={focusTask || openTasks[0]} tasks={openTasks} seconds={seconds} running={running} onToggle={() => setRunning(!running)} onReset={() => { setRunning(false); setSeconds(25 * 60); }} onSelect={setFocusTask} onDone={async () => { if (focusTask) await patchTask(focusTask, { completed: true }); setFocusTask(null); setRunning(false); setSeconds(25 * 60); }}/>} 
    </section>
    <aside className="taskPanel" id="task-panel" aria-label="Neplanuotos užduotys" hidden={!panelOpen}>
      <header className="panelHeader"><div><span className="eyebrow">DARBŲ DĖŽUTĖ</span><h1>{clock ? clock.toLocaleDateString("lt-LT", { weekday: "long", day: "numeric", month: "long" }) : "Šiandien"}</h1></div><button className="roundButton" aria-label="Nauja užduotis" onClick={() => setTaskModal(true)}><Icon name="plus"/></button></header>
      <section className="dayLoad"><div><strong>{durationLabel(todayMinutes)}</strong><span>suplanuota darbams</span></div><div className="progress"><i style={{ width: `${Math.min(100, todayMinutes / 480 * 100)}%` }}/></div><small>{todayEvents.length} įvykiai · {todayTasks.length} užduotys</small></section>
      <form className="quickAdd" onSubmit={quickAdd}><span>＋</span><input value={quickTitle} onChange={(e) => setQuickTitle(e.target.value)} placeholder="Pridėti užduotį…"/><kbd>↵</kbd></form>
      <div className="filters"><button className={project === "Visi" ? "active" : ""} onClick={() => setProject("Visi")}>Visos</button>{projects.map((name) => <button className={project === name ? "active" : ""} onClick={() => setProject(name)} key={name}>{name}</button>)}</div>
      <div className="listTitle"><span>NEPLANUOTA</span><b>{unplanned.length}</b></div>
      <div className="taskListDestination"><TaskDestination lists={taskLists} value={taskDestination} onChange={setTaskDestination}/><button type="button" onClick={()=>setTaskListManagerOpen(true)}>Tvarkyti sąrašus</button></div><section className="taskList" onDragOver={(e) => e.preventDefault()} onDrop={unscheduleDrop}>{unplanned.map((task) => <TaskCard task={task} onDone={() => { void patchTask(task, { completed: true }).catch(report); }} onFocus={() => startFocus(task)} key={task.key}/>)}{!unplanned.length && <div className="emptyState"><b>✓</b><strong>Viskas suplanuota</strong><span>Naują užduotį pridėk aukščiau</span></div>}</section>
      <p className="panelHint">{isMobile ? "Paspausk užduotį ir pasirink suplanuotą pradžią." : "Tempk užduotį į kalendorių."}<br/>Terminas ir darbo laikas – atskirai.</p>

    </aside>
    {settingsOpen && <Modal eyebrow="DARBO ERDVĖ" title="Nustatymai" onClose={()=>setSettingsOpen(false)}><section className="preferences"><h3>Išvaizda</h3><p>Pasirink patogią temą. Nustatymas saugomas šioje naršyklėje.</p><div className="themeChoices" role="group" aria-label="Spalvų tema">{(["light","dark","system"] as const).map(value=><button key={value} aria-pressed={theme===value} onClick={()=>chooseTheme(value)}>{value==="light" ? "Šviesi" : value==="dark" ? "Tamsi" : "Pagal įrenginį"}</button>)}</div><h3>Paskyros ir planavimas</h3><section className="settingsBlock"><label className="freeToggle"><input type="checkbox" checked={mirrorFree} onChange={(e) => { setMirrorFree(e.target.checked); try {localStorage.setItem("mirror-free", String(e.target.checked));} catch {} }}/><i/><span><strong>Rodyti Outlook kalendoriuje</strong><small>Kaip laisvą laiką — ne „Busy“</small></span></label><Connection name="Outlook + To Do" providerLabel="Microsoft" letter="O" tone="blue" connected={outlook} ready={outlookReady} account={outlookAccount} href="/api/microsoft/connect" onDisconnect={() => disconnect("microsoft")}/><Connection name="Google Calendar + Tasks" providerLabel="Google" letter="G" tone="multi" connected={google} ready={googleReady} account={googleAccount} href="/api/google/connect" onDisconnect={() => disconnect("google")}/></section>{google && googleTasksStatus === "api_unavailable" ? <p className="formHint" role="status">Google Tasks API nepasiekiama. Google Cloud projekte patikrink, ar įjungta Tasks API, ir atnaujink duomenis. Pakartotinis sutikimas API neįjungia.</p> : google && !googleTasks ? <p className="formHint" role="status">Google Tasks reikia papildomo leidimo. Prisijunk prie tos pačios paskyros ir sutikimo lange leisk tvarkyti užduotis. <a href="/api/google/connect">Suteikti Tasks leidimą →</a></p> : googleTasks ? <p className="formHint">Google Tasks leidimas suteiktas.</p> : null}<p className="formHint">Užduotims naudojami Google Tasks ir Microsoft To Do sąrašai. <button type="button" className="settingsListButton" onClick={()=>{setSettingsOpen(false);setTaskListManagerOpen(true);}}>Tvarkyti sąrašus</button> Paskyros prijungimas nesuteikia pačios programėlės prieigos apsaugos.</p><LogoutButton/>{(google||outlook)&&<><h3>Kalendoriai</h3><CalendarSelector google={google} outlook={outlook} onSaved={load}/></>}<h3>Klaviatūra</h3><p><kbd>⌘ / Ctrl K</kbd> paieška · <kbd>Esc</kbd> uždaryti langą / išvalyti paiešką.</p><h3>Duomenys</h3><BackupPanel/></section></Modal>}
    {taskListManagerOpen && <Modal eyebrow="UŽDUOTYS" title="Tvarkyti sąrašus" onClose={()=>setTaskListManagerOpen(false)}><TaskListManager onChanged={load} onDeleted={(key)=>setTaskDestination(current=>current===key ? "local" : current)} onListCreated={setTaskDestination}/></Modal>}
    {editingEvent && <ExistingEventEditor key={editingEvent.event.key} value={editingEvent} onClose={()=>setEditingEvent(null)} onSave={async(patch)=>{await saveEvent(editingEvent.event,patch);setEditingEvent(null);}} onRefresh={()=>{void load();setEditingEvent(null);}}/>}
    {editingTask && <TaskEditor task={editingTask} outlook={outlook} taskLists={taskLists} onDelete={()=>deleteTask(editingTask)} onClose={() => setEditingTask(null)} onSave={async (patch) => { await patchTask(editingTask, patch); setEditingTask(null); }} onMoved={(moved)=>{setTasks(current=>current.map(item=>item.key===editingTask.key?moved:item));setFocusTask(current=>current?.key===editingTask.key?moved:current);setToast("Užduotis perkelta.");void load();}}/>}
    {taskModal && <TaskModal lists={taskLists} destination={taskDestination} onDestination={setTaskDestination} onClose={() => setTaskModal(false)} onSave={async (data) => { await createTask(data); setTaskModal(false); setToast("Užduotis sukurta"); }}/>} 
    {eventDate && <EventModal initial={eventDate} outlook={outlook} google={google} outlookReady={outlookReady} googleReady={googleReady} onClose={() => setEventDate(null)} onSave={async () => { setEventDate(null); setToast("Įvykis sukurtas"); await load(); }}/>} 
  </main></TaskActions.Provider></EventActions.Provider>;
}

function Rail({active,icon,label,badge,onClick}:{active:boolean;icon:IconName;label:string;badge?:number;onClick:()=>void}) {return <button className={active ? "active" : ""} onClick={onClick} title={label} aria-label={label} aria-current={active ? "page" : undefined}><Icon name={icon}/><span className="navLabel">{label}</span>{badge ? <i>{badge}</i> : null}</button>;}
function Connection({ name, providerLabel, letter, tone, connected, ready, account, href, onDisconnect }: { name: string; providerLabel: string; letter: string; tone: string; connected: boolean; ready: boolean; account: string | null; href: string; onDisconnect: () => void }) { return <div className="connection"><b className={tone}>{letter}</b><div><strong>{name}</strong><small>{connected ? account || "Paskyra prijungta" : ready ? "Paruošta prijungti" : "Reikia serverio OAuth nustatymų"}</small></div><i className={connected ? "online" : ""}/>{connected ? <button onClick={onDisconnect}>Atjungti</button> : ready ? <a href={href}>Prisijungti su {providerLabel}</a> : null}</div>; }
function TaskCard({task,onDone,onFocus}:{task:Task;onDone:()=>void;onFocus:()=>void}) {
  const actions=useContext(TaskActions);
  const pointer=useRef<{x:number;y:number}|null>(null),moved=useRef(false);
  const [ghost,setGhost]=useState<{x:number;y:number}|null>(null),[saving,setSaving]=useState(false);
  return <article className={`taskCard priority-${task.priority || "normal"}`} style={{opacity:ghost || saving ? .5 : 1}}
    onDragStart={event=>event.preventDefault()}
    onPointerDown={event=>{
      moved.current=false;
      const button=(event.target as HTMLElement).closest("button");
      if(saving || event.button!==0 || event.pointerType==="touch" || (button && !button.classList.contains("taskDetailsButton")))return;
      pointer.current={x:event.clientX,y:event.clientY};
    }}
    onPointerMove={event=>{const p=pointer.current;if(!p)return;if(moved.current || Math.hypot(event.clientX-p.x,event.clientY-p.y)>5){if(!moved.current)event.currentTarget.setPointerCapture(event.pointerId);moved.current=true;setGhost({x:event.clientX,y:event.clientY});}}}
    onPointerLeave={()=>{if(!moved.current)pointer.current=null;}}
    onPointerCancel={()=>{pointer.current=null;setGhost(null);}}
    onPointerUp={event=>{
      if(!pointer.current)return;pointer.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);setGhost(null);if(!moved.current)return;
      const lane=document.elementsFromPoint(event.clientX,event.clientY).find(el=>el instanceof HTMLElement && el.classList.contains("dayLane")) as HTMLElement|undefined;
      if(!lane?.dataset.day)return;
      try {const date=dateAtMinute(new Date(lane.dataset.day+"T00:00:00"),event.clientY-lane.getBoundingClientRect().top);setSaving(true);void actions.move(task,date).finally(()=>setSaving(false));} catch(error) {actions.report(error);}
    }}>
    <button className="check" disabled={saving || Boolean(task.readonly_reason)} aria-label={`Užbaigti: ${task.title}`} onClick={onDone}/>
    <button className="taskDetailsButton" disabled={saving} onClick={event=>{if(event.detail===0 || !moved.current)actions.edit(task);}}><strong>{task.title}</strong><span>{taskSourceLabel(task)}{task.stale ? " · pasenę duomenys" : ""}</span><span>{task.project} · {durationLabel(task.duration_minutes)}{task.due_at ? ` · terminas ${new Date(task.due_at).toLocaleDateString("lt-LT")}` : task.due_date ? ` · Google diena ${task.due_date}` : ""}</span></button>
    <button className="playMini" disabled={saving} aria-label={`Fokusuotis: ${task.title}`} onClick={onFocus}>▶</button><em aria-hidden="true">⋮⋮</em>
    {ghost && createPortal(<div className="taskDragPreview" style={{left:ghost.x+12,top:ghost.y+12}}><strong>{task.title}</strong><small>{durationLabel(task.duration_minutes)} · Paleisk kalendoriuje</small></div>,document.body)}
  </article>;
}

function Calendar({ mode, setMode, anchor, setAnchor, days, monthDays, events, tasks, loading, move, onDrop, onCreate }: { mode: Mode; setMode: (m: Mode) => void; anchor: Date; setAnchor: (d: Date) => void; days: Date[]; monthDays: Date[]; events: CalEvent[]; tasks: Task[]; loading: boolean; move: (n: number) => void; onDrop: (e: DragEvent<HTMLDivElement>, d: Date) => void; onCreate: (d: Date) => void }) {
  const title = mode === "day" ? anchor.toLocaleDateString("lt-LT",{month:"long",day:"numeric"}) : mode === "month" ? anchor.toLocaleDateString("lt-LT", { month: "long", year: "numeric" }) : `${days[0].toLocaleDateString("lt-LT", { month: "short", day: "numeric" })} – ${days.at(-1)!.toLocaleDateString("lt-LT", { month: "short", day: "numeric", year: "numeric" })}`;
  return <div className="calendarView"><div className="calendarToolbar"><div><button onClick={() => setAnchor(new Date())}>Šiandien</button><button aria-label="Ankstesnis laikotarpis" onClick={() => move(-1)}>‹</button><button aria-label="Kitas laikotarpis" onClick={() => move(1)}>›</button><h2>{title}</h2></div><div className="modeTabs">{(["day", "workweek", "week", "month"] as Mode[]).map((item) => <button className={mode === item ? "active" : ""} aria-pressed={mode===item} onClick={() => setMode(item)} key={item}>{({ day: "Diena", workweek: "Darbo savaitė", week: "Savaitė", month: "Mėnuo" })[item]}</button>)}</div></div>{loading ? <div className="loading"><i/><i/><i/></div> : mode === "month" ? <Month days={monthDays} anchor={anchor} events={events} tasks={tasks} onCreate={onCreate}/> : <TimeGrid days={days} events={events} tasks={tasks} onDrop={onDrop} onCreate={onCreate}/>}</div>;
}
function TimeGrid({ days, events, tasks, onDrop, onCreate }: { days: Date[]; events: CalEvent[]; tasks: Task[]; onDrop: (e: DragEvent<HTMLDivElement>, d: Date) => void; onCreate: (d: Date) => void }) {
  const grid = useRef<HTMLDivElement>(null);
  const [now,setNow] = useState<Date | null>(null);
  const actions = useContext(EventActions);
  useEffect(() => {
    if (grid.current) grid.current.scrollTop = 7 * 60;
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const timed = [
    ...events.filter(event => !event.allDay).map(event => ({key:`event-${event.key}`,start:new Date(event.start.dateTime!),end:new Date(event.end.dateTime!),event,task:undefined})),
    ...tasks.filter(task => task.scheduled_at && !task.completed).map(task => ({key:`task-${task.key}`,start:new Date(task.scheduled_at!),end:new Date(new Date(task.scheduled_at!).getTime()+task.duration_minutes*60000),task,event:undefined})),
  ];
  return <div ref={grid} className="timeGrid" style={{gridTemplateColumns:`64px repeat(${days.length}, minmax(150px,1fr))`,gridTemplateRows:"58px auto 1fr"}}>
    <div className="corner"/>{days.map(day => {
      const bounds=dayBounds(day), dayHours=(bounds.end.getTime()-bounds.start.getTime())/3600000;
      return <button className={`dayHead ${now && sameDay(day,now) ? "today" : ""}`} onClick={()=>{const d=new Date(day);d.setHours(9);onCreate(d);}} key={day.toISOString()}><span>{dayNames[(day.getDay()+6)%7]}{dayHours!==24 ? ` · ${dayHours} val.` : ""}</span><strong>{day.getDate()}</strong></button>;
    })}
    <div className="allDayLabel">Visa diena</div>{days.map(day=>{
      const dayStr=localInput(day).slice(0,10),nextStr=localInput(new Date(day.getTime()+86400000)).slice(0,10);
      const allDay=events.filter(event=>event.allDay && (event.start.date||localInput(new Date(event.start.dateTime!)).slice(0,10))<=dayStr && (event.end.date||localInput(new Date(event.end.dateTime!)).slice(0,10))>dayStr);
      const visible=allDay.slice(0,3),overflow=allDay.length-3;
      return <div className="allDayCell" key={`all-${day.toISOString()}`}>
        {visible.map(event=>{const start=event.start.date||localInput(new Date(event.start.dateTime!)).slice(0,10);const end=event.end.date||localInput(new Date(event.end.dateTime!)).slice(0,10);return <EventBlock compact event={event} continuesBefore={start<dayStr} continuesAfter={end>nextStr} key={event.key}/>;})}
        {overflow>0 && <button className="allDayOverflow" onClick={()=>actions.edit(visible[0])}>+{overflow} daugiau</button>}
      </div>;
    })}
    <div className="hourLabels">{hours.map(hour=><span key={hour}>{String(hour).padStart(2,"0")}:00</span>)}</div>
    {days.map(day=><div className="dayLane" data-day={localInput(day).slice(0,10)} onDragOver={e=>e.preventDefault()} onDrop={e=>onDrop(e,day)} key={day.toISOString()}>
      {hours.map(hour=>{function open(){try{onCreate(dateAtMinute(day,hour*60));}catch(error){actions.report(error);}}return <button className="slot" aria-label={`${localInput(day).slice(0,10)} ${String(hour).padStart(2,"0")}:00 – naujas įvykis`} onDoubleClick={open} onKeyDown={e=>{if(e.key==="Enter")open();}} key={hour}/>;})}
      {layoutDay(timed,day).map(segment=>{
        const item=timed.find(item=>item.key===segment.key)!;
        return item.event ? <EventBlock event={item.event} segment={segment} key={segment.key}/> : <TaskBlock task={item.task!} segment={segment} key={segment.key}/>;
      })}
      {now && sameDay(day,now) && <div className="currentTime" style={{top:minuteOfDay(now)}} aria-label={`Dabar ${now.toLocaleTimeString("lt-LT",{hour:"2-digit",minute:"2-digit"})}`}><i/><span>{now.toLocaleTimeString("lt-LT",{hour:"2-digit",minute:"2-digit"})}</span></div>}
    </div>)}
  </div>;
}
function TaskBlock({ task, segment }: { task: Task; segment:DaySegment }) {
  const start = new Date(task.scheduled_at!); const actions = useContext(TaskActions);
  const [preview,setPreview] = useState<number | null>(null); const [saving,setSaving] = useState(false);
  const gesture = useRef<{y:number;duration:number;next:number} | null>(null);
  const moveGesture = useRef<{x:number;y:number;grab:number} | null>(null); const moved = useRef(false);
  const [offset,setOffset] = useState<{x:number;y:number} | null>(null);
  async function commit(minutes:number) {setSaving(true);try {await actions.resize(task,minutes);} finally {setSaving(false);setPreview(null);}}
  return <div className="eventBlock taskTime" data-short={segment.height<45 || undefined} data-tiny={segment.height<24 || undefined} style={{...segmentStyle(segment,preview),transform:offset ? `translate(${offset.x}px,${offset.y}px)` : undefined,zIndex:offset ? 10 : undefined,pointerEvents:offset ? "none" : undefined}}>
    <button className="taskBlockEdit" disabled={saving} aria-label={`Redaguoti planą: ${task.title}`} title={segment.gestureSafe ? "Tempk į kitą dieną arba paspausk redaguoti. Shift+←→ — diena, Shift+↑↓ — laikas." : "Kelių dienų ar laiko keitimo dienos planą keisk paspaudęs redaguoti"}
      onClick={(e) => {if (e.detail===0 || !moved.current) actions.edit(task);}}
      onKeyDown={(e) => {if(!segment.gestureSafe||!e.shiftKey)return;const steps:Record<string,number>={ArrowDown:15,ArrowUp:-15,ArrowRight:1440,ArrowLeft:-1440};const step=steps[e.key];if(!step)return;e.preventDefault();const ns=new Date(start.getTime()+step*60000);setSaving(true);void actions.move(task,ns).finally(()=>setSaving(false));}}
      onPointerDown={(e) => {moved.current=false;if (!segment.gestureSafe || e.button !== 0) return;moveGesture.current={x:e.clientX,y:e.clientY,grab:e.clientY-e.currentTarget.closest(".eventBlock")!.getBoundingClientRect().top};moved.current=false;e.currentTarget.setPointerCapture(e.pointerId);}}
      onPointerMove={(e) => {const g=moveGesture.current;if (!g) return;const dx=e.clientX-g.x,dy=e.clientY-g.y;if (moved.current || Math.hypot(dx,dy)>5) {moved.current=true;setOffset({x:dx,y:dy});}}}
      onPointerCancel={() => {moveGesture.current=null;setOffset(null);}}
      onPointerUp={(e) => {
        if (!moveGesture.current) return;const grab=moveGesture.current.grab;moveGesture.current=null;e.currentTarget.releasePointerCapture(e.pointerId);
        if (!moved.current) return;
        const beneath=document.elementsFromPoint(e.clientX,e.clientY);
        const lane=beneath.find((element) => element instanceof HTMLElement && element.classList.contains("dayLane")) as HTMLElement | undefined;
        const unplanned=beneath.some((element) => element instanceof HTMLElement && element.classList.contains("taskList"));
        setOffset(null);
        if (lane?.dataset.day) {try {const date=dateAtMinute(new Date(lane.dataset.day+"T00:00:00"),e.clientY-lane.getBoundingClientRect().top-grab);setSaving(true);void actions.move(task,date).finally(() => setSaving(false));} catch(error) {actions.report(error);}}
        else if (unplanned) {setSaving(true);void actions.move(task,null).finally(() => setSaving(false));}
      }}><span>{segment.continuesBefore ? "← Tęsinys · " : ""}{start.toLocaleTimeString("lt-LT",{hour:"2-digit",minute:"2-digit"})} · {durationLabel(preview ?? task.duration_minutes)}{segment.continuesAfter ? " →" : ""}</span><strong>✓ {task.title}</strong></button>
    <button className="taskBlockDone" aria-label={`Užbaigti: ${task.title}`} onClick={() => actions.complete(task)}>✓</button>
    {segment.gestureSafe && <button className="taskResize" disabled={saving} aria-label={`Keisti trukmę: ${task.title}`} title="Tempk trukmei keisti; rodyklės keičia po 15 min." onDragStart={(e) => {e.preventDefault();e.stopPropagation();}}
      onPointerDown={(e) => {if (e.button !== 0) return;e.preventDefault();e.stopPropagation();e.currentTarget.setPointerCapture(e.pointerId);gesture.current={y:e.clientY,duration:task.duration_minutes,next:task.duration_minutes};setPreview(task.duration_minutes);}}
      onPointerMove={(e) => {const g=gesture.current;if (!g) return;g.next=Math.min(1440,Math.max(15,Math.round((g.duration+e.clientY-g.y)/15)*15));setPreview(g.next);}}
      onPointerUp={(e) => {const g=gesture.current;if (!g) return;gesture.current=null;e.currentTarget.releasePointerCapture(e.pointerId);if (g.next !== task.duration_minutes) void commit(g.next);else setPreview(null);}}
      onPointerCancel={() => {gesture.current=null;setPreview(null);}}
      onKeyDown={(e) => {if (e.key === "ArrowUp" || e.key === "ArrowDown") {e.preventDefault();void commit(Math.min(1440,Math.max(15,task.duration_minutes+(e.key === "ArrowDown" ? 15 : -15))));}}}>═</button>}
  </div>;
}
function Month({ days, anchor, events, tasks, onCreate }: { days: Date[]; anchor: Date; events: CalEvent[]; tasks: Task[]; onCreate: (d: Date) => void }) { return <div className="monthGrid">{dayNames.map((name) => <div className="weekday" key={name}>{name}</div>)}{days.map((day) => { const items = [...events.filter((event) => touchesDay(new Date(event.start.dateTime || `${event.start.date}T00:00:00`),new Date(event.end.dateTime || `${event.end.date}T00:00:00`),day)).map((event) => event.summary || "Įvykis"), ...tasks.filter((task) => !task.completed && task.scheduled_at && touchesDay(new Date(task.scheduled_at),new Date(Date.parse(task.scheduled_at)+task.duration_minutes*60000),day)).map((task) => `✓ ${task.title}`)]; return <button className={`${day.getMonth() !== anchor.getMonth() ? "outside" : ""} ${sameDay(day, new Date()) ? "today" : ""}`} onDoubleClick={() => onCreate(day)} key={day.toISOString()}><strong>{day.getDate()}</strong>{items.slice(0, 3).map((item, i) => <span key={`${item}-${i}`}>{item}</span>)}{items.length > 3 && <small>+{items.length - 3} daugiau</small>}</button>; })}</div>; }

function TaskBoard({ tasks, onDone, onFocus, onAdd }: { tasks: Task[]; onDone: (t: Task) => void; onFocus: (t: Task) => void; onAdd: () => void }) { const actions=useContext(TaskActions); const groups = [{ name: "Toliau", list: tasks.filter((t) => !t.completed && !t.scheduled_at) }, { name: "Suplanuota", list: tasks.filter((t) => !t.completed && t.scheduled_at) }, { name: "Atlikta", list: tasks.filter((t) => t.completed) }]; return <div className="board"><header><div><span className="eyebrow">UŽDUOTYS</span><h2>Darbų srautas</h2></div><button className="newButton" onClick={onAdd}>＋ Nauja užduotis</button></header><div className="columns">{groups.map((group) => <section key={group.name}><h3>{group.name}<b>{group.list.length}</b></h3>{group.list.map((task) => <article className={task.completed ? "done" : ""} key={task.key}><button className="check" disabled={Boolean(task.readonly_reason)} aria-label={`${task.completed ? "Atkurti" : "Užbaigti"}: ${task.title}`} onClick={() => onDone(task)}>✓</button><button className="boardTaskTitle" onClick={()=>actions.edit(task)}>{task.title}</button><small>{taskSourceLabel(task)}{task.stale ? " · pasenę duomenys" : ""}</small><p>{task.notes || "Be papildomų pastabų"}</p><footer><span>{task.project || "Asmeniniai"}</span><small>{durationLabel(task.duration_minutes || 30)}</small>{!task.completed && <button onClick={() => onFocus(task)}>▶ Fokusas</button>}</footer></article>)}{!group.list.length && <div className="columnEmpty">Nieko nėra</div>}</section>)}</div></div>; }
function Focus({ task, tasks, seconds, running, onToggle, onReset, onSelect, onDone }: { task?: Task; tasks: Task[]; seconds: number; running: boolean; onToggle: () => void; onReset: () => void; onSelect: (t: Task) => void; onDone: () => void }) { const progress = 1 - seconds / 1500; return <div className="focus"><header><span className="eyebrow">GILUS DARBAS</span><h2>Vienas darbas. Jokių trukdžių.</h2></header><div className="focusGrid"><section className="timer"><div className="timerRing" style={{ background: `conic-gradient(#a7ff6a ${progress * 360}deg,#293447 0)` }}><div><strong>{String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}</strong><span>{running ? "Fokusuojiesi" : "Pasiruošęs"}</span></div></div><h3>{task?.title || "Pasirink užduotį"}</h3><p>{task?.project || "Užduotis nepasirinkta"}</p><div><button onClick={onReset}>↺</button><button className="play" onClick={onToggle}>{running ? "Ⅱ" : "▶"}</button><button disabled={!task || Boolean(task.readonly_reason)} onClick={onDone}>✓</button></div></section><aside><h3>Fokusavimo eilė <b>{tasks.length}</b></h3>{tasks.map((item) => <button className={item.key === task?.key ? "active" : ""} onClick={() => onSelect(item)} key={item.key}><i className={item.priority || "normal"}/><span><strong>{item.title}</strong><small>{item.project || "Asmeniniai"} · {durationLabel(item.duration_minutes || 30)}</small></span></button>)}</aside></div></div>; }

function Modal({ eyebrow, title, onClose, children }: { eyebrow: string; title: string; onClose: () => void; children: React.ReactNode }) {
  const panel = useRef<HTMLElement>(null); const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("input,button,select,textarea")?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); close.current(); }
      if (event.key !== "Tab") return;
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]') || []);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", key);
    return () => {document.removeEventListener("keydown", key); previous?.focus();};
  }, []);
  return <div className="backdrop" onMouseDown={(e) => e.currentTarget === e.target && onClose()}><section ref={panel} className="modal" role="dialog" aria-modal="true" aria-label={title}><header><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div><button aria-label="Uždaryti" onClick={onClose}>×</button></header>{children}</section></div>;
}
function taskSourceLabel(task:Task) {
  return task.source === "local" ? "Vietinė užduotis" : `${task.source === "google" ? "Google Tasks" : "To Do"} · ${task.list_name || "Sąrašas"}`;
}
function TaskDestination({lists,value,onChange,disabled=false}:{lists:TaskList[];value:string;onChange:(value:string)=>void;disabled?:boolean}) {
  return <label className="taskDestination">Naujos užduoties sąrašas<select value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}>
    <option value="local">Vietinės · šiame serveryje</option>
    {value !== "local" && !lists.some(list=>list.key===value) && <option value={value} disabled>Sąrašas nepasiekiamas — pasirink kitą</option>}
    {(["google","microsoft"] as const).map(source=><optgroup key={source} label={source==="google" ? "Google Tasks" : "Microsoft To Do"}>{lists.filter(list=>list.source===source).map(list=><option key={list.key} value={list.key} disabled={!list.writable || list.stale}>{list.name}{!list.writable ? " · tik skaitymui" : list.stale ? " · neatnaujinta" : ""}</option>)}</optgroup>)}
  </select></label>;
}
function TaskModal({onClose,onSave,lists,destination,onDestination}:{onClose:()=>void;onSave:(data:Record<string,unknown>)=>Promise<void>;lists:TaskList[];destination:string;onDestination:(value:string)=>void}) {
  const [saving,setSaving]=useState(false),[error,setError]=useState("");
  const isGoogle=lists.find(list=>list.key===destination)?.source==="google";
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setSaving(true);setError("");
    const data=new FormData(event.currentTarget);
    try {
      await onSave({title:data.get("title"),notes:data.get("notes"),project:data.get("project"),priority:data.get("priority"),duration_minutes:Number(data.get("duration")),tags:data.get("tags"),
        ...(isGoogle ? {due_date:data.get("due") || null} : {due_at:data.get("due") ? new Date(String(data.get("due"))).toISOString() : null})});
    } catch(error) {setError(error instanceof Error ? error.message : "Nepavyko išsaugoti.");} finally {setSaving(false);}
  }
  return <Modal eyebrow="UŽDUOTIS" title="Nauja užduotis" onClose={()=>{if(!saving)onClose();}}>
    {error && <p role="alert" className="formError">{error}</p>}
    <form className="modalForm" onSubmit={submit}>
      <TaskDestination lists={lists} value={destination} onChange={onDestination} disabled={saving}/>
      <label>Pavadinimas<input name="title" required maxLength={1024} placeholder="Ką reikia padaryti?"/></label>
      <label>Pastabos<textarea name="notes" maxLength={8192} placeholder="Kontekstas, nuorodos ar rezultatas…"/></label>
      <div className="formRow"><label>Projektas<select name="project">{projects.map(item=><option key={item}>{item}</option>)}</select></label><label>{isGoogle ? "Prioritetas · tik čia" : "Prioritetas"}<select name="priority"><option value="normal">Normalus</option><option value="high">Aukštas</option><option value="low">Žemas</option></select></label></div>
      <div className="formRow"><label>Trukmė<select name="duration" defaultValue="30"><option value="15">15 min.</option><option value="30">30 min.</option><option value="60">1 val.</option><option value="90">1,5 val.</option></select></label><label>{isGoogle ? "Google užduoties diena" : "Terminas"}<input key={isGoogle ? "date" : "datetime"} name="due" type={isGoogle ? "date" : "datetime-local"}/></label></div>
      {isGoogle && <p className="formHint">Google perduodama tik diena. Darbo valandą planuok kalendoriuje — ji ir prioritetas saugomi tik čia.</p>}
      <label>Žymos<input name="tags" placeholder="pvz. skubiai, namai"/></label>
      <div className="modalActions"><button type="button" disabled={saving} onClick={onClose}>Atšaukti</button><button className="newButton" disabled={saving}>{saving ? "Saugoma…" : "Sukurti"}</button></div>
    </form>
  </Modal>;
}
function EventModal({ initial, outlook, google, outlookReady, googleReady, onClose, onSave }: { initial: Date; outlook: boolean; google: boolean; outlookReady: boolean; googleReady: boolean; onClose: () => void; onSave: () => void }) {
  const start = new Date(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [allDay, setAllDay] = useState(false);
  const startDate = localInput(start).slice(0, 10);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setSaving(true); setError("");
    try {
      const f = new FormData(e.currentTarget);
      const provider = String(f.get("provider"));
      const common = { summary: f.get("summary"), description: f.get("description"), location: f.get("location") || undefined, showAs: f.get("showAs") || undefined, visibility: f.get("visibility") || undefined };
      let body: Record<string, unknown>;
      if (allDay) {
        const sd = String(f.get("startDate")); const ed = String(f.get("endDate")) || sd;
        const nextDay = new Date(ed); nextDay.setDate(nextDay.getDate() + 1);
        body = { ...common, allDay: true, start: sd, end: nextDay.toISOString().slice(0, 10) };
      } else {
        const from = new Date(String(f.get("start"))); const end = new Date(from.getTime() + Number(f.get("duration")) * 60000);
        const rm = f.get("reminderMinutes"); const reminderMinutes = rm !== null && rm !== "" ? Number(rm) : undefined;
        body = { ...common, start: from.toISOString(), end: end.toISOString(), attendees: f.get("attendees"), addMeet: f.get("online") === "on", ...(reminderMinutes !== undefined ? { reminderMinutes } : {}) };
      }
      const response = await fetch(`/api/${provider === "outlook" ? "microsoft" : "google"}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await responseJson(response); await onSave();
    } catch(error) { setError(error instanceof Error ? error.message : "Įvykio sukurti nepavyko."); } finally { setSaving(false); }
  }
  return <Modal eyebrow="KALENDORIUS" title="Naujas įvykis" onClose={onClose}>
    {error && <p className="formError" role="alert">{error}</p>}
    {!outlook && !google ? <div className="connectPrompt"><p>{outlookReady || googleReady ? "Prijunk kalendorių ir kurk tikrus susitikimus." : "Įrašyk OAuth nustatymus į .env failą pagal README."}</p>{outlookReady && <a href="/api/microsoft/connect">Prijungti Outlook</a>}{googleReady && <a href="/api/google/connect">Prijungti Google</a>}</div> :
    <form className="modalForm" onSubmit={submit}>
      <label>Pavadinimas<input name="summary" required autoFocus placeholder="Susitikimo pavadinimas"/></label>
      <div className="formRow"><label>Kalendorius<select name="provider" defaultValue={outlook ? "outlook" : "google"}>{outlook && <option value="outlook">Outlook Calendar</option>}{google && <option value="google">Google Calendar</option>}</select></label>{!allDay && <label>Trukmė<select name="duration" defaultValue="30"><option value="15">15 min.</option><option value="30">30 min.</option><option value="60">1 val.</option><option value="90">1,5 val.</option></select></label>}</div>
      <label className="onlineSwitch"><input type="checkbox" checked={allDay} onChange={e=>setAllDay(e.target.checked)}/><i/>Visos dienos įvykis</label>
      {allDay ? <div className="formRow"><label>Pradžia<input name="startDate" type="date" required defaultValue={startDate}/></label><label>Pabaiga<input name="endDate" type="date" defaultValue={startDate}/></label></div> : <label>Pradžia<input name="start" type="datetime-local" required defaultValue={localInput(start)}/></label>}
      <div className="formRow"><label>Laisvas / užimtas<select name="showAs"><option value="busy">Užimtas</option><option value="free">Laisvas</option></select></label><label>Matomumas<select name="visibility"><option value="">Numatytasis</option><option value="private">Privatus</option></select></label></div>
      {!allDay && <label>Priminimas<select name="reminderMinutes"><option value="">Numatytasis</option><option value="0">Įvykio metu</option><option value="5">5 min. prieš</option><option value="10">10 min. prieš</option><option value="15">15 min. prieš</option><option value="30">30 min. prieš</option><option value="60">1 val. prieš</option><option value="1440">1 d. prieš</option></select></label>}
      <label>Vieta<input name="location" maxLength={1000} placeholder="Kabinetas, miestas arba nuoroda…"/></label>
      {!allDay && <label>Dalyviai<input name="attendees" placeholder="el. paštai, atskirti kableliais"/></label>}
      <label>Aprašymas<textarea name="description" placeholder="Darbotvarkė…"/></label>
      {!allDay && <label className="onlineSwitch"><input name="online" type="checkbox" defaultChecked/><i/>Sukurti Teams / Google Meet nuorodą</label>}
      <div className="modalActions"><button type="button" onClick={onClose}>Atšaukti</button><button className="newButton" disabled={saving}>{saving ? "Kuriama…" : "Sukurti įvykį"}</button></div>
    </form>}
  </Modal>;
}


type TaskStep={id:string;displayName:string;isChecked:boolean};
function TaskSteps({task}:{task:Task}) {
  const [steps,setSteps]=useState<TaskStep[]|null>(null),[newStep,setNewStep]=useState(""),[busy,setBusy]=useState(false);
  const listId=task.list_id,taskId=String(task.id);
  useEffect(()=>{
    if (!listId||!taskId) return;
    fetch(`/api/tasks/steps?listId=${encodeURIComponent(listId)}&taskId=${encodeURIComponent(taskId)}`).then(r=>r.json()).then(d=>setSteps(d.items||[])).catch(()=>setSteps([]));
  },[listId,taskId]);
  async function toggle(step:TaskStep) {
    setBusy(true);
    const next={...step,isChecked:!step.isChecked};
    setSteps(prev=>prev?.map(s=>s.id===step.id?next:s)||null);
    try {await fetch("/api/tasks/steps",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({listId,taskId,stepId:step.id,isChecked:next.isChecked})});}
    catch {setSteps(prev=>prev?.map(s=>s.id===step.id?step:s)||null);}
    finally {setBusy(false);}
  }
  async function addStep() {
    const name=newStep.trim();if(!name)return;setBusy(true);
    try {
      const res=await fetch("/api/tasks/steps",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({listId,taskId,displayName:name})});
      const created=await res.json();if(res.ok) {setSteps(prev=>[...(prev||[]),created]);setNewStep("");}
    } finally {setBusy(false);}
  }
  async function deleteStep(step:TaskStep) {
    setBusy(true);setSteps(prev=>prev?.filter(s=>s.id!==step.id)||null);
    try {await fetch(`/api/tasks/steps?listId=${encodeURIComponent(listId!)}&taskId=${encodeURIComponent(taskId)}&stepId=${encodeURIComponent(step.id)}`,{method:"DELETE"});}
    catch {setSteps(prev=>[...(prev||[]),step]);}
    finally {setBusy(false);}
  }
  if (!listId) return null;
  return <div className="taskSteps"><span className="fieldLabel">Žingsniai</span>
    {steps===null ? <p className="formHint">Kraunama…</p> : <>
      {steps.length>0 && <ul className="stepList">{steps.map(s=><li key={s.id} className={s.isChecked?"done":""}><label><input type="checkbox" checked={s.isChecked} disabled={busy} onChange={()=>void toggle(s)}/><span>{s.displayName}</span></label><button type="button" className="removeAttendee" disabled={busy} onClick={()=>void deleteStep(s)}>×</button></li>)}</ul>}
      <div className="addAttendee"><input type="text" value={newStep} onChange={e=>setNewStep(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();void addStep();}}} placeholder="Naujas žingsnis…" disabled={busy}/><button type="button" onClick={()=>void addStep()} disabled={busy||!newStep.trim()}>Pridėti</button></div>
    </>}
  </div>;
}
function TaskEditor({ task, outlook, taskLists, onClose, onSave, onDelete, onMoved }: {task:Task;outlook:boolean;taskLists:TaskList[];onClose:()=>void;onDelete:()=>Promise<void>;onSave:(patch:Record<string,unknown>)=>Promise<void>;onMoved?:(task:Task)=>void}) {
  const [saving,setSaving] = useState(false); const [reminderBusy,setReminderBusy] = useState(false); const [error,setError] = useState("");
  const [moveTarget,setMoveTarget] = useState(task.list_id||"");
  const [moving,setMoving] = useState(false);
  const googleLists=task.source==="google" ? taskLists.filter(l=>l.source==="google"&&l.account_id===task.account_id&&l.writable&&!l.stale) : [];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (saving || moving || reminderBusy) return; const data = new FormData(event.currentTarget); setSaving(true); setError("");
    try {
      const metadata: Record<string, unknown> = {};
      for (const field of ["title", "notes", "priority"] as const) if (!task.readonly_reason && data.get(field) !== task[field]) metadata[field] = data.get(field);
      for (const field of ["project", "tags"] as const) if(data.get(field)!==task[field]) metadata[field]=data.get(field);
      // datetime-local omits seconds. Preserve the original deadline unless the
      // user actually edits it; moving a task must not write to Microsoft To Do.
      if (!task.readonly_reason) {
        if(task.source === "google") {if(String(data.get("due") || "") !== (task.due_date || "")) metadata.due_date=data.get("due") || null;}
        else if (String(data.get("due") || "") !== (task.due_at ? localInput(new Date(task.due_at)) : "")) metadata.due_at = data.get("due") ? new Date(String(data.get("due"))).toISOString() : null;
      }
      await onSave({...metadata,
        scheduled_at:data.get("scheduled") ? new Date(String(data.get("scheduled"))).toISOString() : null,
        duration_minutes:Number(data.get("duration")),mirror_requested:data.get("mirror") === "on"});
    } catch(error) {setError(error instanceof Error ? error.message : "Nepavyko išsaugoti.");}
    finally {setSaving(false);}
  }
  async function unschedule() {
    if (saving || moving || reminderBusy) return; setSaving(true);
    try {await onSave({scheduled_at:null,mirror_requested:false});}
    catch(error) {setError(error instanceof Error ? error.message : "Nepavyko išsaugoti.");}
    finally {setSaving(false);}
  }
  async function moveToList() {
    if (!moveTarget||moveTarget===task.list_id||saving||moving||reminderBusy) return;
    setMoving(true);setError("");
    try {
      const res=await fetch("/api/tasks/move",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({source:task.source,account_id:task.account_id,list_id:task.list_id,id:task.id,destination_list_id:moveTarget,schedule_version:task.schedule_version})});
      if(!res.ok){const d=await res.json().catch(()=>({}));throw new Error(d.error||"Nepavyko perkelti.");}
      onMoved?.(await res.json());onClose();
    } catch(e){setError(e instanceof Error?e.message:"Nepavyko perkelti.");}
    finally{setMoving(false);}
  }
  return <Modal eyebrow={taskSourceLabel(task)} title="Užduotis ir jos planas" onClose={onClose}>
    {task.source_url && <p className="formHint"><a href={task.source_url} target="_blank" rel="noopener noreferrer">{task.source === "google" ? "Atverti Google Tasks" : "Atverti Microsoft To Do"} ↗</a>{task.parent_id && " · Pavaldžioji užduotis. Hierarchiją keisk Google Tasks."}</p>}
    {task.readonly_reason && <p className="formHint">{task.readonly_reason}</p>}
    {task.stale && <p className="formHint">Rodomi paskutiniai išsaugoti duomenys. Pakeitimams šaltinyje reikalingas ryšys.</p>}
    {task.legacy_schedule ? <p className="formHint">Šis laikas perkeltas iš ankstesnio plano. Terminas išsaugotas atskirai — patikrink abi reikšmes.</p> : null}
    {task.mirror_error && <p role="status" className="formHint">{task.mirror_error} Spausk „Išsaugoti“, kad pakartotum.</p>}
    {error && <p role="alert" className="formError">{error}</p>}
    <form className="modalForm" onSubmit={submit}>
      <label>Pavadinimas<input name="title" required disabled={Boolean(task.readonly_reason)} defaultValue={task.title}/></label>
      <label>Pastabos<textarea name="notes" disabled={Boolean(task.readonly_reason)} defaultValue={task.notes}/></label>
      <div className="formRow"><label>Projektas · tik čia<input name="project" maxLength={200} defaultValue={task.project}/></label><label>Žymos · tik čia<input name="tags" maxLength={1000} defaultValue={task.tags}/></label></div>
      <div className="formRow"><label>{task.source === "google" ? "Google užduoties diena" : "Terminas"}<input name="due" disabled={Boolean(task.readonly_reason)} type={task.source === "google" ? "date" : "datetime-local"} defaultValue={task.source === "google" ? task.due_date || "" : task.due_at ? localInput(new Date(task.due_at)) : ""}/></label><label>{task.source === "google" ? "Prioritetas · tik čia" : "Prioritetas"}<select name="priority" disabled={Boolean(task.readonly_reason)} defaultValue={task.priority}><option value="low">Žemas</option><option value="normal">Normalus</option><option value="high">Aukštas</option></select></label></div>
      <div className="formRow"><label>Suplanuota pradžia<input name="scheduled" type="datetime-local" disabled={Boolean(task.completed)} defaultValue={task.scheduled_at ? localInput(new Date(task.scheduled_at)) : ""}/></label><label>Trukmė minutėmis<input name="duration" type="number" min="5" max="1440" step="5" required defaultValue={task.duration_minutes}/></label></div>
      <p className="formHint">{task.source === "google" ? "Google diena ir vietinis darbo laikas yra atskiri. Prioritetas taip pat saugomas tik čia." : "Planavimas nekeičia užduoties termino. Laikas saugomas šioje programėlėje."}</p>
      <label className="onlineSwitch"><input name="mirror" type="checkbox" disabled={!outlook && !task.mirror_requested} defaultChecked={Boolean(task.mirror_requested)}/><i/>Papildomas Outlook blokas · laisvas laikas</label>
      <div className="modalActions">{task.scheduled_at && <button type="button" disabled={saving || moving || reminderBusy} onClick={unschedule}>Pašalinti planavimą</button>}<button className="newButton" disabled={saving || moving || reminderBusy}>{saving ? "Saugoma…" : "Išsaugoti"}</button></div>
    </form>
    {task.source === "microsoft" && <TaskSteps task={task}/>}
    {task.source === "microsoft" && (
      <MicrosoftTaskReminder key={task.key} task={task} disabled={saving} onBusyChange={setReminderBusy}/>
    )}
    {googleLists.length>1 && <div className="moveToList"><span className="fieldLabel">Perkelti į sąrašą</span><div className="addAttendee"><select value={moveTarget} onChange={e=>setMoveTarget(e.target.value)} disabled={saving||moving||reminderBusy}>{googleLists.map(l=><option key={l.key} value={l.list_id}>{l.name}</option>)}</select><button type="button" disabled={saving||moving||reminderBusy||moveTarget===task.list_id} onClick={()=>void moveToList()}>{moving?"Keliama…":"Perkelti"}</button></div></div>}
    <div className="modalActions"><button type="button" disabled={saving || moving || reminderBusy || Boolean(task.readonly_reason)} onClick={async()=>{if(saving || moving || reminderBusy)return;if(!window.confirm(`Ištrinti „${task.title}“${task.source === "local" ? "" : " ir jos šaltinyje"}?`))return;setSaving(true);setError("");try{await onDelete();}catch(error){setError(error instanceof Error ? error.message : "Nepavyko ištrinti.");}finally{setSaving(false);}}}>Ištrinti užduotį</button></div>
  </Modal>;
}

type CalInfo={id:string;name:string;color?:string;primary?:boolean;isDefault?:boolean;writable:boolean};
type CalList={items:CalInfo[];enabled:string[]|null};
function CalendarSelector({google,outlook,onSaved}:{google:boolean;outlook:boolean;onSaved:()=>void}) {
  const [gCals,setGCals]=useState<CalList|null>(null),[mCals,setMCals]=useState<CalList|null>(null),[saving,setSaving]=useState(false),[error,setError]=useState("");
  useEffect(()=>{
    if(google)fetch("/api/google/calendars").then(r=>r.json()).then(setGCals).catch(()=>{});
    if(outlook)fetch("/api/microsoft/calendars").then(r=>r.json()).then(setMCals).catch(()=>{});
  },[google,outlook]);
  function isEnabled(list:CalList,id:string){return list.enabled===null ? true : list.enabled.includes(id);}
  async function toggle(provider:"google"|"microsoft",list:CalList,setList:(v:CalList)=>void,cal:CalInfo,checked:boolean){
    const wasAll=list.enabled===null;const prev=wasAll ? list.items.map(c=>c.id) : list.enabled!;
    const next=checked ? [...prev.filter(id=>id!==cal.id),cal.id] : prev.filter(id=>id!==cal.id);
    const newList:CalList={...list,enabled:next};setList(newList);setSaving(true);setError("");
    try {
      const enabled=next.map(id=>{const c=list.items.find(x=>x.id===id);return c?{id:c.id,...(c.name?{name:c.name}:{}),...(c.color?{color:c.color}:{})}:{id};});
      const res=await fetch(`/api/${provider==="google"?"google":"microsoft"}/calendars`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({enabled})});
      if(!res.ok)throw new Error("Nepavyko išsaugoti");
      onSaved();
    } catch(e){setError(e instanceof Error?e.message:"Klaida");setList(list);}
    finally{setSaving(false);}
  }
  function renderList(provider:"google"|"microsoft",list:CalList|null,setList:(v:CalList)=>void,label:string){
    if(!list) return <p className="formHint">Kraunama…</p>;
    if(!list.items.length) return null;
    return <><p className="calProviderLabel">{label}</p><ul className="calendarList">{list.items.map(cal=><li key={cal.id}><label><input type="checkbox" checked={isEnabled(list,cal.id)} disabled={saving} onChange={e=>void toggle(provider,list,setList,cal,e.target.checked)}/>{cal.color&&<span className="calDot" style={{background:cal.color}}/>}<span className="calName">{cal.name}</span>{(cal.primary||cal.isDefault)&&<span className="calBadge">pagrindinis</span>}</label></li>)}</ul></>;
  }
  return <div className="calendarSelector">{error&&<p className="formError">{error}</p>}{renderList("google",gCals,setGCals,"Google")}{renderList("microsoft",mCals,setMCals,"Microsoft / Outlook")}</div>;
}
function rsvpIcon(status:string) { return status==="accepted"?"✓":status==="declined"?"✗":status==="tentative"?"?":"·"; }
function BackupPanel() {
  const [busy,setBusy]=useState<"export"|"backup"|"restore"|null>(null);
  const [msg,setMsg]=useState("");
  const fileRef=useRef<HTMLInputElement>(null);

  async function download(type:"export"|"backup") {
    setBusy(type);setMsg("");
    try {
      const res=await fetch("/api/backup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:type==="backup"?"full":"export"})});
      if (!res.ok) { const data=await res.json().catch(()=>({}));setMsg(data.error??"Nepavyko sukurti atsarginės kopijos."); return; }
      const blob=await res.blob();
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");
      a.href=url;
      a.download=res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `planner-${type}.db`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { setMsg("Tinklo klaida."); } finally { setBusy(null); }
  }

  async function restore(e:React.ChangeEvent<HTMLInputElement>) {
    const file=e.target.files?.[0];
    if (!file) return;
    setBusy("restore");setMsg("");
    try {
      const res=await fetch("/api/backup",{method:"PUT",headers:{"Content-Type":"application/octet-stream"},body:file});
      const data=await res.json().catch(()=>({}));
      if (res.ok) { setMsg("Atkurta. Puslapis bus atnaujintas."); setTimeout(()=>location.reload(),1500); }
      else setMsg(data.error ?? "Atkurti nepavyko.");
    } catch { setMsg("Tinklo klaida."); } finally { setBusy(null); if(fileRef.current) fileRef.current.value=""; }
  }

  return <div className="backupPanel">
    <p className="backupHint">Eksportas neįtraukia OAuth žetonų — tinka duomenų perkėlimui. Pilna kopija — tik saugiam asmeniniam naudojimui.</p>
    <div className="backupButtons">
      <button className="ghostButton" disabled={!!busy} onClick={()=>download("export")}>
        {busy==="export"?"Kuriama…":"⬇ Eksportuoti (be žetonų)"}
      </button>
      <button className="ghostButton" disabled={!!busy} onClick={()=>download("backup")}>
        {busy==="backup"?"Kuriama…":"⬇ Pilna kopija"}
      </button>
      <label className={`ghostButton${busy?"":""}`} style={{cursor:busy?"not-allowed":"pointer",opacity:busy?0.55:1}}>
        {busy==="restore"?"Atkuriama…":"⬆ Atkurti iš kopijos"}
        <input ref={fileRef} type="file" accept=".db" style={{display:"none"}} disabled={!!busy} onChange={restore}/>
      </label>
    </div>
    {msg && <p className="backupMsg" role="status">{msg}</p>}
  </div>;
}

function LogoutButton() {
  const [busy,setBusy]=useState(false);
  async function logout() {
    setBusy(true);
    try { await fetch("/api/auth/logout",{method:"POST"}); window.location.href="/login"; } catch { setBusy(false); }
  }
  return <button className="logoutBtn" disabled={busy} onClick={logout}>{busy?"Atsijungiama…":"Atsijungti iš programėlės →"}</button>;
}
function ExistingEventEditor({value,onClose,onSave,onRefresh}:{value:{event:CalEvent;start?:string;end?:string};onClose:()=>void;onSave:(patch:Record<string,unknown>)=>Promise<void>;onRefresh?:()=>void}) {
  const {event}=value;
  const [error,setError]=useState(""),[saving,setSaving]=useState(false),[conflict,setConflict]=useState(false);
  const [attendees,setAttendees]=useState<{email:string;name?:string;self?:boolean;responseStatus:string}[]>(event.attendees||[]);
  const [newEmail,setNewEmail]=useState("");
  function addAttendee() {
    const e=newEmail.trim().toLowerCase();
    if (!e||!e.includes("@")||e.length>256||attendees.some(a=>a.email===e)) return;
    setAttendees(prev=>[...prev,{email:e,responseStatus:"needsAction"}]);setNewEmail("");
  }
  function removeAttendee(email:string) {setAttendees(prev=>prev.filter(a=>a.email!==email));}
  async function submit(e:FormEvent<HTMLFormElement>) {
    e.preventDefault();const data=new FormData(e.currentTarget);setError("");setSaving(true);
    try {
      const originalStart=value.start || event.start.dateTime!,originalEnd=value.end || event.end.dateTime!;
      const start=new Date(String(data.get("start"))===localInput(new Date(originalStart)) ? originalStart : String(data.get("start"))),end=new Date(String(data.get("end"))===localInput(new Date(originalEnd)) ? originalEnd : String(data.get("end")));
      if(end<=start)throw new Error("Pabaiga turi būti vėliau už pradžią.");
      const attendeesChanged=JSON.stringify(attendees.map(a=>a.email).sort())!==JSON.stringify((event.attendees||[]).map(a=>a.email).sort());
      setConflict(false);
      await onSave({start:start.toISOString(),end:end.toISOString(),summary:data.get("summary"),description:data.get("description")||undefined,location:data.get("location")||undefined,
        ...(attendeesChanged ? {attendees:attendees.map(a=>({email:a.email}))} : {}),
        confirmAttendees:data.get("confirm")==="on"});
    } catch(err) {
      const msg=err instanceof Error ? err.message : "";
      const isVersionConflict=err instanceof HttpError && err.status===409 && /pakeistas kitur|pasikeitė/i.test(msg);
      setConflict(isVersionConflict);
      setError(msg || "Nepavyko išsaugoti.");
    }
    finally {setSaving(false);}
  }
  const safeLink=event.htmlLink?.startsWith("https://") ? event.htmlLink : undefined;
  return <Modal eyebrow={event.provider==="outlook"?"OUTLOOK":"GOOGLE CALENDAR"} title="Kalendoriaus įvykis" onClose={()=>{if(!saving)onClose();}}>
    {!event.editable && <p className="formHint">{event.readOnlyReason}</p>}
    {event.recurring && event.editable && <p className="formHint">↻ Kartojamas įvykis. Keičiamas tik šis egzempliorius — serija lieka nepakeista.</p>}
    {error && <p className="formError" role="alert">{error}{conflict && onRefresh && <> <button type="button" className="inlineRefreshBtn" onClick={()=>{onRefresh();onClose();}}>Atnaujinti ir uždaryti →</button></>}</p>}
    <form className="modalForm" onSubmit={submit}>
      <label>Pavadinimas<input name="summary" required maxLength={1024} defaultValue={event.summary} disabled={!event.editable || saving}/></label>
      <label>Vieta<input name="location" maxLength={1000} defaultValue={event.location || ""} disabled={!event.editable || saving} placeholder="Kabinetas, miestas arba nuoroda…"/></label>
      <label>Aprašymas<textarea name="description" maxLength={10000} defaultValue={event.description || ""} disabled={!event.editable || saving} placeholder="Darbotvarkė…"/></label>
      {!event.allDay && <div className="formRow"><label>Pradžia<input name="start" type="datetime-local" required disabled={!event.editable || saving} defaultValue={localInput(new Date(value.start || event.start.dateTime!))}/></label><label>Pabaiga<input name="end" type="datetime-local" required disabled={!event.editable || saving} defaultValue={localInput(new Date(value.end || event.end.dateTime!))}/></label></div>}
      {event.allDay && <p className="formHint">{event.start.date || event.start.dateTime} – {event.end.date || event.end.dateTime}</p>}
      <div className="attendeeSection">
        <span className="fieldLabel">Dalyviai</span>
        {attendees.length>0 && <ul className="attendeeList">{attendees.map(a=><li key={a.email} title={a.responseStatus} className={`rsvp-${a.responseStatus}`}><span className="rsvpIcon">{rsvpIcon(a.responseStatus)}</span><span className="attendeeName">{a.name||a.email}</span>{a.name&&<span className="attendeeEmail"> {a.email}</span>}{event.editable&&!a.self&&<button type="button" className="removeAttendee" aria-label={`Pašalinti: ${a.email}`} disabled={saving} onClick={()=>removeAttendee(a.email)}>×</button>}</li>)}</ul>}
        {attendees.length===0 && <p className="formHint noAttendees">Be dalyvių</p>}
        {event.editable && <div className="addAttendee"><input type="email" value={newEmail} onChange={e=>setNewEmail(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();addAttendee();}}} placeholder="el.paštas@pavyzdys.lt" disabled={saving}/><button type="button" onClick={addAttendee} disabled={saving||!newEmail.trim()}>Pridėti</button></div>}
      </div>
      {event.editable && attendees.length>0 && <label className="confirmAttendees"><input type="checkbox" name="confirm" disabled={saving}/>Patvirtinu pakeitimus — bus išsiųsti pranešimai dalyviams, jei laikas pasikeitė</label>}
      <p className="formHint">Keičiami pavadinimas, vieta, aprašymas, laikas ir dalyviai. Priminimai bei susitikimo nuoroda išsaugomi.</p>
      <div className="modalActions">{safeLink && <a className="originalEvent" href={safeLink} target="_blank" rel="noopener noreferrer">Atverti originalą ↗</a>}{event.editable && <button className="newButton" disabled={saving}>{saving?"Saugoma…":"Išsaugoti įvykį"}</button>}</div>
    </form>
  </Modal>;
}
