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
export function dateAtMinute(day: Date, minute: number): Date {
  const value = Math.min(1425, Math.max(0, Math.round(minute / 15) * 15));
  const date = new Date(day); date.setHours(0, value, 0, 0);
  // A wall-clock grid cannot select which occurrence of a repeated hour is intended.
  // Reject both nonexistent and ambiguous times instead of silently moving work.
  const ambiguous = [-120, -60, 60, 120].some(delta => {
    const other = new Date(date.getTime() + delta * 60000);
    return other.toDateString() === date.toDateString() && minuteOfDay(other) === value;
  });
  if (minuteOfDay(date) !== value || ambiguous) throw new Error("Šis laikas keičiasi dėl vasaros / žiemos laiko. Pasirink kitą laiką.");
  return date;
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
