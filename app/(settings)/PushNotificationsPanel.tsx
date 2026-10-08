"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePwaRuntime } from "@/app/pwa-runtime";
import { pushEndpointHash } from "@/app/push-client";
import { calendarTimeZones } from "@/lib/calendar-time-zone";

type Device = {
  id: number;
  deviceName: string;
  endpointFingerprint: string;
  createdAt: string;
  updatedAt: string;
  lastPushAcceptedAt: string | null;
  failureCount: number;
};

type PushState = {
  configured: boolean;
  publicKey: string;
  subscriptions: Device[];
};

type NotificationPreferences = {
  focusEnd: { enabled: boolean };
  taskStart: { enabled: boolean; leadMinutes: number };
  dailyRituals: {
    timeZone: string | null;
    morningPlan: { enabled: boolean; localTime: string };
    eveningClose: { enabled: boolean; localTime: string };
  };
};

function base64UrlBytes(value: string) {
  const padded = `${value}${"=".repeat((4 - value.length % 4) % 4)}`.replaceAll("-", "+").replaceAll("_", "/");
  const raw = window.atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function fingerprint(endpoint: string) {
  return (await pushEndpointHash(endpoint)).slice(0, 16);
}

function defaultDeviceName() {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || "Įrenginys";
  const browser = /Edg\//.test(navigator.userAgent) ? "Edge"
    : /Firefox\//.test(navigator.userAgent) ? "Firefox"
      : /Chrome\//.test(navigator.userAgent) ? "Chrome"
        : /Safari\//.test(navigator.userAgent) ? "Safari" : "Naršyklė";
  return `${platform} · ${browser}`.slice(0, 80);
}

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Veiksmo atlikti nepavyko.");
  return body as T;
}

export function PushNotificationsPanel() {
  const { online } = usePwaRuntime();
  const [supported, setSupported] = useState<boolean | null>(null);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [state, setState] = useState<PushState | null>(null);
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [currentFingerprint, setCurrentFingerprint] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [browserTimeZone, setBrowserTimeZone] = useState("UTC");
  const [timeZones, setTimeZones] = useState(["UTC"]);

  const currentDevice = useMemo(
    () => state?.subscriptions.find((device) => device.endpointFingerprint === currentFingerprint) || null,
    [currentFingerprint, state],
  );

  const load = useCallback(async () => {
    try {
      const [next, nextPreferences] = await Promise.all([
        json<PushState>(await fetch("/api/push/subscriptions", { cache: "no-store" })),
        json<NotificationPreferences>(await fetch("/api/notifications/preferences", { cache: "no-store" })),
      ]);
      setState(next);
      setPreferences(nextPreferences);
      if ("serviceWorker" in navigator && "PushManager" in window) {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        setCurrentFingerprint(subscription ? await fingerprint(subscription.endpoint) : "");
      } else {
        setCurrentFingerprint("");
      }
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Pranešimų nustatymų įkelti nepavyko.");
    }
  }, []);

  useEffect(() => {
    const canPush = typeof window !== "undefined"
      && window.isSecureContext
      && "serviceWorker" in navigator
      && "PushManager" in window
      && "Notification" in window;
    setSupported(canPush);
    if (canPush) {
      setPermission(Notification.permission);
      setDeviceName(defaultDeviceName());
    }
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    setBrowserTimeZone(localZone);
    setTimeZones([...new Set([localZone, ...calendarTimeZones()])]);
    void load();
  }, [load]);

  async function enable() {
    if (!state?.configured || !state.publicKey || !supported || !online) return;
    setBusy("enable"); setError(""); setMessage("");
    let pendingSubscription: PushSubscription | null = null;
    try {
      const nextPermission = await Notification.requestPermission();
      setPermission(nextPermission);
      if (nextPermission !== "granted") throw new Error("Naršyklėje pranešimų leidimas nesuteiktas.");
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing || await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlBytes(state.publicKey),
      });
      pendingSubscription = subscription;
      const serialized = subscription.toJSON();
      const result = await json<{ id: number; subscriptions: Device[] }>(await fetch("/api/push/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          expirationTime: subscription.expirationTime,
          keys: serialized.keys,
          deviceName: deviceName.trim() || defaultDeviceName(),
        }),
      }));
      setState((current) => current ? { ...current, subscriptions: result.subscriptions } : current);
      setCurrentFingerprint(await fingerprint(subscription.endpoint));
      setMessage("Pranešimai šiame įrenginyje įjungti.");
    } catch (enableError) {
      await pendingSubscription?.unsubscribe().catch(() => false);
      setCurrentFingerprint("");
      setError(enableError instanceof Error ? enableError.message : "Pranešimų įjungti nepavyko.");
    } finally { setBusy(""); }
  }

  async function remove(device: Device) {
    if (!online) return;
    setBusy(`remove-${device.id}`); setError(""); setMessage("");
    try {
      const result = await json<{ subscriptions: Device[] }>(await fetch("/api/push/subscriptions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: device.id }),
      }));
      if (device.endpointFingerprint === currentFingerprint) {
        const registration = await navigator.serviceWorker.ready;
        await (await registration.pushManager.getSubscription())?.unsubscribe();
        setCurrentFingerprint("");
      }
      setState((current) => current ? { ...current, subscriptions: result.subscriptions } : current);
      setMessage("Įrenginio prenumerata pašalinta.");
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Prenumeratos pašalinti nepavyko.");
    } finally { setBusy(""); }
  }

  async function test(device: Device) {
    if (!online) return;
    setBusy(`test-${device.id}`); setError(""); setMessage("");
    try {
      await json(await fetch("/api/push/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: device.id }),
      }));
      setMessage(`Bandomasis pranešimas išsiųstas į „${device.deviceName}“`);
      await load();
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "Bandomojo pranešimo išsiųsti nepavyko.");
      await load();
    } finally { setBusy(""); }
  }

  async function setFocusReminder(enabled: boolean) {
    if (!online || !preferences) return;
    setBusy("focus-preference"); setError(""); setMessage("");
    try {
      const next = await json<NotificationPreferences>(await fetch("/api/notifications/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ focusEndEnabled: enabled }),
      }));
      setPreferences(next);
      setMessage(enabled ? "Fokusavimo pabaigos priminimai įjungti." : "Fokusavimo pabaigos priminimai išjungti.");
    } catch (preferenceError) {
      setError(preferenceError instanceof Error ? preferenceError.message : "Priminimo nuostatos išsaugoti nepavyko.");
    } finally { setBusy(""); }
  }

  async function setTaskStartReminder(enabled: boolean, leadMinutes = preferences?.taskStart.leadMinutes ?? 10) {
    if (!online || !preferences) return;
    setBusy("task-start-preference"); setError(""); setMessage("");
    try {
      const next = await json<NotificationPreferences>(await fetch("/api/notifications/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskStartEnabled: enabled, taskStartLeadMinutes: leadMinutes }),
      }));
      setPreferences(next);
      setMessage(enabled ? "Užduočių pradžios priminimai įjungti." : "Užduočių pradžios priminimai išjungti.");
    } catch (preferenceError) {
      setError(preferenceError instanceof Error ? preferenceError.message : "Priminimo nuostatos išsaugoti nepavyko.");
    } finally { setBusy(""); }
  }

  async function setDailyRituals(update: Partial<NotificationPreferences["dailyRituals"]>) {
    if (!online || !preferences) return;
    const current = preferences.dailyRituals;
    const next = {
      timeZone: update.timeZone ?? current.timeZone ?? browserTimeZone,
      morningPlan: update.morningPlan ?? current.morningPlan,
      eveningClose: update.eveningClose ?? current.eveningClose,
    };
    setBusy("daily-rituals"); setError(""); setMessage("");
    try {
      const saved = await json<NotificationPreferences>(await fetch("/api/notifications/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dailyRituals: next }),
      }));
      setPreferences(saved);
      setMessage("Dienos ritualų priminimai atnaujinti.");
    } catch (preferenceError) {
      setError(preferenceError instanceof Error ? preferenceError.message : "Dienos ritualų nuostatos išsaugoti nepavyko.");
    } finally { setBusy(""); }
  }

  if (supported === null) return <p className="formHint">Tikrinamas pranešimų palaikymas…</p>;
  if (!state || !preferences) return error
    ? <p className="formError" role="alert">{error}</p>
    : <p className="formHint">Kraunami pranešimų nustatymai…</p>;

  return <section className="pushSettings" aria-label="Pranešimų įrenginiai">
    {!supported && <p className="formHint">Ši naršyklė arba nesaugus HTTP adresas nepalaiko Web Push šiame įrenginyje. Žemiau vis tiek gali valdyti kitus savo įrenginius. iPhone pranešimai veikia tik įdiegus programėlę į pagrindinį ekraną.</p>}
    {!state.configured && <p className="formHint">Administratorius dar nenustatė VAPID raktų. Pranešimų įjungti negalima.</p>}
    {permission === "denied" && <p className="formError">Pranešimai užblokuoti naršyklės nustatymuose. Suteik leidimą šiam saitui ir perkrauk puslapį.</p>}
    {supported && !currentDevice && permission !== "denied" && <div className="pushEnable">
      <label>Šio įrenginio pavadinimas<input value={deviceName} maxLength={80} onChange={(event) => setDeviceName(event.target.value)} /></label>
      <button type="button" disabled={!online || !state.configured || busy === "enable" || !deviceName.trim()} onClick={() => void enable()}>
        {busy === "enable" ? "Įjungiama…" : "Įjungti pranešimus šiame įrenginyje"}
      </button>
      <small>Leidimo naršyklė paprašys tik paspaudus šį mygtuką.</small>
    </div>}
    {currentDevice && <p className="pushCurrent" role="status">Pranešimai šiame įrenginyje įjungti kaip <strong>{currentDevice.deviceName}</strong>.</p>}
    <div className="pushScenarios">
      <h4>Programėlės priminimai</h4>
      <label className="freeToggle">
        <input type="checkbox" checked={preferences.focusEnd.enabled} disabled={!online || Boolean(busy) || state.subscriptions.length === 0} onChange={(event) => void setFocusReminder(event.target.checked)} />
        <i/><span><strong>Fokusavimo sesija baigėsi</strong><small>Pranešti net tada, kai programėlė uždaryta.</small></span>
      </label>
      <div className="pushScenarioRow">
        <label className="freeToggle">
          <input type="checkbox" checked={preferences.taskStart.enabled} disabled={!online || Boolean(busy) || state.subscriptions.length === 0} onChange={(event) => void setTaskStartReminder(event.target.checked)} />
          <i/><span><strong>Artėja suplanuota užduotis</strong><small>Pranešti pagal programėlėje suplanuotą pradžios laiką.</small></span>
        </label>
        <label className="pushLeadTime">Pranešti
          <select value={preferences.taskStart.leadMinutes} disabled={!online || Boolean(busy) || state.subscriptions.length === 0} onChange={(event) => void setTaskStartReminder(preferences.taskStart.enabled, Number(event.target.value))}>
            <option value={0}>pradžios metu</option>
            <option value={5}>prieš 5 min.</option>
            <option value={10}>prieš 10 min.</option>
            <option value={15}>prieš 15 min.</option>
            <option value={30}>prieš 30 min.</option>
            <option value={60}>prieš 1 val.</option>
            <option value={1440}>prieš 1 dieną</option>
          </select>
        </label>
      </div>
      <div className="pushRituals">
        <label className="pushRitualZone">Dienos ritualų laiko zona
          <select value={preferences.dailyRituals.timeZone ?? browserTimeZone} disabled={!online || Boolean(busy) || state.subscriptions.length === 0} onChange={(event) => void setDailyRituals({ timeZone: event.target.value })}>
            {timeZones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
          </select>
        </label>
        <div className="pushScenarioRow">
          <label className="freeToggle">
            <input type="checkbox" checked={preferences.dailyRituals.morningPlan.enabled} disabled={!online || Boolean(busy) || state.subscriptions.length === 0} onChange={(event) => void setDailyRituals({ morningPlan: { ...preferences.dailyRituals.morningPlan, enabled: event.target.checked } })} />
            <i/><span><strong>Ryto dienos planavimas</strong><small>Priminti peržiūrėti ir susiplanuoti dieną.</small></span>
          </label>
          <label className="pushRitualTime">Laikas
            <input type="time" value={preferences.dailyRituals.morningPlan.localTime} disabled={!online || Boolean(busy) || state.subscriptions.length === 0} onChange={(event) => void setDailyRituals({ morningPlan: { ...preferences.dailyRituals.morningPlan, localTime: event.target.value } })} />
          </label>
        </div>
        <div className="pushScenarioRow">
          <label className="freeToggle">
            <input type="checkbox" checked={preferences.dailyRituals.eveningClose.enabled} disabled={!online || Boolean(busy) || state.subscriptions.length === 0} onChange={(event) => void setDailyRituals({ eveningClose: { ...preferences.dailyRituals.eveningClose, enabled: event.target.checked } })} />
            <i/><span><strong>Vakaro dienos uždarymas</strong><small>Priminti užbaigti dieną ir pasiruošti rytojui.</small></span>
          </label>
          <label className="pushRitualTime">Laikas
            <input type="time" value={preferences.dailyRituals.eveningClose.localTime} disabled={!online || Boolean(busy) || state.subscriptions.length === 0} onChange={(event) => void setDailyRituals({ eveningClose: { ...preferences.dailyRituals.eveningClose, localTime: event.target.value } })} />
          </label>
        </div>
        <small>Persukant laikrodį pasikartojančią valandą naudojame pirmą kartą, o neegzistuojantį laiką perkeliame pirmyn per DST tarpą. Po serverio pertraukos jau suplanuotą priminimą siunčiame ne vėliau kaip per 2 valandas.</small>
      </div>
      {state.subscriptions.length === 0 && <small>Pirmiausia įjunk pranešimus bent viename įrenginyje.</small>}
    </div>
    <p className="pushPrivacy">Bandomasis pranešimas nerodo užduočių ar kalendoriaus turinio. Vėliau kiekvieno priminimo privatumo lygį bus galima pasirinkti atskirai.</p>
    {state.subscriptions.length > 0 && <ul className="pushDevices">
      {state.subscriptions.map((device) => <li key={device.id}>
        <div><strong>{device.deviceName}</strong><small>{device.endpointFingerprint === currentFingerprint ? "Šis įrenginys · " : ""}Pridėta {new Date(device.createdAt).toLocaleDateString("lt-LT")}{device.lastPushAcceptedAt ? ` · push paslauga priėmė ${new Date(device.lastPushAcceptedAt).toLocaleString("lt-LT")}` : ""}</small></div>
        <button type="button" disabled={!online || Boolean(busy)} onClick={() => void test(device)}>{busy === `test-${device.id}` ? "Siunčiama…" : "Bandyti"}</button>
        <button type="button" className="dangerButton" disabled={!online || Boolean(busy)} onClick={() => void remove(device)}>{busy === `remove-${device.id}` ? "Šalinama…" : "Pašalinti"}</button>
      </li>)}
    </ul>}
    <p className="formHint">iPhone ir iPad pranešimai veikia iOS 16.4 ar naujesnėje versijoje, kai programėlė įdiegta į pagrindinį ekraną. Android, macOS ir Windows pakanka palaikomos naršyklės bei HTTPS.</p>
    {message && <p className="reminderSuccess" role="status">{message}</p>}
    {error && <p className="formError" role="alert">{error}</p>}
  </section>;
}
