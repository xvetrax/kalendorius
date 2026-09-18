// The reminder editor uses the browser's timezone; the API receives an instant.
export function reminderLocalInput(iso: string): string {
  const date=new Date(iso);
  return Number.isFinite(date.getTime()) ? new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16) : "";
}
export function reminderLocalInstant(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error("Įvesk priminimo datą ir laiką.");
  const date=new Date(value);
  if (!Number.isFinite(date.getTime()) || reminderLocalInput(date.toISOString()) !== value)
    throw new Error("Ši data ar valanda neegzistuoja. Pasirink kitą priminimo laiką.");
  // Detect repeated wall times, including 30-minute DST transitions.
  for (let delta=-180;delta<=180;delta+=15) {
    if (delta && reminderLocalInput(new Date(date.getTime()+delta*60000).toISOString()) === value)
      throw new Error("Ši valanda kartojasi dėl laiko persukimo. Pasirink kitą priminimo laiką.");
  }
  return date.toISOString();
}
