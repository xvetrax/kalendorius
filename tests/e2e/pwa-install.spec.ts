import { expect, test } from "@playwright/test";

test("captured browser install prompt is available from settings", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: async () => { (window as typeof window & { pwaPromptCalls?: number }).pwaPromptCalls = 1; },
      userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
    });
    window.dispatchEvent(event);
  });

  await page.getByRole("button", { name: "Nustatymai", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Nustatymai" });
  await expect(settings.getByRole("heading", { name: "Įdiegti programėlę" })).toBeVisible();
  await settings.getByRole("button", { name: "Įdiegti", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { pwaPromptCalls?: number }).pwaPromptCalls)).toBe(1);
  await expect(settings.getByRole("heading", { name: "Įdiegti programėlę" })).toHaveCount(0);
});

test("standalone programoje diegimo kvietimas neberodomas", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      if (query !== "(display-mode: standalone)") return nativeMatchMedia(query);
      return {
        matches: true,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => true,
      };
    };
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nustatymai", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Nustatymai" }).getByRole("heading", { name: "Įdiegti programėlę" })).toHaveCount(0);
});

test("nutrauktas diegimo dialogas saugiai grįžta prie instrukcijų", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => {
    (window as typeof window & { pwaUnhandled?: boolean }).pwaUnhandled = false;
    window.addEventListener("unhandledrejection", () => {
      (window as typeof window & { pwaUnhandled?: boolean }).pwaUnhandled = true;
    });
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: () => Promise.reject(new Error("dialog closed")),
      userChoice: Promise.resolve({ outcome: "dismissed", platform: "web" }),
    });
    window.dispatchEvent(event);
  });
  await page.getByRole("button", { name: "Nustatymai", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Nustatymai" });
  await settings.getByRole("button", { name: "Įdiegti", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Įdiegti", exact: true })).toHaveCount(0);
  await expect(settings.getByText("Naudok kaip atskirą programėlę")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { pwaUnhandled?: boolean }).pwaUnhandled)).toBe(false);
});

test("appinstalled įvykis ir iOS standalone būsena paslepia kvietimą", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await page.getByRole("button", { name: "Nustatymai", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Nustatymai" }).getByRole("heading", { name: "Įdiegti programėlę" })).toHaveCount(0);

  await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { configurable: true, value: true }));
  await page.reload();
  await page.getByRole("button", { name: "Nustatymai", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Nustatymai" }).getByRole("heading", { name: "Įdiegti programėlę" })).toHaveCount(0);
});
