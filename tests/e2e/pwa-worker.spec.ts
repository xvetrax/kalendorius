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

test("navigacija be ryšio rodo izoliuotą paskutinės dienos planą tik skaitymui", async ({ page, context }) => {
  await page.goto("/");
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await page.evaluate(async () => {
    const request=indexedDB.open("dienos-planas-offline",1);
    await new Promise((resolve,reject)=>{request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains("snapshots"))db.createObjectStore("snapshots",{keyPath:"userKey"});if(!db.objectStoreNames.contains("meta"))db.createObjectStore("meta",{keyPath:"key"});};request.onsuccess=resolve;request.onerror=reject;});
    const db=request.result,transaction=db.transaction(["snapshots","meta"],"readwrite"),now=Date.now();
    transaction.objectStore("snapshots").put({version:1,userKey:"user:1",day:"2026-10-07",capturedAt:now,expiresAt:now+60_000,items:[{kind:"task",title:"Offline užduotis",allDay:false,start:"2026-10-07T09:00:00Z",end:"2026-10-07T09:30:00Z",source:"Vietinė užduotis",provider:"local"}]});
    transaction.objectStore("meta").put({key:"active-user",value:"user:1"});
    await new Promise((resolve,reject)=>{transaction.oncomplete=resolve;transaction.onerror=reject;});db.close();
  });

  await context.setOffline(true);
  try {
    await page.goto("/calendar");
    await expect(page.getByRole("heading", { name: "Nėra interneto ryšio" })).toBeVisible();
    await expect(page.getByText("Offline užduotis")).toBeVisible();
    await expect(page.getByText("TIK SKAITYMUI")).toBeVisible();
    await expect(page.getByText(/aprašymų, dalyvių, nuorodų/)).toBeVisible();
    await expect(page.getByRole("button")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("E2E Admin");
  } finally {
    await context.setOffline(false);
  }
});

test("pasibaigusi offline kopija nerodoma", async ({ page, context }) => {
  await page.goto("/");
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.evaluate(async () => {
    const request=indexedDB.open("dienos-planas-offline",1);await new Promise((resolve,reject)=>{request.onsuccess=resolve;request.onerror=reject;});
    const db=request.result,transaction=db.transaction(["snapshots","meta"],"readwrite");
    transaction.objectStore("snapshots").put({version:1,userKey:"user:1",day:"2026-10-07",capturedAt:1,expiresAt:2,items:[{kind:"task",title:"Pasenusi paslaptis",allDay:true,source:"Vietinė",provider:"local"}]});
    transaction.objectStore("meta").put({key:"active-user",value:"user:1"});await new Promise((resolve,reject)=>{transaction.oncomplete=resolve;transaction.onerror=reject;});db.close();
  });
  await context.setOffline(true);
  try{await page.goto("/calendar");await expect(page.getByText("Galiojančio offline dienos plano šiame įrenginyje nėra.")).toBeVisible();await expect(page.locator("body")).not.toContainText("Pasenusi paslaptis");}finally{await context.setOffline(false);}
});
