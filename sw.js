// Nestrel's service worker (2026-10-12). It exists so phones can install Nestrel, and so a student
// who opens it with no signal sees a friendly offline page instead of the browser's error.
//
// It deliberately caches almost NOTHING:
//  - only offline.html, a copy of styles.css for it, and the app icons — the same for everyone
//    (the app itself loads styles.css?v=…, a different address, so this copy never reaches it);
//  - never index.html, the JS or the CSS — those already have their own ?v= cache markers
//    (CLAUDE.md, "Browser cache"), and a second cache here would serve stale code;
//  - never anything from Supabase or any other site — accounts, messages, listings. It only ever
//    looks at requests to this site, so one student's data can never be stored or shown to another.
// Pages always come from the network; the offline page is only the fallback when that fails.
// Changing this file: bump VERSION, so the browser replaces the old worker and its cache.
const VERSION = 'nestrel-2026-10-12a';
const SHELL = ['/offline.html', '/styles.css', '/images/icons/icon-192.png', '/images/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  // Page loads only: everything else (scripts, images, Supabase) is left to the browser untouched.
  if (req.mode !== 'navigate' || req.method !== 'GET') return;
  e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
});
