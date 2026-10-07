export const DAY_MINUTES = 1440;
export const MIN_BLOCK_HEIGHT = 38;
export type TimedItem = { key: string; start: Date; end: Date };
export type DaySegment = TimedItem & { top: number; height: number; column: number; columns: number; continuesBefore: boolean; continuesAfter: boolean; gestureSafe: boolean };

export function minuteOfDay(date: Date) { return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60; }
export function dayBounds(day: Date) {
  const start = new Date(day); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  return { start, end };
}
export function touchesDay(start: Date, end: Date, day: Date) {
  const bounds = dayBounds(day);
  return end > start && start < bounds.end && end > bounds.start;
}
export function datesAtMinute(day: Date, minute: number): Date[] {
  const value = Math.min(1425, Math.max(0, Math.round(minute / 15) * 15));
  const expected = new Date(day); expected.setHours(0, 0, 0, 0);
  const seed = new Date(expected); seed.setHours(0, value, 0, 0);
  const matches = new Map<number,Date>();
  for(let delta=-180;delta<=180;delta+=15){
    const candidate=new Date(seed.getTime()+delta*60000);
    if(candidate.getFullYear()===expected.getFullYear()&&candidate.getMonth()===expected.getMonth()&&candidate.getDate()===expected.getDate()&&minuteOfDay(candidate)===value)matches.set(candidate.getTime(),candidate);
  }
  return [...matches.values()].sort((a,b)=>a.getTime()-b.getTime());
}
export function dateAtMinute(day: Date, minute: number, occurrence:"reject"|"earlier"|"later"="reject"): Date {
  const matches=datesAtMinute(day,minute);
  if(matches.length===1)return matches[0];
  if(matches.length===2&&occurrence!=="reject")return occurrence==="earlier"?matches[0]:matches[1];
  throw new Error(matches.length===2?"Ši valanda kartojasi dėl žiemos laiko. Pasirink pirmą arba antrą kartą.":"Šis laikas neegzistuoja dėl vasaros laiko. Pasirink kitą laiką.");
}
export function autoScrollDelta(pointer:number,start:number,end:number,edge=72,maxStep=28){
  if(!Number.isFinite(pointer)||!Number.isFinite(start)||!Number.isFinite(end)||end<=start||edge<=0||maxStep<=0)return 0;
  if(pointer<start+edge)return -Math.ceil(maxStep*Math.min(1,(start+edge-pointer)/edge));
  if(pointer>end-edge)return Math.ceil(maxStep*Math.min(1,(pointer-(end-edge))/edge));
  return 0;
}

export function layoutDay(items: TimedItem[], day: Date): DaySegment[] {
  const bounds = dayBounds(day);
  const segments: DaySegment[] = items.filter(item => touchesDay(item.start, item.end, day)).map(item => {
    const continuesBefore = item.start < bounds.start, continuesAfter = item.end > bounds.end;
    const top = continuesBefore ? 0 : minuteOfDay(item.start);
    const bottom = item.end >= bounds.end ? DAY_MINUTES : minuteOfDay(item.end);
    const offsetChange = item.start.getTimezoneOffset() !== item.end.getTimezoneOffset();
    const height = Math.min(DAY_MINUTES - top, Math.max(MIN_BLOCK_HEIGHT, bottom - top, offsetChange ? (item.end.getTime() - item.start.getTime()) / 60000 : 0));
    return {...item, top, height, column: 0, columns: 1, continuesBefore, continuesAfter,
      gestureSafe: !continuesBefore && !continuesAfter && !offsetChange && bounds.end.getTime() - bounds.start.getTime() === DAY_MINUTES * 60000};
  }).sort((a,b) => a.top - b.top || b.height - a.height || a.key.localeCompare(b.key));
  let group: DaySegment[] = [], ends: number[] = [], groupEnd = -1;
  function finish() { for (const item of group) item.columns = ends.length; group = []; ends = []; }
  for (const item of segments) {
    if (item.top >= groupEnd) { finish(); groupEnd = -1; }
    let column = ends.findIndex(end => end <= item.top);
    if (column < 0) column = ends.length;
    item.column = column; ends[column] = item.top + item.height;
    groupEnd = Math.max(groupEnd, ends[column]); group.push(item);
  }
  finish(); return segments;
}

export function segmentStyle(segment: DaySegment, preview?: number | null) {
  return { top: segment.top, height: Math.min(DAY_MINUTES - segment.top, Math.max(MIN_BLOCK_HEIGHT, preview ?? segment.height)),
    left: `calc(${segment.column * 100 / segment.columns}% + 4px)`, right: "auto",
    width: `calc(${100 / segment.columns}% - 8px)` };
}
