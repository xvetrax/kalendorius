"use client";

import { useEffect, useRef, useState } from "react";
import type { Task } from "@/lib/task-service";
import { reminderLocalInput, reminderLocalInstant } from "@/lib/task-reminder-time";

type ReminderSnapshot = {
  enabled: boolean;
  at: string | null;
  source_time: { dateTime: string; timeZone: string } | null;
  version: string;
  readonly_reason?: string;
  recurring: boolean;
};

class ReminderRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function messageFrom(value: unknown, fallback: string) {
  return value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : fallback;
}

async function snapshotResponse(response: Response): Promise<ReminderSnapshot> {
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new ReminderRequestError(messageFrom(body, "Priminimo atnaujinti nepavyko."), response.status);
  if (!body || typeof body !== "object" || !("enabled" in body) || typeof body.enabled !== "boolean" || !("version" in body) || typeof body.version !== "string" || !("at" in body) || (body.at !== null && typeof body.at !== "string") || !("recurring" in body) || typeof body.recurring !== "boolean") {
    throw new Error("Gautas netinkamas Microsoft To Do priminimo atsakymas.");
  }
  const snapshot = body as ReminderSnapshot;
  if (snapshot.source_time !== null && (!snapshot.source_time || typeof snapshot.source_time.dateTime !== "string" || typeof snapshot.source_time.timeZone !== "string")) {
    throw new Error("Gautas netinkamas Microsoft To Do priminimo laikas.");
  }
  return snapshot;
}

function referenceFor(task: Task) {
  if (!task.account_id || !task.list_id) throw new Error("Trūksta Microsoft To Do užduoties nuorodos. Atnaujink užduočių sąrašą.");
  return { source: "microsoft" as const, account_id: task.account_id, list_id: task.list_id, id: String(task.id) };
}

function reminderUrl(task: Task) {
  return `/api/tasks/reminder?${new URLSearchParams(referenceFor(task)).toString()}`;
}

function draftAt(snapshot: ReminderSnapshot) {
  if (!snapshot.at) return "";
  try {
    return reminderLocalInput(snapshot.at);
  } catch {
    throw new Error("Microsoft To Do grąžino netinkamą priminimo laiką. Spausk „Atnaujinti“.");
  }
}

export function MicrosoftTaskReminder({ task, disabled, onBusyChange }: { task: Task; disabled: boolean; onBusyChange: (busy: boolean) => void }) {
  const mounted = useRef(false);
  const requestGeneration = useRef(0);
  const [snapshot, setSnapshot] = useState<ReminderSnapshot | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
      onBusyChange(false);
    };
  }, [onBusyChange]);

  function current(generation: number) {
    return mounted.current && generation === requestGeneration.current;
  }

  function beginRequest() {
    const generation = ++requestGeneration.current;
    setBusy(true);
    onBusyChange(true);
    return generation;
  }

  function finishRequest(generation: number) {
    if (!current(generation)) return;
    setBusy(false);
    onBusyChange(false);
  }

  function applySnapshot(next: ReminderSnapshot) {
    setSnapshot(next);
    setEnabled(next.enabled);
    setAt(draftAt(next));
    setFresh(true);
  }

  async function refresh() {
    const generation = beginRequest();
    setError("");
    setStatus("");
    try {
      const next = await snapshotResponse(await fetch(reminderUrl(task)));
      if (current(generation)) applySnapshot(next);
    } catch (caught) {
      if (current(generation)) {
        setFresh(false);
        setError(caught instanceof Error ? caught.message : "Priminimo atnaujinti nepavyko.");
      }
    } finally {
      finishRequest(generation);
    }
  }

  useEffect(() => {
    void refresh();
    // A new editor instance is mounted for each task. Keep the initial request
    // tied to that instance so an old response cannot replace a newer task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.key]);

  async function save() {
    if (!snapshot || disabled || busy || !fresh) return;
    const readonlyReason = snapshot.readonly_reason || task.readonly_reason;
    if (readonlyReason) return;

    let instant: string | undefined;
    if (enabled) {
      try {
        instant = snapshot.at && at === draftAt(snapshot) ? snapshot.at : reminderLocalInstant(at);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Įvesk galiojantį priminimo laiką.");
        return;
      }
    }

    const generation = beginRequest();
    setError("");
    setStatus("");
    try {
      const reference = referenceFor(task);
      const payload = enabled
        ? { ...reference, version: snapshot.version, enabled: true, at: instant }
        : { ...reference, version: snapshot.version, enabled: false };
      const next = await snapshotResponse(await fetch("/api/tasks/reminder", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }));
      if (current(generation)) {
        applySnapshot(next);
        setStatus("Microsoft To Do priminimas išsaugotas.");
      }
    } catch (caught) {
      if (current(generation)) {
        setFresh(false);
        if (caught instanceof ReminderRequestError && caught.status === 409) {
          setError("Priminimas pasikeitė Microsoft To Do. Spausk „Atnaujinti“, peržiūrėk dabartinę būseną ir išsaugok dar kartą.");
        } else {
          setError("Nepavyko patvirtinti priminimo pakeitimo. Spausk „Atnaujinti“ prieš bandydamas išsaugoti dar kartą.");
        }
      }
    } finally {
      finishRequest(generation);
    }
  }

  const readonlyReason = snapshot?.readonly_reason || task.readonly_reason;
  const mutationDisabled = disabled || busy || !fresh || !snapshot || Boolean(readonlyReason);
  const rawSourceTime = snapshot?.source_time;
  const needsExplicitTime = enabled && !at;
  const changed = snapshot && (enabled !== snapshot.enabled || (enabled && at !== draftAt(snapshot)));
  const saveDisabled = mutationDisabled || needsExplicitTime || !changed;
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return <section className="microsoftReminder" aria-labelledby="microsoft-reminder-title">
    <div className="microsoftReminderHeading">
      <div><h3 id="microsoft-reminder-title">Microsoft To Do priminimas</h3><p>Pranešimą pristato Microsoft, ne ši naršyklė. Jis yra atskiras nuo termino ir darbo plano.</p></div>
      <button type="button" onClick={() => void refresh()} disabled={disabled || busy}>{busy && !snapshot ? "Atnaujinama…" : "Atnaujinti"}</button>
    </div>
    {rawSourceTime && <p className="formHint">Microsoft To Do laikas: <strong>{rawSourceTime.dateTime}</strong> · <strong>{rawSourceTime.timeZone}</strong>{snapshot?.at === null ? " Šio laiko zona negali būti saugiai paversta į UTC; nurodyk naują priminimo laiką, jei nori jį įjungti ar pakeisti." : ""}</p>}
    {snapshot?.recurring && <p className="formHint">Esamo pasikartojimo taisykles tvarko Microsoft To Do. Šiame lange jos nekeičiamos.</p>}
    {readonlyReason && <p className="formHint">{readonlyReason}</p>}
    {error && <p role="alert" className="formError">{error}</p>}
    {status && <p role="status" className="reminderSuccess">{status}</p>}
    <div className="microsoftReminderFields">
      <label className="onlineSwitch"><input type="checkbox" checked={enabled} disabled={mutationDisabled} onChange={(event) => { setEnabled(event.target.checked); setError(""); setStatus(""); }}/><i/>Įjungti priminimą</label>
      <label>Priminimo laikas<input type="datetime-local" value={at} disabled={mutationDisabled || !enabled} onChange={(event) => { setAt(event.target.value); setError(""); setStatus(""); }}/></label>
      <p className="formHint">Laiko zona: {localZone}. Ji parenkama pagal šią naršyklę.</p>
      {needsExplicitTime && !mutationDisabled && <p className="formHint">Įvesk priminimo datą ir laiką. Laiko persukimo dienomis neegzistuojanti ar pasikartojanti valanda nepriimama.</p>}
      <div className="modalActions"><button type="button" className="newButton" disabled={saveDisabled} onClick={() => void save()}>{busy ? "Saugoma…" : "Išsaugoti priminimą"}</button></div>
    </div>
  </section>;
}
