const CACHE_NAME = 'free-food-map-v19';
const APP_SHELL = ['/', '/index.html', '/app.css?v=12', '/app.js?v=19', '/api/meta', '/location-snapshot.json', '/snapshot-search.mjs', '/hours.mjs', '/manifest.webmanifest', '/community-food-hero.webp', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', function (event) {
	event.waitUntil(
		caches.open(CACHE_NAME).then(function (cache) {
			return Promise.allSettled(APP_SHELL.map(function (asset) { return cache.add(asset); }));
		}),
	);
	self.skipWaiting();
});

self.addEventListener('activate', function (event) {
	event.waitUntil(
		caches.keys().then(function (names) {
			return Promise.all(names.filter(function (name) { return name !== CACHE_NAME; }).map(function (name) { return caches.delete(name); }));
		}),
	);
	self.clients.claim();
});

async function networkFirst(request) {
	var cache = await caches.open(CACHE_NAME);
	try {
		var response = await fetch(request);
		if (response.ok) cache.put(request, response.clone());
		return response;
	} catch (error) {
		var cached = await cache.match(request);
		if (cached) return cached;
		throw error;
	}
}

self.addEventListener('fetch', function (event) {
	var request = event.request;
	if (request.method !== 'GET') return;
	var url = new URL(request.url);

	if (url.origin === self.location.origin && (url.pathname.startsWith('/api/locations') || url.pathname === '/api/stats')) {
		event.respondWith(networkFirst(request));
		return;
	}

	if (request.mode === 'navigate') {
		event.respondWith(networkFirst(request).catch(function () { return caches.match('/index.html'); }));
		return;
	}

	if (url.origin === self.location.origin) {
		event.respondWith(networkFirst(request));
	}
});
