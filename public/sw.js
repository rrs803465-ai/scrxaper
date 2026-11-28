// Scrxaper service worker: offline shell, web push (incoming calls and messages), notification actions.
// Closed app / locked phone: a service worker cannot play custom audio, so a call is delivered like Discord's: a high-priority push shows
// a persistent "calling" notification with Answer/Decline, and the server repeats it every 4 s while it rings so the system notification
// sound and vibration keep ringing. The custom ringtone plays as soon as the app window is awake.
const CACHE = 'scrxaper-shell-v6';
const SHELL = ['/app', '/app.css', '/app.js', '/css/calls.css', '/css/social.css', '/css/studio.css', '/css/polish.css', '/css/fx.css', '/js/music.js', '/js/fx.js', '/js/core.js', '/js/chat.js', '/js/spaces.js', '/js/calls.js', '/js/media.js', '/js/social.js', '/js/studio.js', '/js/setup.js', '/e2ee.js', '/logo.png', '/favicon.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/')) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && (url.pathname === '/app' || /\.(js|css|png|webmanifest)$/.test(url.pathname))) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((hit) => hit || (e.request.mode === 'navigate' ? caches.match('/app') : Response.error()))));
});

const windows = () => self.clients.matchAll({ type: 'window', includeUncontrolled: true });
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data?.json() ?? {}; } catch { d = { t: 'msg', body: e.data?.text() }; }
  e.waitUntil((async () => {
    const wins = await windows();
    const focused = wins.some((w) => w.visibilityState === 'visible' && w.focused);
    if (d.t === 'call') {
      wins.forEach((w) => w.postMessage({ type: 'ring', id: d.id }));
      if (focused) return;
      return self.registration.showNotification(`${d.name || d.from} is calling`, { body: d.video ? 'Incoming video call' : 'Incoming voice call', tag: 'call', renotify: true, requireInteraction: true, silent: false, timestamp: Date.now(), vibrate: [600, 250, 600, 250, 600, 250, 600], icon: '/icon-192.png', badge: '/favicon.png', data: { t: 'call', id: d.id, from: d.from }, actions: [{ action: 'answer', title: 'Answer' }, { action: 'decline', title: 'Decline' }] });
    }
    if (d.t === 'callend') { const open = await self.registration.getNotifications({ tag: 'call' }); open.forEach((n) => n.close()); if (d.missed && !focused) return self.registration.showNotification('Missed call', { body: `From ${d.name || d.from}`, tag: 'missed', icon: '/icon-192.png', data: { t: 'open', from: d.from } }); return; }
    if (focused) return;
    return self.registration.showNotification(d.name || d.title || 'Scrxaper', { body: d.body || 'New message', tag: d.tag || 'msg', icon: '/icon-192.png', badge: '/favicon.png', data: { t: 'open', from: d.from, url: d.url } });
  })());
});

self.addEventListener('notificationclick', (e) => {
  const n = e.notification; const data = n.data ?? {}; n.close();
  e.waitUntil((async () => {
    const wins = await windows();
    const msg = data.t === 'call' ? { type: e.action === 'decline' ? 'call-decline' : 'call-answer', id: data.id } : { type: 'open', from: data.from, url: data.url };
    if (data.t === 'call' && e.action === 'decline' && !wins.length) { await fetch('/api/call/decline', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'scrxaper' }, body: JSON.stringify({ call: data.id }) }).catch(() => {}); return; }
    const w = wins.find((x) => 'focus' in x);
    if (w) { await w.focus(); w.postMessage(msg); return; }
    const client = await self.clients.openWindow('/app'); client?.postMessage?.(msg);
    // The page boots and connects after load: hand the intent over once it can listen.
    setTimeout(async () => { for (const c of await windows()) c.postMessage(msg); }, 2500);
  })());
});
self.addEventListener('notificationclose', () => {});
