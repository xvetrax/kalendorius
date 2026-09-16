export type ThemePreference = "system" | "light" | "dark";
export const THEME_KEY = "planner-theme";
export const PANEL_KEY = "planner-panel-collapsed";
export function themePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}
export function resolvedTheme(value: ThemePreference, systemDark: boolean) {
  return value === "system" ? systemDark ? "dark" : "light" : value;
}
export function readPreference(storage: Pick<Storage, "getItem">, key: string): string | null {
  try { return storage.getItem(key); } catch { return null; }
}
export function writePreference(storage: Pick<Storage, "setItem">, key: string, value: string): boolean {
  try { storage.setItem(key, value); return true; } catch { return false; }
}
// Static, trusted code only. Runs before the page paints; no stored value is executed.
export const themeBootstrap = `(function(){var t='system';try{var s=localStorage.getItem('planner-theme');if(s==='dark'||s==='light')t=s;}catch(e){}var dark=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=dark?'dark':'light';})();`;
