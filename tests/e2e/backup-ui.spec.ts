import { expect, test } from "@playwright/test";

test("settings downloads a full backup and uploads it through the browser contract", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Nustatymai", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Nustatymai" });

  const [download, downloadResponse] = await Promise.all([
    page.waitForEvent("download"),
    page.waitForResponse(response => response.url().endsWith("/api/backup") && response.request().method() === "POST"),
    settings.getByRole("button", { name: "⬇ Pilna kopija" }).click(),
  ]);
  expect(downloadResponse.status()).toBe(200);
  expect(download.suggestedFilename()).toMatch(/^planner-backup-\d{4}-\d{2}-\d{2}\.db$/);
  const backupPath = await download.path();
  expect(backupPath).toBeTruthy();

  // A real restore intentionally revokes every session. Intercept only this
  // browser request so parallel E2E files do not lose their shared fixture
  // session; the route-level suite proves the transactional restore itself.
  let uploadedHeader = "";
  await page.route("**/api/backup", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    uploadedHeader = route.request().postDataBuffer()?.subarray(0, 16).toString("utf8") ?? "";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, tablesRestored: 1 }) });
  });
  const restoreResponse = page.waitForResponse(response => response.url().endsWith("/api/backup") && response.request().method() === "PUT");
  await settings.locator('input[type="file"][accept=".db"]').setInputFiles(backupPath!);
  expect((await restoreResponse).status()).toBe(200);
  expect(uploadedHeader).toBe("SQLite format 3\0");
  await expect(settings.getByRole("status")).toContainText("Atkurta");
});
