"use client";

import { useEffect, useState } from "react";
import { detectInstallPlatform, type InstallPlatform } from "@/lib/pwa-install";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export type PwaInstall = {
  platform: InstallPlatform;
  standalone: boolean;
  available: boolean;
  installing: boolean;
  installed: boolean;
  install(): Promise<void>;
};

export function usePwaInstall(): PwaInstall {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [platform, setPlatform] = useState<InstallPlatform>("other");
  const [standalone, setStandalone] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const displayMode = window.matchMedia("(display-mode: standalone)");
    const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
    const updateStandalone = () => setStandalone(displayMode.matches || navigatorWithStandalone.standalone === true);
    const beforeInstall = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
    };
    const appInstalled = () => {
      setInstalled(true);
      setPromptEvent(null);
    };

    setPlatform(detectInstallPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints));
    updateStandalone();
    displayMode.addEventListener("change", updateStandalone);
    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", appInstalled);
    return () => {
      displayMode.removeEventListener("change", updateStandalone);
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      window.removeEventListener("appinstalled", appInstalled);
    };
  }, []);

  async function install() {
    if (!promptEvent || installing) return;
    setInstalling(true);
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice.outcome === "accepted") setInstalled(true);
      setPromptEvent(null);
    } catch {
      // The event is one-shot even when the browser closes or rejects its dialog.
      // Fall back to the platform instructions instead of retrying a consumed event.
      setPromptEvent(null);
    } finally {
      setInstalling(false);
    }
  }

  return { platform, standalone, available: Boolean(promptEvent), installing, installed, install };
}

export function InstallAppPanel({ install }: { install: PwaInstall }) {
  if (install.standalone || install.installed) return null;

  const instructions = install.platform === "ios"
    ? <>Safari naršyklėje spausk <strong>Bendrinti</strong>, tada <strong>Pridėti į pradžios ekraną</strong>.</>
    : install.platform === "macos"
      ? <>Chrome arba Edge adreso juostoje rinkis diegimo ikoną. Safari meniu rinkis <strong>File → Add to Dock</strong>.</>
      : install.platform === "android"
        ? <>Jei diegimo mygtukas nerodomas, naršyklės meniu rinkis <strong>Pridėti prie pradžios ekrano</strong>.</>
        : install.platform === "windows"
          ? <>Chrome arba Edge adreso juostoje rinkis diegimo ikoną arba naršyklės meniu veiksmą <strong>Install</strong>.</>
          : <>Naršyklės meniu ieškok veiksmo <strong>Install</strong> arba <strong>Add to Home Screen</strong>.</>;

  return (
    <section className="installApp" aria-label="Įdiegti programėlę">
      <img src="/pwa/icon-192.png" alt="" width="52" height="52" />
      <div>
        <strong>Naudok kaip atskirą programėlę</strong>
        <p>{instructions}</p>
      </div>
      {install.available && (
        <button type="button" disabled={install.installing} onClick={() => void install.install()}>
          {install.installing ? "Atidaroma…" : "Įdiegti"}
        </button>
      )}
    </section>
  );
}
