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
    expect(body.checks.DATABASE_PATH).toContain("kalendorius-playwright-");
    expect(body.checks.APP_PASSWORD).toContain("auth disabled");
    expect(body.checks.google).toBe("not configured");
    expect(body.checks.microsoft).toBe("not configured");
  });

  test("creates, persists, edits, completes, restores and deletes a local task", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const input = page.locator('input[placeholder*="Pridėti"]');
    const title = `E2E-lifecycle-${Date.now()}`;
    const [, response] = await Promise.all([
      input.fill(title).then(() => input.press("Enter")),
      page.waitForResponse((r) => r.url().includes("/api/tasks") && r.request().method() === "POST"),
    ]);
    expect(response.status()).toBeLessThan(300);
    await expect(page.locator(".taskCard").filter({ hasText: title })).toBeVisible({ timeout: 5000 });
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator(".taskCard").filter({ hasText: title })).toBeVisible({ timeout: 5000 });

    const edited = `${title}-edited`;
    await page.locator(".taskCard").filter({ hasText: title }).locator(".taskDetailsButton").click();
    const editor = page.getByRole("dialog", { name: "Užduotis ir jos planas" });
    await editor.getByLabel("Pavadinimas").fill(edited);
    const patchResponse = page.waitForResponse(r => r.url().includes("/api/tasks") && r.request().method() === "PATCH");
    await editor.getByRole("button", { name: "Išsaugoti", exact: true }).click();
    expect((await patchResponse).status()).toBeLessThan(300);
    await expect(page.locator(".taskCard").filter({ hasText: edited })).toBeVisible();

    const card = page.locator(".taskCard").filter({ hasText: edited });
    const completeResponse = page.waitForResponse(r => r.url().includes("/api/tasks") && r.request().method() === "PATCH");
    await card.getByRole("button", { name: `Užbaigti: ${edited}` }).click();
    expect((await completeResponse).status()).toBeLessThan(300);
    await expect(card).toHaveCount(0);

    await page.getByRole("button", { name: "Užduotys", exact: true }).click();
    const completed = page.locator("article.done").filter({ hasText: edited });
    await expect(completed).toBeVisible();
    const restoreResponse = page.waitForResponse(r => r.url().includes("/api/tasks") && r.request().method() === "PATCH");
    await completed.getByRole("button", { name: `Atkurti: ${edited}` }).click();
    expect((await restoreResponse).status()).toBeLessThan(300);
    const restored = page.locator(".board article:not(.done)").filter({ hasText: edited });
    await expect(restored).toBeVisible();

    await restored.locator(".boardTaskTitle").click();
    page.once("dialog", dialog => dialog.accept());
    const deleteResponse = page.waitForResponse(r => r.url().includes("/api/tasks") && r.request().method() === "DELETE");
    await page.getByRole("dialog", { name: "Užduotis ir jos planas" }).getByRole("button", { name: "Ištrinti užduotį" }).click();
    expect((await deleteResponse).status()).toBeLessThan(300);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(edited, { exact: true })).toHaveCount(0);
  });
});
