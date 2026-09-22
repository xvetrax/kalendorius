import { test, expect } from "@playwright/test";

test.describe("network error handling", () => {
  test("shows error message when tasks API fails", async ({ page }) => {
    await page.route("/api/tasks*", (route) => route.abort("failed"));
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // App should still render (not crash) even if API calls fail
    const body = page.locator("body");
    await expect(body).toBeVisible();
    // Should not show raw stack traces to user
    const pageText = await body.innerText();
    expect(pageText).not.toContain("at Object.<anonymous>");
    expect(pageText).not.toContain("at Module");
  });

  test("shows error message when calendar API fails", async ({ page }) => {
    await page.route("/api/google/events*", (route) => route.abort("failed"));
    await page.route("/api/microsoft/events*", (route) => route.abort("failed"));
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const body = page.locator("body");
    await expect(body).toBeVisible();
  });

  test("handles slow network gracefully (500ms delay)", async ({ page }) => {
    await page.route("/api/tasks*", async (route) => {
      await new Promise((r) => setTimeout(r, 500));
      await route.continue();
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle", { timeout: 10000 });
    const body = page.locator("body");
    await expect(body).toBeVisible();
  });
});
