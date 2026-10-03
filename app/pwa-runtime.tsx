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
  const waitingWorker = useRef<ServiceWorker | null>(null);
  const reloadForUpdate = useRef(false);
  const [supported, setSupported] = useState(false);
  const [online, setOnline] = useState(true);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    setOnline(navigator.onLine);
    const wentOnline = () => setOnline(true);
    const wentOffline = () => setOnline(false);
    window.addEventListener("online", wentOnline);
    window.addEventListener("offline", wentOffline);

    if (!("serviceWorker" in navigator)) {
      return () => {
        window.removeEventListener("online", wentOnline);
        window.removeEventListener("offline", wentOffline);
      };
    }

    setSupported(true);
    let cancelled = false;
    const offerUpdate = (worker: ServiceWorker | null) => {
      if (!worker || !navigator.serviceWorker.controller) return;
      waitingWorker.current = worker;
      setUpdateAvailable(true);
    };
    const controllerChanged = () => {
      if (reloadForUpdate.current) window.location.reload();
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
      })
      .catch(() => {
        // PWA support is optional. The regular web application keeps working.
      });

    return () => {
      cancelled = true;
      window.removeEventListener("online", wentOnline);
      window.removeEventListener("offline", wentOffline);
      navigator.serviceWorker.removeEventListener("controllerchange", controllerChanged);
    };
  }, []);

  async function checkForUpdate() {
    if (!online) return;
    await registration.current?.update().catch(() => undefined);
  }

  function applyUpdate() {
    const worker = waitingWorker.current || registration.current?.waiting;
    if (!worker || updating) return;
    reloadForUpdate.current = true;
    setUpdating(true);
    worker.postMessage({ type: "SKIP_WAITING" });
  }

  return (
    <PwaRuntimeContext.Provider value={{ supported, online, updateAvailable, updating, checkForUpdate, applyUpdate }}>
      {children}
    </PwaRuntimeContext.Provider>
  );
}

export function usePwaRuntime() {
  return useContext(PwaRuntimeContext);
}
