/* Folio service worker — hand-rolled, no build step, no dependencies.
 * Caches the app shell, built assets and cover images. Audio, SSE and every
 * other /api/ call are network-only: audio must never live in the cache
 * (docs/folio-application-spec.md, PWA). Bump VERSION when the shell changes;
 * activate deletes everything from older versions. */
const VERSION = "folio-v3";
const SHELL_CACHE = VERSION + "-shell";
const CONTENT_CACHE = VERSION + "-content";
const SHELL = [
  "/",
  "/offline.html",
  "/site.webmanifest",
  "/favicon.svg",
  "/favicon.ico",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
];

/** Pure routing decision, unit-tested from src/pwa.test.ts by evaluating this
 * file with a fake `self`.
 * - "network": never touch the cache (audio, SSE, API, non-GET).
 * - "cache":   cache-first with background refresh (assets, covers, icons).
 * - "navigate": network-first, /offline.html when offline. */
function routeFor(path, method, mode) {
  if (method !== "GET") return "network";
  if (path.indexOf("/api/") !== 0) return mode === "navigate" ? "navigate" : "cache";
  if (path.indexOf("/api/v1/audio/") === 0) return "network";
  if (/^\/api\/v1\/books\/[^/]+\/cover(\?|$)/.test(path)) return "cache";
  return "network";
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.indexOf(VERSION) !== 0).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const route = routeFor(url.pathname, request.method, request.mode);
  if (route === "cache") event.respondWith(cacheFirst(event, request));
  else if (route === "navigate") event.respondWith(navigate(request));
});

async function cacheFirst(event, request) {
  const cache = await caches.open(CONTENT_CACHE);
  const hit = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  event.waitUntil(refresh);
  return hit || (await refresh) || Response.error();
}

async function navigate(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(SHELL_CACHE);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (await caches.match(request)) || (await caches.match("/offline.html")) || Response.error();
  }
}
