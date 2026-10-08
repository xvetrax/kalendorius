import type { CalendarEvent } from "./calendar-events.ts";
import type { Task } from "./task-service.ts";

export type QuickTaskParse = {
  title: string;
  durationMinutes: number;
  date: string | null;
  time: string | null;
  scheduledAt: string | null;
  dueDate: string | null;
  recognized: string[];
  valid: boolean;
};

export type DailyInterval = { start: Date; end: Date };
export type DailySummary = {
  dayStart: Date;
  workStart: Date;
  workEnd: Date;
  nextEvent: CalendarEvent | null;
  nextEventStartsAt: Date | null;
  allDayEvents: CalendarEvent[];
  tasks: Task[];
  overdueTasks: Task[];
  freeGaps: DailyInterval[];
  workMinutes: number;
  calendarBusyMinutes: number;
  plannedTaskMinutes: number;
  remainingMinutes: number;
};

const weekdayTokens: Record<string, number> = {
  "sekmadieni": 0,
  "pirmadieni": 1,
  "antradieni": 2,
  "treciadieni": 3,
  "ketvirtadieni": 4,
  "penktadieni": 5,
  "sestadieni": 6,
};

function fold(value: string) {
  return value.toLocaleLowerCase("lt-LT").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localInstant(date: string, time: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function removeRange(value: string, start: number, length: number) {
  return `${value.slice(0, start)} ${value.slice(start + length)}`;
}

export function parseQuickTaskInput(input: string, now = new Date()): QuickTaskParse {
  let rest = input.trim();
  const recognized: string[] = [];
  let durationMinutes = 30;
  let date: string | null = null;
  let time: string | null = null;

  const durationMatch = /(?:^|\s)(\d{1,3})\s*(min(?:\.|uc(?:iu|iu)?)?|val(?:\.|anda|andos|andu)?|h)(?=\s|$)/iu.exec(rest);
  if (durationMatch) {
    const amount = Number(durationMatch[1]);
    const unit = fold(durationMatch[2]);
    durationMinutes = unit.startsWith("val") || unit === "h" ? amount * 60 : amount;
    recognized.push(`${durationMinutes} min.`);
    rest = removeRange(rest, durationMatch.index, durationMatch[0].length);
  }

  const timeMatch = /(?:^|\s)([01]?\d|2[0-3]):([0-5]\d)(?=\s|$)/u.exec(rest);
  if (timeMatch) {
    time = `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}`;
    recognized.push(time);
    rest = removeRange(rest, timeMatch.index, timeMatch[0].length);
  }

  const folded = fold(rest);
  const dateToken = /\b(siandien|rytoj|pirmadieni|antradieni|treciadieni|ketvirtadieni|penktadieni|sestadieni|sekmadieni)\b/u.exec(folded);
  if (dateToken) {
    const selected = new Date(now);
    selected.setHours(0, 0, 0, 0);
    if (dateToken[1] === "rytoj") selected.setDate(selected.getDate() + 1);
    else if (dateToken[1] !== "siandien") {
      const target = weekdayTokens[dateToken[1]];
      let offset = (target - selected.getDay() + 7) % 7;
      if (offset === 0) offset = 7;
      selected.setDate(selected.getDate() + offset);
    }
    date = localDateKey(selected);
    recognized.push(dateToken[1] === "siandien" ? "šiandien" : dateToken[1] === "rytoj" ? "rytoj" : date);
    rest = removeRange(rest, dateToken.index, dateToken[0].length);
  }

  if (time && !date) date = localDateKey(now);
  const title = rest.replace(/\s+/g, " ").replace(/^[,;\-–—]+|[,;\-–—]+$/g, "").trim();
  const scheduledAt = date && time ? localInstant(date, time).toISOString() : null;
  const dueDate = date && !time ? date : null;
  return {
    title,
    durationMinutes,
    date,
    time,
    scheduledAt,
    dueDate,
    recognized,
    valid: Boolean(title) && durationMinutes >= 5 && durationMinutes <= 1440,
  };
}

function dateKeyForTask(task: Task) {
  if (task.due_date) return task.due_date.slice(0, 10);
  if (task.due_at) return localDateKey(new Date(task.due_at));
  return null;
}

function eventBounds(event: CalendarEvent): DailyInterval | null {
  const startValue = event.start.dateTime || event.start.date;
  const endValue = event.end.dateTime || event.end.date;
  if (!startValue || !endValue) return null;
  const start = new Date(startValue.length === 10 ? `${startValue}T00:00:00` : startValue);
  const end = new Date(endValue.length === 10 ? `${endValue}T00:00:00` : endValue);
  return Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && end > start ? { start, end } : null;
}

function clip(interval: DailyInterval, start: Date, end: Date): DailyInterval | null {
  const clipped = {start: new Date(Math.max(interval.start.getTime(), start.getTime())), end: new Date(Math.min(interval.end.getTime(), end.getTime()))};
  return clipped.end > clipped.start ? clipped : null;
}

function merge(intervals: DailyInterval[]) {
  const sorted = intervals.slice().sort((a, b) => a.start.getTime() - b.start.getTime());
  const result: DailyInterval[] = [];
  for (const interval of sorted) {
    const last = result.at(-1);
    if (!last || interval.start > last.end) result.push({start:new Date(interval.start),end:new Date(interval.end)});
    else if (interval.end > last.end) last.end = new Date(interval.end);
  }
  return result;
}

function minutes(intervals: DailyInterval[]) {
  return Math.round(intervals.reduce((sum, interval) => sum + interval.end.getTime() - interval.start.getTime(), 0) / 60_000);
}

export function buildDailySummary(tasks: Task[], events: CalendarEvent[], now = new Date(), workHours = {start:9,end:17}): DailySummary {
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  const workStart = new Date(dayStart); workStart.setHours(workHours.start, 0, 0, 0);
  const workEnd = new Date(dayStart); workEnd.setHours(workHours.end, 0, 0, 0);
  const dayKey = localDateKey(dayStart);
  const openTasks = tasks.filter(task => !task.completed);
  const scheduledTasks = openTasks.filter(task => {
    if (!task.scheduled_at) return false;
    const start = new Date(task.scheduled_at);
    const end = new Date(start.getTime() + (task.duration_minutes || 30) * 60_000);
    return Number.isFinite(start.getTime()) && end > dayStart && start < dayEnd;
  });
  const dueToday = openTasks.filter(task => dateKeyForTask(task) === dayKey);
  const todayTasks = Array.from(new Map([...scheduledTasks, ...dueToday].map(task => [task.key, task])).values());
  const overdueTasks = openTasks.filter(task => {
    const due = dateKeyForTask(task);
    return Boolean(due && due < dayKey);
  });

  const dayEvents = events.flatMap(event => {
    const bounds = eventBounds(event);
    return bounds && clip(bounds, dayStart, dayEnd) ? [event] : [];
  });
  const allDayEvents = dayEvents.filter(event => event.allDay);
  const timedEvents = dayEvents.filter(event => !event.allDay);
  const nextEvent = timedEvents
    .map(event => ({event,bounds:eventBounds(event)!}))
    .filter(item => item.bounds.end > now)
    .sort((a,b) => a.bounds.start.getTime() - b.bounds.start.getTime())[0] ?? null;

  const busyIntervals = timedEvents.flatMap(event => {
    if (event.showAs === "free") return [];
    const bounds = eventBounds(event);
    const value = bounds && clip(bounds, workStart, workEnd);
    return value ? [value] : [];
  });
  const taskIntervals = scheduledTasks.flatMap(task => {
    const start = new Date(task.scheduled_at!);
    const value = clip({start,end:new Date(start.getTime() + (task.duration_minutes || 30) * 60_000)},workStart,workEnd);
    return value ? [value] : [];
  });
  const occupied = merge([...busyIntervals, ...taskIntervals]);
  const freeGaps: DailyInterval[] = [];
  let cursor = workStart;
  for (const interval of occupied) {
    if (interval.start.getTime() - cursor.getTime() >= 15 * 60_000) freeGaps.push({start:new Date(cursor),end:new Date(interval.start)});
    if (interval.end > cursor) cursor = interval.end;
  }
  if (workEnd.getTime() - cursor.getTime() >= 15 * 60_000) freeGaps.push({start:new Date(cursor),end:new Date(workEnd)});
  const workMinutes = Math.max(0, Math.round((workEnd.getTime() - workStart.getTime()) / 60_000));
  return {
    dayStart,workStart,workEnd,
    nextEvent:nextEvent?.event ?? null,
    nextEventStartsAt:nextEvent?.bounds.start ?? null,
    allDayEvents,
    tasks:todayTasks.sort((a,b)=>(a.scheduled_at ?? "9999").localeCompare(b.scheduled_at ?? "9999")),
    overdueTasks,
    freeGaps,
    workMinutes,
    calendarBusyMinutes:minutes(merge(busyIntervals)),
    plannedTaskMinutes:minutes(taskIntervals),
    remainingMinutes:Math.max(0,workMinutes-minutes(occupied)),
  };
}

export function dailyDurationLabel(value: number) {
  if (value < 60) return `${value} min.`;
  const hours = Math.floor(value / 60), remainder = value % 60;
  return `${hours} val.${remainder ? ` ${remainder} min.` : ""}`;
}
