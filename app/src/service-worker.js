const CACHE = "app-__BUILD_VERSION__";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key.startsWith("app-") && key !== CACHE).map((key) => caches.delete(key)));
  await self.clients.claim();
})()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  const key = event.request.mode === "navigate" ? "/" : event.request;
  // HTML and question data must be fresh online; hashed assets are immutable.
  const immutable = url.pathname.startsWith("/assets/");
  const response = caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(key);
    if (immutable && cached) return cached;
    try {
      const fresh = await fetch(event.request, { cache: "no-cache" });
      if (fresh.ok) await cache.put(key, fresh.clone());
      return fresh;
    } catch (error) {
      if (cached) return cached;
      throw error;
    }
  });
  event.respondWith(response);
});
