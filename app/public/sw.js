// 앱 화면과 문제는 캐시로 먼저 띄우고 뒤에서 새로 받는다. /api 는 건드리지 않는다.
const CACHE = "app-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
	const url = new URL(e.request.url);
	if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
	e.respondWith(
		caches.open(CACHE).then(async (cache) => {
			const key = e.request.mode === "navigate" ? "/" : e.request;
			const cached = await cache.match(key);
			const fresh = fetch(e.request).then((res) => {
				if (res.ok) cache.put(key, res.clone());
				return res;
			});
			if (cached) {
				e.waitUntil(fresh.catch(() => {}));
				return cached;
			}
			return fresh;
		}),
	);
});
