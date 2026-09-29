import crypto from "node:crypto";

export type CalendarSelectionProvider="google"|"microsoft";

export function calendarSelectionVersion(provider:CalendarSelectionProvider,accountId:string|undefined,connectionId:string|undefined,selection?:{explicit:boolean;items:readonly {calendar_id:string;enabled:boolean;color_override:string|null}[]}) {
  if(!accountId||!connectionId)return "";
  const state=selection?[
    selection.explicit,
    [...selection.items].filter(item=>item.enabled).map(item=>[item.calendar_id,item.color_override]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))),
  ]:null;
  return crypto.createHash("sha256").update(JSON.stringify([provider,accountId,connectionId,state])).digest("base64url");
}
