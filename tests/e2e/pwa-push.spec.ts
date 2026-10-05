import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const endpoint = "https://push.example.test/playwright-device";
const endpointFingerprint = createHash("sha256").update(endpoint).digest("hex").slice(0, 16);

async function installPushBrowser(page: Page, permission: NotificationPermission = "default") {
  await page.addInitScript(({ endpoint, permission }) => {
    let activePermission = permission;
    let subscription: {
      endpoint: string;
      expirationTime: null;
      toJSON(): { endpoint: string; expirationTime: null; keys: { p256dh: string; auth: string } };
      unsubscribe(): Promise<boolean>;
    } | null = null;
    let prompts = 0;
    const pushManager = {
      async getSubscription() { return subscription; },
      async subscribe() {
        subscription = {
          endpoint,
          expirationTime: null,
          toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) } }),
          async unsubscribe() { subscription = null; return true; },
        };
        return subscription;
      },
    };
    const registration = Object.assign(new EventTarget(), {
      waiting: null,
      installing: null,
      pushManager,
      update: async () => undefined,
    });
    const serviceWorker = Object.assign(new EventTarget(), {
      controller: {},
      ready: Promise.resolve(registration),
      register: async () => registration,
    });
    const notification = {
      get permission() { return activePermission; },
      async requestPermission() { prompts += 1; activePermission = "granted"; return activePermission; },
    };
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(window, "PushManager", { configurable: true, value: class {} });
    Object.defineProperty(window, "Notification", { configurable: true, value: notification });
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: serviceWorker });
    Object.assign(window, { __pushTest: { get prompts() { return prompts; }, get subscribed() { return Boolean(subscription); } } });
  }, { endpoint, permission });
}

test("leidimo neprašo atidarius nustatymus, o aiškus veiksmas įregistruoja įrenginį", async ({ page }) => {
  await installPushBrowser(page);
  let subscriptions: Array<Record<string, unknown>> = [];
  let posted: Record<string, unknown> = {};
  await page.route("**/api/push/subscriptions", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { configured: true, publicKey: "B".repeat(87), subscriptions } });
    }
    posted = route.request().postDataJSON();
    subscriptions = [{
      id: 71,
      deviceName: posted.deviceName,
      endpointFingerprint,
      createdAt: "2026-10-04T10:00:00.000Z",
      updatedAt: "2026-10-04T10:00:00.000Z",
      lastPushAcceptedAt: null,
      failureCount: 0,
    }];
    return route.fulfill({ status: 201, json: { id: 71, subscriptions } });
  });
  await page.route("**/api/push/test", route => route.fulfill({ json: { ok: true } }));

  await page.goto("/");
  await page.getByRole("button", { name: "Nustatymai", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Pranešimai" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __pushTest: { prompts: number } }).__pushTest.prompts)).toBe(0);

  await page.getByLabel("Šio įrenginio pavadinimas").fill("Mano Mac");
  await page.getByRole("button", { name: "Įjungti pranešimus šiame įrenginyje" }).click();
  await expect(page.getByText("Pranešimai šiame įrenginyje įjungti kaip")).toContainText("Mano Mac");
  expect(await page.evaluate(() => (window as unknown as { __pushTest: { prompts: number; subscribed: boolean } }).__pushTest.prompts)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { __pushTest: { subscribed: boolean } }).__pushTest.subscribed)).toBe(true);
  expect(posted.endpoint).toBe(endpoint);

  await page.getByRole("button", { name: "Bandyti" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Bandomasis pranešimas išsiųstas" })).toBeVisible();
});

test("užblokuotas leidimas ir nesukonfigūruotas serveris paaiškinami be prompt", async ({ page }) => {
  await installPushBrowser(page, "denied");
  await page.route("**/api/push/subscriptions", route => route.fulfill({
    json: { configured: false, publicKey: "", subscriptions: [] },
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "Nustatymai", exact: true }).click();
  await expect(page.getByText("Administratorius dar nenustatė VAPID raktų")).toBeVisible();
  await expect(page.getByText("Pranešimai užblokuoti naršyklės nustatymuose.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Įjungti pranešimus šiame įrenginyje" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pushTest: { prompts: number } }).__pushTest.prompts)).toBe(0);
});

test("prenumeratų įkėlimo klaida nepasilieka kaip amžinas krovimas", async ({ page }) => {
  await installPushBrowser(page);
  await page.route("**/api/push/subscriptions", route => route.fulfill({
    status: 503,
    json: { error: "Pranešimų nustatymai laikinai nepasiekiami." },
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "Nustatymai", exact: true }).click();
  await expect(page.getByText("Pranešimų nustatymai laikinai nepasiekiami.", { exact: true })).toBeVisible();
  await expect(page.getByText("Kraunami pranešimų nustatymai…")).toHaveCount(0);
});

test("nepalaikoma naršyklė vis tiek gali pašalinti kito įrenginio prenumeratą", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
  });
  let subscriptions = [{
    id: 91,
    deviceName: "Darbo telefonas",
    endpointFingerprint: "0123456789abcdef",
    createdAt: "2026-10-05T10:00:00.000Z",
    updatedAt: "2026-10-05T10:00:00.000Z",
    lastPushAcceptedAt: null,
    failureCount: 0,
  }];
  await page.route("**/api/push/subscriptions", async route => {
    if (route.request().method() === "DELETE") subscriptions = [];
    await route.fulfill({ json: { configured: true, publicKey: "B".repeat(87), subscriptions } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Nustatymai", exact: true }).click();
  await expect(page.getByText("Žemiau vis tiek gali valdyti kitus savo įrenginius.")).toBeVisible();
  await expect(page.getByText("Darbo telefonas")).toBeVisible();
  await page.getByRole("button", { name: "Pašalinti" }).click();
  await expect(page.getByText("Darbo telefonas")).toHaveCount(0);
});
