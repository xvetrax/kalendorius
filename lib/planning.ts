export type OutlookEventInput = {
  summary: unknown;
  description?: unknown;
  location?: unknown;
  start: unknown;
  end: unknown;
  attendees?: unknown;
  showAs?: unknown;
  isReminderOn?: unknown;
  addMeet?: unknown;
  kind?: unknown;
};

const SHOW_AS = new Set(["free", "tentative", "busy", "oof", "workingElsewhere", "unknown"]);

function utcDateTime(value: unknown) {
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("Neteisingas įvykio laikas");
  return date.toISOString().replace(/Z$/, "");
}

export function buildOutlookEvent(body: OutlookEventInput) {
  const taskBlock = body.kind === "task-time-block";
  const requestedShowAs = String(body.showAs || "busy");
  return {
    subject: String(body.summary).trim(),
    body: { contentType: "text", content: String(body.description || "") },
    ...(body.location ? { location: { displayName: String(body.location).slice(0, 1000) } } : {}),
    start: { dateTime: utcDateTime(body.start), timeZone: "UTC" },
    end: { dateTime: utcDateTime(body.end), timeZone: "UTC" },
    attendees: String(body.attendees || "").split(",").map((email) => email.trim()).filter(Boolean).map((address) => ({ emailAddress: { address }, type: "required" })),
    showAs: taskBlock ? "free" : (SHOW_AS.has(requestedShowAs) ? requestedShowAs : "busy"),
    isReminderOn: taskBlock ? false : body.isReminderOn !== false,
    isOnlineMeeting: !taskBlock && Boolean(body.addMeet),
    ...(!taskBlock && body.addMeet ? { onlineMeetingProvider: "teamsForBusiness" } : {}),
  };
}

export function normalizeGraphDateTime(dateTime: string, timeZone?: string) {
  if (/Z$|[+-]\d\d:\d\d$/.test(dateTime)) return dateTime;
  return timeZone === "UTC" ? `${dateTime}Z` : dateTime;
}
