/* TapMap service worker: offline app shell + network-first data. */
const VERSION = "tapmap-v1";
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;
const SHELL_URLS = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const RUNTIME_MAX = 300;
async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - RUNTIME_MAX; i++) await cache.delete(keys[i]);
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      await cache.put(req, res.clone());
      if (cacheName === RUNTIME) trim(cache);
    }
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // RPC POSTs go straight to the network
  const url = new URL(req.url);

  // Never cache admin or API routes.
  if (url.origin === self.location.origin && (url.pathname.startsWith("/admin") || url.pathname.startsWith("/api/"))) return;

  // Page navigations: network-first, fall back to the cached shell.
  if (req.mode === "navigate") {
    event.respondWith(
      networkFirst(req, SHELL).catch(async () => (await caches.match("/")) || Response.error()),
    );
    return;
  }

  // Hashed Next.js assets and fonts are immutable: cache-first.
  if (url.origin === self.location.origin && (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/") || url.pathname.startsWith("/maplibre/"))) {
    event.respondWith(cacheFirst(req, SHELL));
    return;
  }

  // Map style/fonts/sprites and Supabase GETs: network-first with cached fallback.
  if (url.hostname.endsWith("maptiler.com") || url.hostname.endsWith("supabase.co")) {
    event.respondWith(networkFirst(req, RUNTIME));
  }
});
