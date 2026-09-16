"use client";
import {useEffect, useState} from "react";
import {PANEL_KEY, THEME_KEY, readPreference, resolvedTheme, themePreference, writePreference, type ThemePreference} from "@/lib/ui-preferences";

export function usePreferences() {
  const [theme,setTheme]=useState<ThemePreference>("system");
  const [collapsed,setCollapsed]=useState(false);
  const [ready,setReady]=useState(false);
  useEffect(()=>{
    // Access to window.localStorage itself may throw in restricted browser contexts.
    function sync() {try {setTheme(themePreference(readPreference(localStorage,THEME_KEY)));setCollapsed(readPreference(localStorage,PANEL_KEY)==="true");} catch {} }
    sync();setReady(true);
    const storage=(event:StorageEvent)=>{if(event.key===null || event.key===THEME_KEY || event.key===PANEL_KEY)sync();};
    window.addEventListener("storage",storage);
    return ()=>window.removeEventListener("storage",storage);
  },[]);
  useEffect(()=>{
    if(!ready)return;
    const query=window.matchMedia("(prefers-color-scheme: dark)");
    const apply=()=>{document.documentElement.dataset.theme=resolvedTheme(theme,query.matches);};
    apply();query.addEventListener("change",apply);
    return ()=>query.removeEventListener("change",apply);
  },[theme,ready]);
  function chooseTheme(value:ThemePreference) {setTheme(value);try {writePreference(localStorage,THEME_KEY,value);} catch {} }
  function collapse(value:boolean) {setCollapsed(value);try {writePreference(localStorage,PANEL_KEY,String(value));} catch {} }
  return {theme,chooseTheme,collapsed,collapse};
}
