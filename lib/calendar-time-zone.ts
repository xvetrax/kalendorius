const formatters=new Map<string,Intl.DateTimeFormat>();

function formatter(timeZone:string){
  let value=formatters.get(timeZone);
  if(!value){value=new Intl.DateTimeFormat("en-GB",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});formatters.set(timeZone,value);}
  return value;
}

function parts(instant:number,timeZone:string){
  const values:Record<string,string>={};
  for(const part of formatter(timeZone).formatToParts(new Date(instant)))if(part.type!=="literal")values[part.type]=part.value;
  return {year:Number(values.year),month:Number(values.month),day:Number(values.day),hour:Number(values.hour),minute:Number(values.minute),second:Number(values.second)};
}

function wallValue(instant:number,timeZone:string,seconds:boolean){
  const value=parts(instant,timeZone),pad=(number:number)=>String(number).padStart(2,"0");
  return `${value.year}-${pad(value.month)}-${pad(value.day)}T${pad(value.hour)}:${pad(value.minute)}${seconds?`:${pad(value.second)}`:""}`;
}

function offsetAt(instant:number,timeZone:string){
  const value=parts(instant,timeZone),rounded=Math.floor(instant/1000)*1000;
  return Date.UTC(value.year,value.month-1,value.day,value.hour,value.minute,value.second)-rounded;
}

export function canonicalCalendarTimeZone(value:unknown){
  if(typeof value!=="string"||!value||value.length>128||/^[+-]/.test(value))return null;
  try{
    const canonical=formatter(value).resolvedOptions().timeZone;
    return canonical&&!/^[+-]/.test(canonical)?canonical:null;
  }catch{return null;}
}

export function isCalendarTimeZone(value:unknown):value is string{
  return canonicalCalendarTimeZone(value)!==null;
}

export function calendarTimeZones(){
  return ["UTC",...Intl.supportedValuesOf("timeZone").filter(value=>value!=="UTC")];
}

export function zonedLocalInput(iso:string,timeZone:string){
  const instant=Date.parse(iso);
  if(!Number.isFinite(instant)||!isCalendarTimeZone(timeZone))return "";
  return wallValue(instant,timeZone,false);
}

export function zonedProviderDateTime(iso:string,timeZone:string){
  const instant=Date.parse(iso);
  if(!Number.isFinite(instant)||!isCalendarTimeZone(timeZone))throw new Error("Neteisingas įvykio laikas arba laiko zona.");
  return wallValue(instant,timeZone,true);
}

export function zonedInstant(value:string,timeZone:string){
  const match=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if(!match||!isCalendarTimeZone(timeZone))throw new Error("Įvesk laiką ir pasirink galiojančią laiko zoną.");
  const [year,month,day,hour,minute]=match.slice(1).map(Number),naive=Date.UTC(year,month-1,day,hour,minute);
  const check=new Date(naive);
  if(check.getUTCFullYear()!==year||check.getUTCMonth()!==month-1||check.getUTCDate()!==day||check.getUTCHours()!==hour||check.getUTCMinutes()!==minute)throw new Error("Ši data ar valanda neegzistuoja.");
  const offsets=new Set<number>();
  for(const delta of [-48,-24,-12,0,12,24,48])offsets.add(offsetAt(naive+delta*3600000,timeZone));
  const candidates=new Set<number>();
  for(const offset of offsets){const candidate=naive-offset;if(wallValue(candidate,timeZone,false)===value)candidates.add(candidate);}
  if(candidates.size===0)throw new Error("Ši data ar valanda pasirinktoje laiko zonoje neegzistuoja.");
  if(candidates.size>1)throw new Error("Ši valanda pasirinktoje laiko zonoje kartojasi dėl laiko persukimo. Pasirink kitą laiką.");
  return new Date([...candidates][0]).toISOString();
}
