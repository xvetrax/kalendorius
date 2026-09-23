import type { DatabaseSync } from "node:sqlite";

export const OUTLOOK_MIRROR_BODY="Dienos planas: pasirenkamas užduoties darbo laikas.";
export const OUTLOOK_DEFAULT_CALENDAR_SETTING="microsoft_default_calendar_identity";

export function outlookDefaultCalendarId(serialized:string|undefined,accountId:string|undefined,connectionId:string|undefined):string|undefined {
  if (!serialized || !accountId || !connectionId) return undefined;
  try {
    const value=JSON.parse(serialized);
    return Array.isArray(value) && value.length===3 && value[0]===accountId && value[1]===connectionId && typeof value[2]==="string" && value[2] ? value[2] : undefined;
  } catch {return undefined;}
}

// Called only for an event read from Graph under the current connection and
// calendar scope. Never infer ownership from the event ID or subject alone.
export function outlookMirrorTaskKey(db:DatabaseSync,accountId:string|undefined,calendarId:string,defaultCalendarId:string|undefined,raw:any):string|null {
  if (!accountId || (calendarId!=="primary" && calendarId!==defaultCalendarId) || typeof raw.id!=="string" || !raw.id || typeof raw.transactionId!=="string" || !raw.transactionId
    || raw.showAs!=="free" || raw.isOrganizer!==true || raw.isCancelled || raw.isAllDay
    || raw.type!=="singleInstance" || raw.seriesMasterId || raw.recurrence || (raw.attendees?.length ?? 0)>0
    || raw.isReminderOn!==false || raw.isOnlineMeeting!==false || raw.onlineMeeting
    || raw.bodyPreview!==OUTLOOK_MIRROR_BODY || raw.location?.displayName?.trim()
    || raw.sensitivity!=="normal" || raw.importance!=="normal" || raw.hasAttachments!==false
    || (raw.categories?.length ?? 0)>0) return null;
  const matches=db.prepare(`SELECT task_key FROM task_plans
    WHERE mirror_account_id=? AND mirror_event_id=? AND mirror_transaction_id=?
      AND mirror_requested=1 AND scheduled_at IS NOT NULL AND mirror_error IS NULL
    LIMIT 2`).all(accountId,raw.id,raw.transactionId) as {task_key:string}[];
  return matches.length===1 ? matches[0].task_key : null;
}
