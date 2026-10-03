import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadWorker({ network = async () => new Response("network") } = {}) {
  const listeners = new Map();
  const deleted = [];
  const cachedRequests = [];
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
      async keys() { return ["dienos-planas-public-v0", "dienos-planas-public-v1", "kitas-cache"]; },
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
      clients: { async claim() {} },
      async skipWaiting() {},
      addEventListener(type, listener) { listeners.set(type, listener); },
    },
  };
  vm.runInNewContext(await readFile(new URL("../public/sw.js", import.meta.url), "utf8"), context, { filename: "public/sw.js" });
  return { listeners, deleted, cachedRequests };
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
  assert.deepEqual(worker.deleted, ["dienos-planas-public-v0"]);
});
