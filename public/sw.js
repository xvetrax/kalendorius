const CACHE_PREFIX = "dienos-planas-public-";
const CACHE_VERSION = "v1";
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
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { /* Use privacy-safe defaults. */ }
  const isTest = payload.type === "test";
  event.waitUntil(self.registration.showNotification("Dienos planas", {
    body: isTest ? "Pranešimai šiame įrenginyje veikia." : "Turi naują priminimą.",
    icon: "/pwa/icon-192.png",
    badge: "/pwa/icon-192.png",
    tag: isTest ? "dienos-planas-test" : "dienos-planas-reminder",
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
