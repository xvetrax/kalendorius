import { test, expect } from "@playwright/test";

test.describe("accessibility", () => {
  test("page has lang attribute", async ({ page }) => {
    await page.goto("/");
    const lang = await page.locator("html").getAttribute("lang");
    expect(lang).toBeTruthy();
  });

  test("main content area is reachable", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const main = page.locator("main, [role='main']");
    await expect(main).toBeVisible({ timeout: 5000 });
  });

  test("interactive elements are keyboard navigable", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    expect(focused).toBeTruthy();
    expect(focused).not.toBe("BODY");
  });

  test("login page has proper form labels when auth enabled", async ({ page }) => {
    // If redirected to login (auth enabled), check form accessibility
    const res = await page.goto("/");
    if (res && res.url().includes("/login")) {
      const inputs = page.locator("input");
      const count = await inputs.count();
      for (let i = 0; i < count; i++) {
        const input = inputs.nth(i);
        const id = await input.getAttribute("id");
        const ariaLabel = await input.getAttribute("aria-label");
        const label = id ? await page.locator(`label[for="${id}"]`).count() : 0;
        expect(id && (label > 0 || ariaLabel)).toBeTruthy();
      }
    }
  });
});
