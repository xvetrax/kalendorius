const CACHE_PREFIX = "dienos-planas-public-";
const CACHE_VERSION = "v3";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const OFFLINE_URL = "/offline.html";
const PUBLIC_ASSETS = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/favicon.svg",
  "/pwa/offline.css",
  "/pwa/icon-192.png",
  "/pwa/icon-512.png",
  "/pwa/icon-maskable-512.png",
  "/pwa/apple-touch-icon.png",
];
const PUBLIC_PATHS = new Set(PUBLIC_ASSETS);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(
      PUBLIC_ASSETS.map((path) => new Request(new URL(path, self.location.origin), { cache: "reload", credentials: "omit" })),
    )),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") event.waitUntil(self.skipWaiting());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { /* Use privacy-safe defaults. */ }
  const messages = {
    test: { body: "Pranešimai šiame įrenginyje veikia.", tag: "dienos-planas-test" },
    focus_end: { body: "Fokusavimo sesija baigėsi — metas atsikvėpti.", tag: "dienos-planas-focus-end" },
    task_start: { body: "Suplanuota užduotis netrukus prasidės.", tag: "dienos-planas-task-start" },
    morning_plan: { body: "Metas peržiūrėti ir susiplanuoti savo dieną.", tag: "dienos-planas-morning-plan" },
    evening_close: { body: "Metas užbaigti dieną ir pasiruošti rytojui.", tag: "dienos-planas-evening-close" },
  };
  const message = payload?.v === 1 && ["focus_end", "task_start", "morning_plan", "evening_close"].includes(payload.type)
    ? messages[payload.type]
    : payload?.type === "test" ? messages.test : { body: "Turi naują priminimą.", tag: "dienos-planas-reminder" };
  event.waitUntil(self.registration.showNotification("Dienos planas", {
    body: message.body,
    icon: "/pwa/icon-192.png",
    badge: "/pwa/icon-192.png",
    tag: message.tag,
    data: { url: "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL("/", self.location.origin);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.navigate(target.href);
        return client.focus();
      }
    }
    return self.clients.openWindow(target.href);
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Private APIs, authentication responses and user pages always stay on the
  // network. Their responses are never written to Cache Storage.
  if (url.pathname.startsWith("/api/") || url.pathname === "/login") return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => (
      await caches.match(OFFLINE_URL, { cacheName: CACHE_NAME })
      || Response.error()
    )));
    return;
  }

  if (!PUBLIC_PATHS.has(url.pathname)) return;
  event.respondWith(
    caches.match(request, { cacheName: CACHE_NAME }).then((cached) => cached || fetch(request)),
  );
});
