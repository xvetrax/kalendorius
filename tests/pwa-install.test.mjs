import assert from "node:assert/strict";
import test from "node:test";
import { detectInstallPlatform } from "../lib/pwa-install.ts";

test("PWA diegimo instrukcija atpažįsta pagrindines platformas", () => {
  assert.equal(detectInstallPlatform("Mozilla/5.0 (iPhone)", "iPhone", 5), "ios");
  assert.equal(detectInstallPlatform("Mozilla/5.0 (Macintosh)", "MacIntel", 5), "ios", "iPad gali prisistatyti kaip Mac");
  assert.equal(detectInstallPlatform("Mozilla/5.0 (Linux; Android 15)", "Linux armv8l", 5), "android");
  assert.equal(detectInstallPlatform("Mozilla/5.0 (Macintosh)", "MacIntel", 0), "macos");
  assert.equal(detectInstallPlatform("Mozilla/5.0 (Windows NT 10.0)", "Win32", 0), "windows");
  assert.equal(detectInstallPlatform("Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64", 0), "other");
});
