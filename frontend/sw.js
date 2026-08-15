/* Niche Finder — service worker (app-shell cache).
   NETWORK-FIRST for every same-origin GET (HTML, JS, CSS, assets), so a deploy
   ALWAYS lands on the next load; the cache is only an offline fallback. Never
   touches gateway/API calls or non-GET requests, so wallet and live-AI paths
   always hit the network.
   NOTE: bump VERSION on any change here to force old caches to clear on activate. */
const VERSION = 'nf-v3';
const SHELL = [
  'index.html', 'search.html', 'project.html', 'dashboard.html', 'asset.html',
  'growth.html', 'settings.html', 'account.html',
  'nf-config.js', 'nf-auth.js', 'nf-wallet.js', 'nf-support.js', 'nf-consent.js',
  'page.css', 'nf-polish.css', 'icon.svg', 'manifest.webmanifest',
  '../shared/nf-economy.js' // canonical economy — shared with the backend gateway
];

self.addEventListener('install', (e) => {
  // Pre-cache the shell but don't fail install if one URL 404s; skipWaiting so
  // the new worker takes over immediately.
  e.waitUntil(caches.open(VERSION).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/v1/')) return;

  // Network-first for EVERYTHING: fetch fresh, update the cache, fall back to
  // cache only when offline. This guarantees deployed changes are picked up.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
