import { test, expect } from "@playwright/test";

test.describe("mobile viewport", () => {
  test("page renders without horizontal scroll at 390px", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);
  });

  test("bottom navigation is visible", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Mobile shows bottom nav with Užduotys tab
    const nav = page.locator("nav[aria-label='Rodiniai']");
    await expect(nav).toBeVisible({ timeout: 5000 });
    await expect(nav.getByRole("button", { name: "Kalendorius" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Užduotys" })).toBeVisible();
  });

  test("task list is accessible via Užduotys tab", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Click Užduotys in bottom nav
    const taskTab = page.locator("nav[aria-label='Rodiniai'] button").filter({ hasText: /Užduotys/i });
    await taskTab.click();
    await page.waitForTimeout(300);
    // Mobile task view shows "+ Nauja užduotis" button (not inline input)
    await expect(page.getByText(/Nauja užduotis|Darbų srautas/).first()).toBeVisible({ timeout: 5000 });
  });

  test("calendar shows single-column day view on mobile", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: "Diena", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".dayHead")).toHaveCount(1);
    await expect(page.locator(".dayLane")).toHaveCount(1);
  });
});
