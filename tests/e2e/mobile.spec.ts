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

  test("touch controls keep at least a 44px target", async ({ page }) => {
    await page.goto("/");
    for(const control of [
      page.getByRole("button",{name:"Atnaujinti duomenis"}),
      page.getByRole("button",{name:"Išvaizdos nustatymai"}),
      page.getByRole("button",{name:"Užduotys",exact:true}),
    ]){
      const box=await control.boundingBox();
      expect(box).toBeTruthy();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole("button",{name:"Nustatymai",exact:true}).click();
    const close=await page.getByRole("button",{name:"Uždaryti"}).boundingBox();
    expect(close?.width).toBeGreaterThanOrEqual(44);
    expect(close?.height).toBeGreaterThanOrEqual(44);
  });
});
