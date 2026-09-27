import { db } from "@/lib/db-multi";

export { db };

export function setting(key: string) {
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value?: string } | undefined)?.value;
}

export function saveSetting(key: string, value: string) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
}

export function deleteSettings(...keys: string[]) {
  const statement = db.prepare("DELETE FROM settings WHERE key = ?");
  db.exec("BEGIN");
  try {
    for (const key of keys) statement.run(key);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Per-user settings (multi-user schema: user_settings table)
// ---------------------------------------------------------------------------

export function userSetting(userId: number, key: string): string | undefined {
  return (db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = ?").get(userId, key) as { value: string } | undefined)?.value;
}

export function saveUserSetting(userId: number, key: string, value: string): void {
  db.prepare(`
    INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(userId, key, value);
}

export function deleteUserSettings(userId: number, ...keys: string[]): void {
  const statement = db.prepare("DELETE FROM user_settings WHERE user_id = ? AND key = ?");
  db.exec("BEGIN");
  try {
    for (const key of keys) statement.run(userId, key);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function reserveCalendarEventCreate(provider:string,accountId:string,connectionId:string,calendarId:string,operationId:string,fingerprint:string,userId:number){
  db.prepare(`INSERT OR IGNORE INTO calendar_event_creates(user_id,provider,account_id,connection_id,calendar_id,operation_id,fingerprint) VALUES (?,?,?,?,?,?,?)`).run(userId,provider,accountId,connectionId,calendarId,operationId,fingerprint);
  const stored=db.prepare(`SELECT fingerprint FROM calendar_event_creates WHERE user_id=? AND provider=? AND account_id=? AND connection_id=? AND calendar_id=? AND operation_id=?`).get(userId,provider,accountId,connectionId,calendarId,operationId) as {fingerprint?:string}|undefined;
  return stored?.fingerprint===fingerprint;
}
