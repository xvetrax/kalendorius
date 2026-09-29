// Parsing and overlay helpers for legacy calendar selections stored in
// `user_settings` under `<provider>_enabled_calendars`. When a legacy value is
// present it takes precedence over the multi-connection `calendar_preferences`
// tables and is normalized back into `{ accountId, items }` form so older
// readers stay consistent. The legacy value remains the source of truth while
// it exists; it is never destructively written into the preferences tables, so
// removing it cleanly reverts to whatever the preferences tables already hold.
import { saveUserSetting, userSetting } from "@/lib/db";
import type { CalendarSelection } from "@/lib/calendar-preferences";
import type { OAuthProvider } from "@/lib/oauth-service";

export type LegacyCalendarItem = { id: string; name?: string; color?: string };

// A legacy value may be:
//   - a bare array of calendar id strings: ["primary"]
//   - a bare array of objects: [{ id, name, color }]
//   - an object { accountId, items } where items is either of the above
// Returns null when the value is absent or not a recognizable legacy shape.
export function parseLegacyCalendarItems(raw: string | undefined): LegacyCalendarItem[] | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const source = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as any).items)
      ? (parsed as any).items
      : null;
  if (!source) return null;
  const items: LegacyCalendarItem[] = [];
  for (const entry of source) {
    if (typeof entry === "string") {
      if (entry) items.push({ id: entry });
    } else if (entry && typeof entry === "object" && typeof (entry as any).id === "string" && (entry as any).id) {
      const item: LegacyCalendarItem = { id: (entry as any).id };
      if (typeof (entry as any).name === "string") item.name = (entry as any).name;
      if (typeof (entry as any).color === "string") item.color = (entry as any).color;
      items.push(item);
    }
  }
  return items;
}

const legacyKey = (provider: OAuthProvider) => `${provider}_enabled_calendars`;

// When a legacy selection exists it takes precedence: this returns an explicit
// `CalendarSelection` overlay derived from it (so both the enabled list and the
// selection version reflect the legacy choice) and normalizes the stored value
// into `{ accountId, items }` form. `mapId` lets a provider translate legacy ids
// (e.g. Microsoft "primary" -> the live default id). Returns null when there is
// no legacy value, in which case the caller should fall back to the preferences
// tables. Idempotent: the normalized value re-parses to the same overlay.
export function resolveLegacyCalendarSelection(
  userId: number,
  connectionId: number,
  providerAccountId: string,
  provider: OAuthProvider,
  mapId?: (id: string) => string,
): { selection: CalendarSelection; defaultAlias: boolean } | null {
  const key = legacyKey(provider);
  const raw = userSetting(userId, key);
  const items = parseLegacyCalendarItems(raw);
  if (items === null) return null;

  // A stored `{ accountId, items }` selection is bound to that account. If the
  // connection's account changed underneath it, the selection is void for the
  // new account: return an explicit-empty overlay so the wrong account sees no
  // calendars rather than inheriting another account's choices.
  let storedAccount: string | undefined;
  try {
    const parsed = JSON.parse(raw!);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.accountId === "string") {
      storedAccount = parsed.accountId;
    }
  } catch {}
  if (storedAccount !== undefined && storedAccount !== providerAccountId) {
    return { selection: { connection_id: connectionId, explicit: true, items: [] }, defaultAlias: false };
  }

  const seen = new Set<string>();
  const prefs: CalendarSelection["items"] = [];
  let defaultAlias = false;
  for (const item of items) {
    const mapped = mapId ? mapId(item.id) : item.id;
    if (mapped !== item.id) defaultAlias = true;
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    const color =
      typeof item.color === "string" && /^#[0-9a-f]{6}$/i.test(item.color)
        ? item.color.toLowerCase()
        : null;
    prefs.push({ calendar_id: mapped, enabled: true, color_override: color });
  }
  // Preserve the original (unmapped) items so name/color survive round-trips.
  saveUserSetting(userId, key, JSON.stringify({ accountId: providerAccountId, items }));
  return {
    selection: { connection_id: connectionId, explicit: true, items: prefs },
    defaultAlias,
  };
}

// Keep an EXISTING legacy selection in sync after an explicit PATCH so older
// readers stay consistent. Only updates a key that is already present — it never
// creates one, so accounts fully migrated to the preferences tables do not
// regain a stale legacy selection.
export function writeLegacyCalendarSelection(
  userId: number,
  provider: OAuthProvider,
  accountId: string,
  items: LegacyCalendarItem[],
): void {
  const key = legacyKey(provider);
  if (userSetting(userId, key) === undefined) return;
  saveUserSetting(userId, key, JSON.stringify({ accountId, items }));
}
