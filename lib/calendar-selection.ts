import crypto from "node:crypto";

export type CalendarSelectionProvider="google"|"microsoft";

export function calendarSelectionVersion(provider:CalendarSelectionProvider,accountId:string|undefined,connectionId:string|undefined) {
  if(!accountId||!connectionId)return "";
  return crypto.createHash("sha256").update(JSON.stringify([provider,accountId,connectionId])).digest("base64url");
}
