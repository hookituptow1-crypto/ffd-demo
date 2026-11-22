// Service worker: caches only the static shell (never API data / personal info) and shows push alerts.
const CACHE = 'ffd-shell-v2';
const SHELL = ['/', '/app.html', '/css/styles.css', '/js/common.js', '/js/brand.js', '/js/airports.js', '/js/app.js', '/icons/logo.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: 'FFD', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'FFD', { body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: d.url || '/app.html' } }));
});
self.addEventListener('notificationclick', (e) => { e.notification.close(); e.waitUntil(clients.openWindow(e.notification.data.url)); });
