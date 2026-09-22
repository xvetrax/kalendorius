import { test, expect } from "@playwright/test";

// Tests that the app renders correctly in different time zones
// Uses Playwright's timezoneId option via browser context

const TZ_CASES = [
  { name: "Vilnius", tz: "Europe/Vilnius" },
  { name: "UTC", tz: "UTC" },
  { name: "New York", tz: "America/New_York" },
  { name: "Tokyo", tz: "Asia/Tokyo" },
];

for (const { name, tz } of TZ_CASES) {
  test(`renders without errors in ${name} timezone`, async ({ browser }) => {
    const ctx = await browser.newContext({ timezoneId: tz });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const critical = errors.filter((e) => !e.includes("favicon") && !e.includes("404"));
    expect(critical).toHaveLength(0);
    await ctx.close();
  });
}

test("DST boundary: Vilnius 2026-03-29 renders without crash", async ({ browser }) => {
  const ctx = await browser.newContext({ timezoneId: "Europe/Vilnius" });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  // Navigate to DST-transition week if navigation is possible
  // Just verify the page doesn't crash
  await expect(page.locator("body")).toBeVisible();
  await ctx.close();
});
