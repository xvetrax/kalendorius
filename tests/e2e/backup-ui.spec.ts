import { expect, test } from "@playwright/test";

test("settings downloads a full backup and restores it through the browser contract", async ({ page }) => {
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

  const restoreResponse = page.waitForResponse(response => response.url().endsWith("/api/backup") && response.request().method() === "PUT");
  await settings.locator('input[type="file"][accept=".db"]').setInputFiles(backupPath!);
  expect((await restoreResponse).status()).toBe(200);
  await expect(settings.getByRole("status")).toContainText("Atkurta");
});
