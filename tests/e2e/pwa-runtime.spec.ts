import { expect, test, type Page } from "@playwright/test";

async function installFakeWaitingWorker(page: Page, activate = true) {
  await page.addInitScript((shouldActivate) => {
    class FakeWorker extends EventTarget {
      state: ServiceWorkerState = "installed";
      postMessage() {
        sessionStorage.setItem("pwa-test-skip-waiting", "sent");
        if (!shouldActivate) return;
        this.state = "activating";
        queueMicrotask(() => {
          this.state = "activated";
          fakeServiceWorker.controller = this as unknown as ServiceWorker;
          fakeServiceWorker.dispatchEvent(new Event("controllerchange"));
        });
      }
    }
    const worker = new FakeWorker();
    const registration = Object.assign(new EventTarget(), {
      waiting: worker as unknown as ServiceWorker | null,
      installing: null,
      update: async () => undefined,
    });
    const fakeServiceWorker = Object.assign(new EventTarget(), {
      controller: worker as unknown as ServiceWorker | null,
      register: async () => registration as unknown as ServiceWorkerRegistration,
    });
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: fakeServiceWorker });
    Object.assign(window, { __pwaTest: { registration, worker } });
  }, activate);
}

test("be ryšio rodoma būsena ir išjungiami pagrindiniai rašymo veiksmai", async ({ page, context }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Užduotys", exact: true }).click();
  await page.getByRole("button", { name: "Nauja užduotis", exact: true }).first().click();
  await page.getByLabel("Pavadinimas").fill("Offline patikros užduotis");
  await page.getByRole("button", { name: "Sukurti", exact: true }).click();
  await page.getByRole("button", { name: "Fokusas", exact: true }).click();
  await page.getByRole("button", { name: "Nustatymai", exact: true }).click();
  await expect(page.getByRole("link", { name: "Susieti Google paskyrą" })).toBeVisible();
  await context.setOffline(true);
  try {
    const status = page.getByRole("status").filter({ hasText: "Nėra interneto" });
    await expect(status).toBeVisible();
    await expect(page.getByRole("button", { name: "Nauja užduotis", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Užbaigti fokusuojamą užduotį" })).toBeDisabled();
    await expect(page.getByRole("link", { name: "Susieti Google paskyrą" })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("button", { name: "Eksportuoti (be žetonų)" })).toBeDisabled();
  } finally {
    await context.setOffline(false);
  }
  await expect(page.getByRole("status").filter({ hasText: "Nėra interneto" })).toHaveCount(0);
});

test("laikina paskyros patikros tinklo klaida neišregistruoja naudotojo", async ({ page }) => {
  await page.route("**/api/auth/me", route => route.abort("connectionrefused"));
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "Nustatymai", exact: true })).toBeVisible();
});

test("atidarant programėlę pratęsiamas ilgalaikis prisijungimo slapukas", async ({ page, context }) => {
  await page.goto("/");
  const session = (await context.cookies()).find(cookie => cookie.name === "planner_session");
  expect(session).toBeTruthy();
  const remainingDays = (session!.expires * 1000 - Date.now()) / 86_400_000;
  expect(remainingDays).toBeGreaterThan(29.9);
  expect(remainingDays).toBeLessThanOrEqual(30.01);
});

test("nauja versija siūloma aiškiu veiksmu ir saugo atidarytą redagavimą", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Užduotys", exact: true }).click();
  await page.getByRole("button", { name: "Nauja užduotis", exact: true }).first().click();
  await page.getByLabel("Pavadinimas").fill("Neįrašytas tekstas");

  await page.route("**/", async (route) => {
    if (route.request().resourceType() !== "fetch") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<!doctype html><html><head><script src="/_next/static/chunks/nauja-versija.js"></script></head><body></body></html>',
    });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  const update = page.getByRole("button", { name: "Atnaujinti programėlę" });
  await expect(update).toBeVisible();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("neįrašyti pakeitimai");
    await dialog.dismiss();
  });
  await update.click();
  await expect(page.getByLabel("Pavadinimas")).toHaveValue("Neįrašytas tekstas");
});

test("be ryšio kalendoriaus įvykio tempimas ir dydžio keitimas nereaguoja", async ({ page, context }) => {
  const day = "2026-09-23";
  const event = {id:"offline-event",calendarId:"primary",provider:"google",connectionId:"google-connection",key:JSON.stringify(["google","google-connection","primary","offline-event"]),version:'"v1"',summary:"Offline gestas",editable:true,readOnlyReason:"",attendeeCount:0,allDay:false,recurring:false,canRespond:false,showAs:"busy",visibility:"default",reminder:{mode:"default"},timeZone:"UTC",start:{dateTime:`${day}T10:00:00Z`},end:{dateTime:`${day}T11:00:00Z`}};
  let writes = 0;
  await page.clock.setFixedTime(new Date(`${day}T09:00:00Z`));
  await page.route("**/api/tasks?envelope=1", route => route.fulfill({json:{items:[],warnings:[],lists:[],cleanups:[]}}));
  await page.route("**/api/google/events**", route => {
    if (route.request().method() !== "GET") writes += 1;
    return route.fulfill({json:route.request().method() === "GET" ? {items:[event]} : event});
  });
  await page.route("**/api/microsoft/events**", route => route.fulfill({json:{items:[]}}));
  await page.goto("/");
  await page.getByRole("button", {name:"Diena", exact:true}).click();
  const details = page.getByRole("button", {name:"Redaguoti įvykį: Offline gestas"});
  const block = page.locator(".eventBlock").filter({hasText:"Offline gestas"});
  await expect(page.getByRole("button", {name:"Keisti įvykio trukmę: Offline gestas"})).toBeVisible();

  await context.setOffline(true);
  try {
    await expect(page.getByRole("button", {name:"Keisti įvykio trukmę: Offline gestas"})).toHaveCount(0);
    await details.press("Shift+ArrowDown");
    const box = await details.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 10);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 40, box!.y + 60, {steps:4});
    await expect.poll(() => block.evaluate(element => (element as HTMLElement).style.transform)).toBe("");
    await page.mouse.up();
  } finally {
    await context.setOffline(false);
  }
  expect(writes).toBe(0);
});

test("laukiantis service worker aktyvuojamas tik aiškiu veiksmu ir perkrauna programėlę", async ({ page }) => {
  await installFakeWaitingWorker(page);
  await page.goto("/");
  const update = page.getByRole("button", { name: "Atnaujinti programėlę" });
  await expect(update).toBeVisible();

  await Promise.all([
    page.waitForEvent("framenavigated"),
    update.click(),
  ]);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("pwa-test-skip-waiting"))).toBe("sent");
});

test("kitoje kortelėje jau aktyvuotas workeris nepalieka atnaujinimo užstrigusio", async ({ page }) => {
  await installFakeWaitingWorker(page);
  await page.goto("/");
  const update = page.getByRole("button", { name: "Atnaujinti programėlę" });
  await expect(update).toBeVisible();
  await page.evaluate(() => {
    const state = (window as unknown as {__pwaTest:{registration:{waiting:ServiceWorker|null};worker:{state:ServiceWorkerState}}}).__pwaTest;
    state.registration.waiting = null;
    state.worker.state = "activated";
    sessionStorage.removeItem("pwa-test-skip-waiting");
  });

  await Promise.all([
    page.waitForEvent("framenavigated"),
    update.click(),
  ]);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("pwa-test-skip-waiting"))).toBeNull();
});

test("negavus controllerchange atnaujinimas po termino vis tiek perkrauna programėlę", async ({ page }) => {
  await installFakeWaitingWorker(page, false);
  await page.goto("/");
  const update = page.getByRole("button", { name: "Atnaujinti programėlę" });
  await expect(update).toBeVisible();

  await Promise.all([
    page.waitForEvent("framenavigated"),
    update.click(),
  ]);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("pwa-test-skip-waiting"))).toBe("sent");
});
