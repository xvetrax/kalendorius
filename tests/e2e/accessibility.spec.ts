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

  test("skip link reaches the main content", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip=page.getByRole("link",{name:"Pereiti prie pagrindinio turinio"});
    await expect(skip).toBeFocused();
    await skip.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();
  });

  test("dialog traps focus, closes with Escape and restores its trigger", async ({ page }) => {
    await page.goto("/");
    const trigger=page.getByRole("button",{name:"Nustatymai",exact:true});
    await trigger.focus();
    await trigger.press("Enter");
    const dialog=page.getByRole("dialog",{name:"Nustatymai"});
    const first=dialog.getByRole("button",{name:"Uždaryti"});
    await expect(first).toBeFocused();
    await first.press("Shift+Tab");
    await expect(dialog.locator("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]").filter({visible:true}).last()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("month view does not nest interactive controls", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button",{name:"Mėnuo",exact:true}).click();
    await expect(page.locator("button button, button a, a button")).toHaveCount(0);
    await expect(page.locator(".monthDayCreate").first()).toHaveAccessibleName(/naujas įvykis/);
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
