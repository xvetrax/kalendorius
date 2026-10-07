import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadWorker({ network = async () => new Response("network") } = {}) {
  const listeners = new Map();
  const deleted = [];
  const cachedRequests = [];
  const notifications = [];
  const opened = [];
  let focused = 0;
  let navigated = "";
  const offlineResponse = new Response("offline", { headers: { "content-type": "text/html" } });
  const assetResponse = new Response("asset");
  const context = {
    URL,
    Request,
    Response,
    Set,
    Promise,
    fetch: network,
    caches: {
      async open() {
        return { async addAll(requests) { cachedRequests.push(...requests); } };
      },
    async keys() { return ["dienos-planas-public-v0", "dienos-planas-public-v1", "dienos-planas-public-v2", "dienos-planas-public-v3", "kitas-cache"]; },
      async delete(name) { deleted.push(name); return true; },
      async match(request) {
        const path = typeof request === "string" ? request : new URL(request.url).pathname;
        if (path === "/offline.html") return offlineResponse.clone();
        if (path === "/pwa/icon-192.png") return assetResponse.clone();
        return undefined;
      },
    },
    self: {
      location: { origin: "https://planner.example" },
      registration: { async showNotification(title, options) { notifications.push({ title, options }); } },
      clients: {
        async claim() {},
        async matchAll() { return context.__windows || []; },
        async openWindow(url) { opened.push(url); return { url }; },
      },
      async skipWaiting() {},
      addEventListener(type, listener) { listeners.set(type, listener); },
    },
    __windows: [],
  };
  vm.runInNewContext(await readFile(new URL("../public/sw.js", import.meta.url), "utf8"), context, { filename: "public/sw.js" });
  return {
    listeners, deleted, cachedRequests, notifications, opened,
    setWindow(url) {
      context.__windows = [{
        url,
        async navigate(target) { navigated = target; this.url = target; return this; },
        async focus() { focused += 1; return this; },
      }];
    },
    get focused() { return focused; },
    get navigated() { return navigated; },
  };
}

function lifetimeEvent() {
  let work;
  return { event: { waitUntil(value) { work = value; } }, done: () => work };
}

function fetchEvent(url, init = {}) {
  let response;
  return {
    event: {
      request: new Request(url, init),
      respondWith(value) { response = value; },
    },
    response: () => response,
  };
}

test("service worker podėlyje laiko tik aiškiai leistus viešus failus", async () => {
  const worker = await loadWorker();
  const install = lifetimeEvent();
  worker.listeners.get("install")(install.event);
  await install.done();

  const paths = worker.cachedRequests.map((request) => new URL(request.url).pathname);
  assert.ok(paths.includes("/offline.html"));
  assert.ok(paths.includes("/manifest.webmanifest"));
  assert.ok(paths.includes("/pwa/icon-192.png"));
  assert.ok(paths.includes("/pwa/offline-plan.js"));
  assert.ok(paths.every((path) => !path.startsWith("/api/") && path !== "/login"));
  assert.ok(worker.cachedRequests.every((request) => request.credentials === "omit"));
});

test("service worker neliečia API, prisijungimo ir rašymo užklausų", async () => {
  const worker = await loadWorker();
  for (const sample of [
    fetchEvent("https://planner.example/api/tasks"),
    fetchEvent("https://planner.example/login"),
    fetchEvent("https://planner.example/", { method: "POST" }),
    fetchEvent("https://accounts.google.com/o/oauth2/v2/auth"),
  ]) {
    worker.listeners.get("fetch")(sample.event);
    assert.equal(sample.response(), undefined);
  }
});

test("navigacija be ryšio gauna bendrą offline puslapį, o ne privačius duomenis", async () => {
  const worker = await loadWorker({ network: async () => { throw new TypeError("offline"); } });
  const navigation = fetchEvent("https://planner.example/calendar", { headers: { accept: "text/html" } });
  Object.defineProperty(navigation.event.request, "mode", { value: "navigate" });
  worker.listeners.get("fetch")(navigation.event);
  const response = await navigation.response();
  assert.equal(await response.text(), "offline");

  const icon = fetchEvent("https://planner.example/pwa/icon-192.png");
  worker.listeners.get("fetch")(icon.event);
  assert.equal(await (await icon.response()).text(), "asset");
});

test("aktyvuojant pašalinamas tik senas programėlės podėlis", async () => {
  const worker = await loadWorker();
  const activate = lifetimeEvent();
  worker.listeners.get("activate")(activate.event);
  await activate.done();
  assert.deepEqual(worker.deleted, ["dienos-planas-public-v0", "dienos-planas-public-v1", "dienos-planas-public-v2", "dienos-planas-public-v3"]);
});

test("atnaujinimo žinutė išlaiko workerį gyvą iki skipWaiting pabaigos", async () => {
  const worker = await loadWorker();
  const message = lifetimeEvent();
  worker.listeners.get("message")(Object.assign(message.event, { data: { type: "SKIP_WAITING" } }));
  assert.ok(message.done() instanceof Promise);
  await message.done();
});

test("push turinys yra fiksuotas ir neparodo serverio atsiųsto privataus teksto", async () => {
  const worker = await loadWorker();
  const push = lifetimeEvent();
  push.event.data = { json: () => ({ type: "test", title: "Slapta užduotis", body: "Privatus tekstas", url: "https://evil.example" }) };
  worker.listeners.get("push")(push.event);
  await push.done();
  assert.equal(worker.notifications.length, 1);
  assert.equal(worker.notifications[0].title, "Dienos planas");
  assert.equal(worker.notifications[0].options.body, "Pranešimai šiame įrenginyje veikia.");
  assert.equal(worker.notifications[0].options.data.url, "/");
  assert.ok(!JSON.stringify(worker.notifications[0]).includes("Slapta užduotis"));
});

test("fokusavimo pranešimas turi fiksuotą privatų tekstą ir atskirą žymą", async () => {
  const worker = await loadWorker();
  const push = lifetimeEvent();
  push.event.data = { json: () => ({ v: 1, type: "focus_end", title: "Slapta užduotis" }) };
  worker.listeners.get("push")(push.event);
  await push.done();
  assert.equal(worker.notifications[0].options.body, "Fokusavimo sesija baigėsi — metas atsikvėpti.");
  assert.equal(worker.notifications[0].options.tag, "dienos-planas-focus-end");
  assert.ok(!JSON.stringify(worker.notifications[0]).includes("Slapta užduotis"));
});

test("užduoties pradžios pranešimas turi fiksuotą privatų tekstą ir atskirą žymą", async () => {
  const worker = await loadWorker();
  const push = lifetimeEvent();
  push.event.data = { json: () => ({ v: 1, type: "task_start", title: "Slapta užduotis", taskKey: "local:1" }) };
  worker.listeners.get("push")(push.event);
  await push.done();
  assert.equal(worker.notifications[0].options.body, "Suplanuota užduotis netrukus prasidės.");
  assert.equal(worker.notifications[0].options.tag, "dienos-planas-task-start");
  assert.ok(!JSON.stringify(worker.notifications[0]).includes("Slapta užduotis"));
  assert.ok(!JSON.stringify(worker.notifications[0]).includes("local:1"));
});

test("ryto ir vakaro ritualai turi fiksuotą privatų tekstą bei atskiras žymas", async () => {
  const worker = await loadWorker();
  for (const [type, body, tag] of [
    ["morning_plan", "Metas peržiūrėti ir susiplanuoti savo dieną.", "dienos-planas-morning-plan"],
    ["evening_close", "Metas užbaigti dieną ir pasiruošti rytojui.", "dienos-planas-evening-close"],
  ]) {
    const push = lifetimeEvent();
    push.event.data = { json: () => ({ v: 1, type, title: "Slaptas planas", body: "Privatus tekstas", timeZone: "Europe/Vilnius" }) };
    worker.listeners.get("push")(push.event);
    await push.done();
    const notification = worker.notifications.at(-1);
    assert.equal(notification.options.body, body);
    assert.equal(notification.options.tag, tag);
    assert.ok(!JSON.stringify(notification).includes("Slaptas planas"));
    assert.ok(!JSON.stringify(notification).includes("Europe/Vilnius"));
  }
});

test("paspaustas pranešimas atidaro tik programėlės šaknį", async () => {
  const worker = await loadWorker();
  worker.setWindow("https://planner.example/calendar");
  const click = lifetimeEvent();
  let closed = false;
  click.event.notification = { data: { url: "https://evil.example/steal" }, close() { closed = true; } };
  worker.listeners.get("notificationclick")(click.event);
  await click.done();
  assert.equal(closed, true);
  assert.equal(worker.navigated, "https://planner.example/");
  assert.equal(worker.focused, 1);
  assert.deepEqual(worker.opened, []);
});
