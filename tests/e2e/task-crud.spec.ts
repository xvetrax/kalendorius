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
    expect(body.checks.authentication).toBe("Google / Microsoft OIDC");
    expect(body.checks.PUBLIC_SIGNUP).toBe("enabled");
    expect(body.checks.google).toBe("not configured");
    expect(body.checks.microsoft).toBe("not configured");
  });

  test("creates, persists, edits, completes, restores and deletes a local task", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const input = page.locator('input[placeholder*="Pridėti"]');
    const title = `E2E-lifecycle-${Date.now()}`;
    await input.fill(title);await input.press("Enter");
    const preview=page.getByRole("dialog",{name:"Nauja užduotis"});
    await expect(preview.getByLabel("Pavadinimas")).toHaveValue(title);
    const [, response] = await Promise.all([
      preview.getByRole("button",{name:"Sukurti",exact:true}).click(),
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

  test("undoes local task creation once and records the action",async({page})=>{
    await page.goto("/");await page.waitForLoadState("networkidle");
    const title=`E2E-undo-${Date.now()}`,input=page.locator('input[placeholder*="Pridėti"]');
    await input.fill(title);await input.press("Enter");
    const dialog=page.getByRole("dialog",{name:"Nauja užduotis"});
    await dialog.getByRole("button",{name:"Sukurti",exact:true}).click();
    const undo=page.locator(".undoToast");
    await expect(undo).toContainText(title);
    const response=page.waitForResponse(value=>value.url().endsWith("/api/actions")&&value.request().method()==="POST");
    await undo.getByRole("button",{name:"Atšaukti",exact:true}).click();
    expect((await response).status()).toBe(200);
    await expect(page.getByText(title,{exact:true})).toHaveCount(0);
    await page.getByRole("button",{name:"Nustatymai",exact:true}).click();
    const history=page.getByRole("region",{name:"Paskutiniai veiksmai"});
    const entry=history.locator("li").filter({hasText:title});
    await expect(entry).toContainText("Atšaukta");
    await expect(entry.getByRole("button",{name:"Atšaukti",exact:true})).toHaveCount(0);
  });

  test("keeps an ambiguous provider undo recoverable after its normal deadline",async({page})=>{
    const operationId="44444444-4444-4444-8444-444444444444";let posts=0;
    await page.route("**/api/actions",async route=>{
      if(route.request().method()==="POST"){
        posts+=1;
        if(posts===1)return route.fulfill({status:502,json:{error:"Tiekėjo atsakymas neaiškus. Bandyk tęsti atšaukimą."}});
        return route.fulfill({json:{alreadyUndone:false,action:{operationId,actionType:"provider_event_moved",label:"Perkeltas įvykis „Susitikimas“",createdAt:"2026-10-08T08:00:00.000Z",undoExpiresAt:"2026-10-08T08:00:15.000Z",status:"undone",canUndo:false}}});
      }
      return route.fulfill({json:{items:[{operationId,actionType:"provider_event_moved",label:"Perkeltas įvykis „Susitikimas“",createdAt:"2026-10-08T08:00:00.000Z",undoExpiresAt:"2026-10-08T08:00:15.000Z",status:"applying",canUndo:true}]}});
    });
    await page.goto("/");await page.getByRole("button",{name:"Nustatymai",exact:true}).click();
    const history=page.getByRole("region",{name:"Paskutiniai veiksmai"}),entry=history.locator("li").filter({hasText:"Susitikimas"});
    await expect(entry).toContainText("Atšaukimą reikia užbaigti");
    await entry.getByRole("button",{name:"Tęsti atšaukimą",exact:true}).click();
    await expect.poll(()=>posts).toBe(1);await expect(history.getByRole("alert")).toContainText("atsakymas neaiškus");
    await expect(entry).toContainText("Atšaukimą reikia užbaigti");
    await entry.getByRole("button",{name:"Tęsti atšaukimą",exact:true}).click();
    await expect.poll(()=>posts).toBe(2);await expect(entry).toContainText("Atšaukta");
  });
});
