import type { CalendarEvent } from "./calendar-events";
import type { Task } from "./task-service";

// Use the tasks actually displayed in this view, so a UI filter cannot hide
// both representations. Missing or ambiguous evidence stays visible.
export function visibleCalendarEvents(events:CalendarEvent[],tasks:Task[]):CalendarEvent[] {
  const links=new Map<string,number>();
  for (const event of events) if(event.mirrorTaskKey) links.set(event.mirrorTaskKey,(links.get(event.mirrorTaskKey)||0)+1);
  const byKey=new Map(tasks.map(task=>[task.key,task]));
  return events.filter(event=>{
    const task=event.mirrorTaskKey ? byKey.get(event.mirrorTaskKey) : undefined;
    if (!task || links.get(task.key)!==1 || event.provider!=="outlook" || event.allDay || event.recurring || event.attendeeCount
      || task.completed || task.stale || !task.mirror_requested || task.mirror_error || task.mirror_event_id!==event.id || !task.scheduled_at
      || event.summary!==`✓ ${task.title}`) return true;
    const start=Date.parse(task.scheduled_at),end=start+task.duration_minutes*60000;
    return !Number.isFinite(start) || !Number.isFinite(end)
      || Date.parse(event.start.dateTime||"")!==start || Date.parse(event.end.dateTime||"")!==end;
  });
}
