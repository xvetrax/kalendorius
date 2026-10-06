"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";

type PwaRuntimeState = {
  supported: boolean;
  online: boolean;
  updateAvailable: boolean;
  updating: boolean;
  checkForUpdate(): Promise<void>;
  applyUpdate(): void;
};

const PwaRuntimeContext = createContext<PwaRuntimeState>({
  supported: false,
  online: true,
  updateAvailable: false,
  updating: false,
  checkForUpdate: async () => {},
  applyUpdate: () => {},
});

export function PwaRuntimeProvider({ children }: { children: React.ReactNode }) {
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const reloadForUpdate = useRef(false);
  const updateReloadTimer = useRef<number | null>(null);
  const initialAssetVersion = useRef("");
  const [supported, setSupported] = useState(false);
  const [online, setOnline] = useState(true);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    initialAssetVersion.current = assetVersion(document);
    setOnline(navigator.onLine);
    const wentOnline = () => {
      setOnline(true);
      void checkForUpdate();
    };
    const wentOffline = () => setOnline(false);
    const becameVisible = () => {
      if (document.visibilityState === "visible") void checkForUpdate();
    };
    window.addEventListener("online", wentOnline);
    window.addEventListener("offline", wentOffline);
    window.addEventListener("focus", becameVisible);
    document.addEventListener("visibilitychange", becameVisible);

    if (!("serviceWorker" in navigator)) {
      return () => {
        window.removeEventListener("online", wentOnline);
        window.removeEventListener("offline", wentOffline);
        window.removeEventListener("focus", becameVisible);
        document.removeEventListener("visibilitychange", becameVisible);
      };
    }

    setSupported(true);
    let cancelled = false;
    const offerUpdate = (worker: ServiceWorker | null) => {
      if (!worker || !navigator.serviceWorker.controller) return;
      setUpdateAvailable(true);
    };
    const controllerChanged = () => {
      if (!reloadForUpdate.current) return;
      if (updateReloadTimer.current !== null) window.clearTimeout(updateReloadTimer.current);
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", controllerChanged);

    void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((nextRegistration) => {
        if (cancelled) return;
        registration.current = nextRegistration;
        offerUpdate(nextRegistration.waiting);
        nextRegistration.addEventListener("updatefound", () => {
          const installing = nextRegistration.installing;
          installing?.addEventListener("statechange", () => {
            if (installing.state === "installed") offerUpdate(nextRegistration.waiting || installing);
          });
        });
        void checkForUpdate();
      })
      .catch(() => {
        // PWA support is optional. The regular web application keeps working.
      });

    return () => {
      cancelled = true;
      window.removeEventListener("online", wentOnline);
      window.removeEventListener("offline", wentOffline);
      window.removeEventListener("focus", becameVisible);
      document.removeEventListener("visibilitychange", becameVisible);
      navigator.serviceWorker.removeEventListener("controllerchange", controllerChanged);
      if (updateReloadTimer.current !== null) window.clearTimeout(updateReloadTimer.current);
    };
  }, []);

  async function checkForUpdate() {
    if (!navigator.onLine) return;
    await registration.current?.update().catch(() => undefined);
    try {
      const response = await fetch("/", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok || !(response.headers.get("content-type") || "").includes("text/html")) return;
      const latest = assetVersion(new DOMParser().parseFromString(await response.text(), "text/html"));
      if (latest && initialAssetVersion.current && latest !== initialAssetVersion.current) setUpdateAvailable(true);
    } catch {
      // Ryšio juostą valdo naršyklės online/offline įvykiai.
    }
  }

  function applyUpdate() {
    if (!online || updating) return;
    if (document.querySelector('[role="dialog"] form') && !window.confirm("Atidarytas redagavimo langas. Atnaujinus programėlę neįrašyti pakeitimai bus prarasti. Tęsti?")) return;
    // registration.waiting is authoritative. A worker remembered earlier may
    // already have been activated by another open tab; posting to that stale
    // worker would never produce another controllerchange event in this tab.
    const worker = registration.current?.waiting || null;
    reloadForUpdate.current = true;
    setUpdating(true);
    if (worker?.state === "installed") {
      worker.postMessage({ type: "SKIP_WAITING" });
      // Safari standalone web apps have occasionally failed to surface the
      // controllerchange event. Never leave the update action stuck forever.
      updateReloadTimer.current = window.setTimeout(() => window.location.reload(), 2_000);
    } else window.location.reload();
  }

  return (
    <PwaRuntimeContext.Provider value={{ supported, online, updateAvailable, updating, checkForUpdate, applyUpdate }}>
      {children}
      <PwaRuntimeStatus />
    </PwaRuntimeContext.Provider>
  );
}

export function usePwaRuntime() {
  return useContext(PwaRuntimeContext);
}

function assetVersion(root: Document) {
  return [...root.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src^="/_next/static/"],link[href^="/_next/static/"]')]
    .map((element) => element.getAttribute("src") || element.getAttribute("href") || "")
    .map((value) => new URL(value, window.location.origin).pathname)
    .sort()
    .join("|");
}

function PwaRuntimeStatus() {
  const runtime = usePwaRuntime();
  if (!runtime.online) {
    return <aside className="pwaRuntimeStatus offline" role="status"><span><strong>Nėra interneto.</strong> Rodomi jau atidaryti duomenys. Keitimai serveryje išjungti.</span></aside>;
  }
  if (!runtime.updateAvailable) return null;
  return <aside className="pwaRuntimeStatus update" role="status"><span><strong>Yra nauja programėlės versija.</strong></span><button type="button" disabled={runtime.updating} onClick={runtime.applyUpdate}>{runtime.updating ? "Atnaujinama…" : "Atnaujinti programėlę"}</button></aside>;
}
