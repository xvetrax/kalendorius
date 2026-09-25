import {zonedInstant} from "./calendar-time-zone.ts";

export const calendarRecurrenceFrequencies=["daily","weekly","monthly","yearly"] as const;
export const calendarRecurrenceWeekdays=["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] as const;
export type CalendarRecurrenceWeekday=typeof calendarRecurrenceWeekdays[number];
export type CalendarRecurrence={
  frequency:typeof calendarRecurrenceFrequencies[number];
  interval:number;
  days_of_week?:CalendarRecurrenceWeekday[];
  day_of_month?:number;
  month?:number;
  end:{type:"never"}|{type:"date";date:string}|{type:"count";count:number};
};
export type CalendarRecurrenceContext={startDate:string;allDay:boolean;timeZone?:string;providerTimeZone?:string;providerWeekStart?:CalendarRecurrenceWeekday};

const googleWeekdays:Record<CalendarRecurrenceWeekday,string>={monday:"MO",tuesday:"TU",wednesday:"WE",thursday:"TH",friday:"FR",saturday:"SA",sunday:"SU"};
const googleWeekdayNames=new Map(Object.entries(googleWeekdays).map(([name,code])=>[code,name as CalendarRecurrenceWeekday]));

function record(value:unknown):Record<string,unknown>|null{return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:null;}
function exactKeys(value:Record<string,unknown>,allowed:string[]){return Object.keys(value).every(key=>allowed.includes(key));}
function integer(value:unknown,min:number,max:number){return typeof value==="number"&&Number.isInteger(value)&&value>=min&&value<=max?value:null;}
function dateOnly(value:unknown){
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
  const parsed=new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value?value:null;
}
function validContext(context:CalendarRecurrenceContext){return dateOnly(context.startDate)!==null;}
function defaultCalendarFields(frequency:CalendarRecurrence["frequency"],context:CalendarRecurrenceContext){
  const date=new Date(`${context.startDate}T00:00:00Z`),day=date.getUTCDate(),month=date.getUTCMonth()+1;
  const weekday=calendarRecurrenceWeekdays[(date.getUTCDay()+6)%7];
  return frequency==="weekly"?{days_of_week:[weekday]}:frequency==="monthly"?{day_of_month:day}:frequency==="yearly"?{day_of_month:day,month}:{};
}

export function parseCalendarRecurrence(value:unknown,context:CalendarRecurrenceContext):CalendarRecurrence|null{
  const input=record(value);if(!input||!validContext(context)||!calendarRecurrenceFrequencies.includes(input.frequency as CalendarRecurrence["frequency"]))return null;
  const frequency=input.frequency as CalendarRecurrence["frequency"],interval=integer(input.interval,1,999),ending=record(input.end);
  if(!interval||!ending)return null;
  let end:CalendarRecurrence["end"];
  if(ending.type==="never"&&exactKeys(ending,["type"]))end={type:"never"};
  else if(ending.type==="date"&&exactKeys(ending,["type","date"])){
    const date=dateOnly(ending.date);if(!date||date<context.startDate)return null;end={type:"date",date};
  }else if(ending.type==="count"&&exactKeys(ending,["type","count"])){
    const count=integer(ending.count,1,999);if(!count)return null;end={type:"count",count};
  }else return null;
  const common=["frequency","interval","end"];
  if(frequency==="daily")return exactKeys(input,common)?{frequency,interval,end}:null;
  if(frequency==="weekly"){
    if(!exactKeys(input,[...common,"days_of_week"])||!Array.isArray(input.days_of_week)||!input.days_of_week.length)return null;
    const days=input.days_of_week as unknown[];
    if(days.some(day=>!calendarRecurrenceWeekdays.includes(day as CalendarRecurrenceWeekday)))return null;
    const unique=[...new Set(days as CalendarRecurrenceWeekday[])].sort((a,b)=>calendarRecurrenceWeekdays.indexOf(a)-calendarRecurrenceWeekdays.indexOf(b));
    return unique.length===days.length?{frequency,interval,days_of_week:unique,end}:null;
  }
  const day=integer(input.day_of_month,1,31);
  if(frequency==="monthly")return day&&exactKeys(input,[...common,"day_of_month"])?{frequency,interval,day_of_month:day,end}:null;
  const month=integer(input.month,1,12),validDate=month&&day&&new Date(Date.UTC(2000,month-1,day)).getUTCMonth()===month-1;
  return month&&day&&validDate&&exactKeys(input,[...common,"day_of_month","month"])?{frequency,interval,day_of_month:day,month,end}:null;
}

export function defaultCalendarRecurrence(frequency:CalendarRecurrence["frequency"],context:CalendarRecurrenceContext):CalendarRecurrence{
  return {frequency,interval:1,...defaultCalendarFields(frequency,context),end:{type:"never"}} as CalendarRecurrence;
}

function compactUtc(value:string){return value.replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z");}
export function googleCalendarRecurrence(rule:CalendarRecurrence,context:CalendarRecurrenceContext){
  const parsed=parseCalendarRecurrence(rule,context);if(!parsed)throw new Error("Neteisinga kartojimo taisyklė.");
  const parts=[`FREQ=${parsed.frequency.toUpperCase()}`,`INTERVAL=${parsed.interval}`];
  if(parsed.frequency==="weekly")parts.push(`BYDAY=${parsed.days_of_week!.map(day=>googleWeekdays[day]).join(",")}`);
  if(parsed.frequency==="monthly"||parsed.frequency==="yearly")parts.push(`BYMONTHDAY=${parsed.day_of_month}`);
  if(parsed.frequency==="yearly")parts.push(`BYMONTH=${parsed.month}`);
  if(parsed.end.type==="count")parts.push(`COUNT=${parsed.end.count}`);
  if(parsed.end.type==="date"){
    if(context.allDay)parts.push(`UNTIL=${parsed.end.date.replaceAll("-","")}`);
    else {
      const zone=context.timeZone||"UTC",instant=zonedInstant(`${parsed.end.date}T23:59`,zone);
      parts.push(`UNTIL=${compactUtc(instant)}`);
    }
  }
  return [`RRULE:${parts.join(";")}`];
}

export function graphCalendarRecurrence(rule:CalendarRecurrence,context:CalendarRecurrenceContext){
  const parsed=parseCalendarRecurrence(rule,context);if(!parsed)throw new Error("Neteisinga kartojimo taisyklė.");
  const pattern=parsed.frequency==="daily"?{type:"daily",interval:parsed.interval}
    :parsed.frequency==="weekly"?{type:"weekly",interval:parsed.interval,daysOfWeek:parsed.days_of_week,firstDayOfWeek:context.providerWeekStart||"monday"}
    :parsed.frequency==="monthly"?{type:"absoluteMonthly",interval:parsed.interval,dayOfMonth:parsed.day_of_month}
    :{type:"absoluteYearly",interval:parsed.interval,dayOfMonth:parsed.day_of_month,month:parsed.month};
  const range=parsed.end.type==="never"?{type:"noEnd",startDate:context.startDate}
    :parsed.end.type==="count"?{type:"numbered",startDate:context.startDate,numberOfOccurrences:parsed.end.count}
    :{type:"endDate",startDate:context.startDate,endDate:parsed.end.date};
  return {pattern,range:{...range,...(context.providerTimeZone?{recurrenceTimeZone:context.providerTimeZone}:{})}};
}

function localDateAt(instant:string,timeZone:string){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(instant));
  const field=(type:string)=>parts.find(part=>part.type===type)?.value||"";
  return `${field("year")}-${field("month")}-${field("day")}`;
}
function parseGoogleUntil(value:string,context:CalendarRecurrenceContext){
  if(/^\d{8}$/.test(value))return `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`;
  if(!/^\d{8}T\d{6}Z$/.test(value))return null;
  const iso=`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(9,11)}:${value.slice(11,13)}:${value.slice(13,15)}Z`;
  return localDateAt(iso,context.timeZone||"UTC");
}
export function parseGoogleCalendarRecurrence(value:unknown,context:CalendarRecurrenceContext):CalendarRecurrence|null{
  if(!Array.isArray(value)||value.length!==1||typeof value[0]!=="string"||!value[0].startsWith("RRULE:"))return null;
  const entries=value[0].slice(6).split(";").map(part=>part.split("="));
  if(entries.some(parts=>parts.length!==2))return null;
  const fields=new Map(entries as [string,string][]);if(fields.size!==entries.length)return null;
  if([...fields.keys()].some(key=>!["FREQ","INTERVAL","BYDAY","BYMONTHDAY","BYMONTH","COUNT","UNTIL","WKST"].includes(key)))return null;
  if(fields.has("COUNT")&&fields.has("UNTIL"))return null;
  const frequency=String(fields.get("FREQ")||"").toLowerCase(),interval=Number(fields.get("INTERVAL")||1);
  const expected=frequency==="daily"?["FREQ","INTERVAL","COUNT","UNTIL"]:frequency==="weekly"?["FREQ","INTERVAL","BYDAY","COUNT","UNTIL","WKST"]:frequency==="monthly"?["FREQ","INTERVAL","BYMONTHDAY","COUNT","UNTIL"]:frequency==="yearly"?["FREQ","INTERVAL","BYMONTHDAY","BYMONTH","COUNT","UNTIL"]:[];
  if(!expected.length||[...fields.keys()].some(key=>!expected.includes(key))||(frequency==="weekly"&&(!fields.has("BYDAY")||(fields.has("WKST")&&fields.get("WKST")!=="MO"))))return null;
  const end=fields.has("COUNT")?{type:"count",count:Number(fields.get("COUNT"))}:fields.has("UNTIL")?{type:"date",date:parseGoogleUntil(fields.get("UNTIL")!,context)}:{type:"never"};
  let candidate:Record<string,unknown>={frequency,interval,end};
  if(frequency==="weekly")candidate={...candidate,days_of_week:String(fields.get("BYDAY")||"").split(",").map(code=>googleWeekdayNames.get(code))};
  if(frequency==="monthly"||frequency==="yearly")candidate={...candidate,day_of_month:Number(fields.get("BYMONTHDAY"))};
  if(frequency==="yearly")candidate={...candidate,month:Number(fields.get("BYMONTH"))};
  return parseCalendarRecurrence(candidate,context);
}

export function parseGraphCalendarRecurrence(value:unknown,context:CalendarRecurrenceContext):CalendarRecurrence|null{
  const source=record(value),pattern=record(source?.pattern),range=record(source?.range);if(!pattern||!range||range.startDate!==context.startDate)return null;
  const patternFields=["type","interval","month","dayOfMonth","daysOfWeek","firstDayOfWeek","index"],rangeFields=["type","startDate","endDate","recurrenceTimeZone","numberOfOccurrences"];
  if(!exactKeys(pattern,patternFields)||!exactKeys(range,rangeFields))return null;
  const end=range.type==="noEnd"?{type:"never"}:range.type==="numbered"?{type:"count",count:range.numberOfOccurrences}:range.type==="endDate"?{type:"date",date:range.endDate}:null;
  if(!end)return null;
  let candidate:unknown;
  if(pattern.type==="daily")candidate={frequency:"daily",interval:pattern.interval,end};
  else if(pattern.type==="weekly"&&calendarRecurrenceWeekdays.includes(pattern.firstDayOfWeek as CalendarRecurrenceWeekday))candidate={frequency:"weekly",interval:pattern.interval,days_of_week:pattern.daysOfWeek,end};
  else if(pattern.type==="absoluteMonthly")candidate={frequency:"monthly",interval:pattern.interval,day_of_month:pattern.dayOfMonth,end};
  else if(pattern.type==="absoluteYearly")candidate={frequency:"yearly",interval:pattern.interval,day_of_month:pattern.dayOfMonth,month:pattern.month,end};
  else return null;
  return parseCalendarRecurrence(candidate,context);
}
