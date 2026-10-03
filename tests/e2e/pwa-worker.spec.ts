import { expect, test } from "@playwright/test";

test("service worker valdo puslapį ir podėlyje neturi privačių kelių", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL.endsWith("/sw.js") || false)).toBe(true);

  const cachedPaths = await page.evaluate(async () => {
    const paths: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) paths.push(new URL(request.url).pathname);
    }
    return paths;
  });
  expect(cachedPaths).toContain("/offline.html");
  expect(cachedPaths.some((path) => path.startsWith("/api/") || path === "/login")).toBe(false);
});

test("navigacija be ryšio rodo bendrą offline puslapį", async ({ page, context }) => {
  await page.goto("/");
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  try {
    await page.goto("/calendar");
    await expect(page.getByRole("heading", { name: "Nėra interneto ryšio" })).toBeVisible();
    await expect(page.getByText("Privatūs kalendoriaus ir užduočių duomenys šiame puslapyje nesaugomi.")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("E2E Admin");
  } finally {
    await context.setOffline(false);
  }
});
