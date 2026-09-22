import { test, expect } from "@playwright/test";

test.describe("accessibility", () => {
  test("page has lang attribute", async ({ page }) => {
    await page.goto("/");
    const lang = await page.locator("html").getAttribute("lang");
    expect(lang).toBe("lt");
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

  test("new task dialog exposes labeled form controls", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Užduotys", exact: true }).click();
    await page.getByRole("button", { name: "Nauja užduotis", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Nauja užduotis" });
    await expect(dialog.getByLabel("Pavadinimas")).toBeVisible();
    await expect(dialog.getByLabel("Pastabos")).toBeVisible();
    await expect(dialog.getByLabel(/Terminas/)).toBeVisible();
  });
});
