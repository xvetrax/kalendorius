export const recurrenceFrequencies = ["daily", "weekly", "monthly", "yearly"] as const;
export const recurrenceWeekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

export type TaskRecurrence = {
  frequency: typeof recurrenceFrequencies[number];
  interval: number;
  start_date: string;
  days_of_week?: typeof recurrenceWeekdays[number][];
  day_of_month?: number;
  month?: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function dateOnly(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1601 || year > 9999 || new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== value) return null;
  return value;
}

export function taskRecurrenceDate(value: unknown) {
  return dateOnly(value);
}

function integer(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every(key => allowed.includes(key));
}

export function parseTaskRecurrence(value: unknown): TaskRecurrence | null {
  const input = record(value);
  if (!input || !recurrenceFrequencies.includes(input.frequency as TaskRecurrence["frequency"])) return null;
  const frequency = input.frequency as TaskRecurrence["frequency"];
  const interval = integer(input.interval, 1, 999);
  const start_date = dateOnly(input.start_date);
  if (!interval || !start_date) return null;

  if (frequency === "daily") {
    return exactKeys(input, ["frequency", "interval", "start_date"]) ? {frequency, interval, start_date} : null;
  }
  if (frequency === "weekly") {
    if (!exactKeys(input, ["frequency", "interval", "start_date", "days_of_week"]) || !Array.isArray(input.days_of_week)) return null;
    const days = input.days_of_week;
    if (!days.length || days.some(day => !recurrenceWeekdays.includes(day as typeof recurrenceWeekdays[number]))) return null;
    const unique = [...new Set(days as typeof recurrenceWeekdays[number][])];
    if (unique.length !== days.length) return null;
    unique.sort((left, right) => recurrenceWeekdays.indexOf(left) - recurrenceWeekdays.indexOf(right));
    return {frequency, interval, start_date, days_of_week:unique};
  }
  if (frequency === "monthly") {
    const day = integer(input.day_of_month, 1, 31);
    return day && exactKeys(input, ["frequency", "interval", "start_date", "day_of_month"])
      ? {frequency, interval, start_date, day_of_month:day} : null;
  }
  const month = integer(input.month, 1, 12), day = integer(input.day_of_month, 1, 31);
  const validDate = month && day && new Date(Date.UTC(2000, month - 1, day)).getUTCMonth() === month - 1;
  return month && day && validDate && exactKeys(input, ["frequency", "interval", "start_date", "day_of_month", "month"])
    ? {frequency, interval, start_date, day_of_month:day, month} : null;
}

export function providerRecurrence(value: unknown): {supported: boolean; recurrence: TaskRecurrence | null} {
  if (value === null || value === undefined) return {supported:true, recurrence:null};
  const source = record(value), pattern = record(source?.pattern), range = record(source?.range);
  if (!pattern || !range || range.type !== "noEnd") return {supported:false, recurrence:null};
  const interval = pattern.interval, start_date = range.startDate;
  let candidate: unknown;
  if (pattern.type === "daily") candidate = {frequency:"daily", interval, start_date};
  else if (pattern.type === "weekly") candidate = {frequency:"weekly", interval, start_date, days_of_week:pattern.daysOfWeek};
  else if (pattern.type === "absoluteMonthly") candidate = {frequency:"monthly", interval, start_date, day_of_month:pattern.dayOfMonth};
  else if (pattern.type === "absoluteYearly") candidate = {frequency:"yearly", interval, start_date, day_of_month:pattern.dayOfMonth, month:pattern.month};
  else return {supported:false, recurrence:null};
  const recurrence = parseTaskRecurrence(candidate);
  return recurrence ? {supported:true, recurrence} : {supported:false, recurrence:null};
}

export function graphRecurrence(rule: TaskRecurrence) {
  const pattern = rule.frequency === "daily" ? {type:"daily", interval:rule.interval}
    : rule.frequency === "weekly" ? {type:"weekly", interval:rule.interval, daysOfWeek:rule.days_of_week, firstDayOfWeek:"monday"}
    : rule.frequency === "monthly" ? {type:"absoluteMonthly", interval:rule.interval, dayOfMonth:rule.day_of_month}
    : {type:"absoluteYearly", interval:rule.interval, dayOfMonth:rule.day_of_month, month:rule.month};
  return {pattern, range:{type:"noEnd", startDate:rule.start_date}};
}

export function sameTaskRecurrence(left: TaskRecurrence | null, right: TaskRecurrence | null) {
  return JSON.stringify(left) === JSON.stringify(right);
}
