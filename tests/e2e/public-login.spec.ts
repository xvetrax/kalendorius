import { expect, test } from "@playwright/test";

test("public URL offers self-service Google and Microsoft login without invite links", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  try {
    await page.goto(baseURL!);
    await expect(page).toHaveURL(/\/login\?next=%2F$/);
    await expect(page.getByRole("link", { name: "Prisijungti su Google" })).toHaveAttribute("href", "/api/auth/google-oidc/authorize");
    await expect(page.getByRole("link", { name: "Prisijungti su Microsoft" })).toHaveAttribute("href", "/api/auth/microsoft-oidc/authorize");
    await expect(page.getByText(/kvietimo/i)).toHaveCount(0);

    const api = await context.request.get(`${baseURL}/api/tasks`);
    expect(api.status()).toBe(401);
  } finally {
    await context.close();
  }
});
