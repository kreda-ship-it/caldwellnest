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
//
// Push notifications (2026-10-12, js/push.js): the phone wakes this worker when an alert arrives,
// even with Nestrel closed. It shows the alert, and a tap opens the conversation or listing inside
// Nestrel. The alert's words come from the database (push_targets), already decided; this file
// only displays them.
// Changing this file: bump VERSION, so the browser replaces the old worker and its cache.
const VERSION = 'nestrel-2026-10-12b';
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

// ---- Push notifications ----
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { /* not ours, or garbled: show the plain fallback */ }
  // Every push must show an alert: iPhone and Chrome both stop delivering to a site that receives
  // pushes and shows nothing. So even an empty one says something.
  e.waitUntil(self.registration.showNotification(d.title || 'Nestrel', {
    body: d.body || 'Something new on Nestrel',
    icon: '/images/icons/icon-192.png',
    tag: d.tag || undefined,            // a newer alert about the same chat or listing replaces the older one
    renotify: !!d.tag,                  // …and still buzzes
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  // Only ever a page of this site, whatever the alert says.
  let url = new URL(e.notification.data?.url || '/', self.location.origin);
  if (url.origin !== self.location.origin) url = new URL('/', self.location.origin);
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find(w => new URL(w.url).origin === self.location.origin);
    if (open) {
      // Nestrel is already open: bring it forward and let js/push.js open the chat or listing,
      // instead of reloading the whole app.
      try { await open.focus(); } catch { /* some browsers refuse; the message below still lands */ }
      open.postMessage({ type: 'nestrel-open', url: url.href });
      return;
    }
    await self.clients.openWindow(url.href);   // closed: open it straight onto that route
  })());
});
