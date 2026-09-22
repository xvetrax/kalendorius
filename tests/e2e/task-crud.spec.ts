import { test, expect } from "@playwright/test";

test.describe("task CRUD", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("[data-testid='task-input'], input[placeholder*='užduot'], input[placeholder*='task']", { timeout: 8000 }).catch(() => {});
  });

  test("page loads without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const critical = errors.filter((e) => !e.includes("favicon") && !e.includes("404"));
    expect(critical).toHaveLength(0);
  });

  test("health check endpoint returns ok", async ({ request }) => {
    const res = await request.get("/api/config");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("version");
  });

  test("creates a local task", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const input = page.locator('input[placeholder*="Pridėti"]');
    const title = `E2E-create-${Date.now()}`;
    const [, response] = await Promise.all([
      input.fill(title).then(() => input.press("Enter")),
      page.waitForResponse((r) => r.url().includes("/api/tasks") && r.request().method() === "POST"),
    ]);
    expect(response.status()).toBeLessThan(300);
    await expect(page.locator(`text=${title}`)).toBeVisible({ timeout: 5000 });
  });

  test("task persists after page reload", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const input = page.locator('input[placeholder*="Pridėti"]');
    const title = `Persist-${Date.now()}`;
    await input.fill(title);
    await input.press("Enter");
    await expect(page.locator(`text=${title}`)).toBeVisible({ timeout: 5000 });
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator(`text=${title}`)).toBeVisible({ timeout: 5000 });
  });
});
