export type InstallPlatform = "ios" | "android" | "macos" | "windows" | "other";

export function detectInstallPlatform(userAgent: string, platform: string, maxTouchPoints: number): InstallPlatform {
  const ios = /iPad|iPhone|iPod/i.test(userAgent) || (/Mac/i.test(platform) && maxTouchPoints > 1);
  if (ios) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  if (/Mac/i.test(platform)) return "macos";
  if (/Win/i.test(platform)) return "windows";
  return "other";
}
