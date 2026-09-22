import { test, expect } from "@playwright/test";

test.describe("network error handling", () => {
  test("shows error message when tasks API fails", async ({ page }) => {
    await page.route("/api/tasks*", (route) => route.abort("failed"));
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("status")).toContainText("Dalies duomenų atnaujinti nepavyko");
    const pageText = await page.locator("body").innerText();
    expect(pageText).not.toContain("at Object.<anonymous>");
    expect(pageText).not.toContain("at Module");
  });

  test("shows error message when calendar API fails", async ({ page }) => {
    await page.route("/api/google/events*", (route) => route.abort("failed"));
    await page.route("/api/microsoft/events*", (route) => route.abort("failed"));
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("status")).toContainText("Dalies duomenų atnaujinti nepavyko");
  });

  test("handles slow network gracefully (500ms delay)", async ({ page }) => {
    await page.route("/api/tasks*", async (route) => {
      await new Promise((r) => setTimeout(r, 500));
      await route.continue();
    });
    await page.goto("/");
    await expect(page.locator(".loading")).toBeVisible();
    await expect(page.locator(".timeGrid")).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".loading")).toHaveCount(0);
  });

  test("failed task creation shows the server error and rolls back the UI", async ({ page }) => {
    await page.route("**/api/tasks", async route => {
      if (route.request().method() === "POST") {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Sintetinė kūrimo klaida." }) });
      } else await route.continue();
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const title = `Rollback-${Date.now()}`;
    const input = page.locator('input[placeholder*="Pridėti"]');
    await input.fill(title);
    await input.press("Enter");
    await expect(page.getByRole("status")).toContainText("Sintetinė kūrimo klaida.");
    await expect(input).toHaveValue(title);
    await expect(page.locator(".taskCard").filter({ hasText: title })).toHaveCount(0);

    const response = await page.request.get("/api/tasks?envelope=1");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.items.some((task: { title: string }) => task.title === title)).toBe(false);
  });
});
