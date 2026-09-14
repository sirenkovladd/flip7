// Flip 7 PWA service worker.
//
// Cache-first app shell (instant second load + offline), network-first
// for nothing else — game data flows over WS and must never be cached.
// sw.js itself is served `no-cache` so version bumps roll out.
const CACHE = 'flip7-v0.2.0';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/game/deck.js',
  '/game/engine.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/vendor/qrcode.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) return; // never cache
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      // Stale-while-revalidate: instant paint, background refresh.
      const fetchP = fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || fetchP;
    }),
  );
});
