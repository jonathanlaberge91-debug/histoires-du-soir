// Cache l'interface pour un démarrage instantané ; les appels API passent toujours par le réseau.
// Toujours le réseau d'abord, SANS le cache HTTP du navigateur : une nouvelle version arrive dès la
// réouverture. Le cache ne sert que hors ligne. Les polices (Google Fonts) sont gardées pour de bon :
// sans réseau, l'app garde son look.
const CACHE = 'histoires-v18';
const POLICES = 'histoires-polices';
const FILES = ['./', 'index.html', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== POLICES).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(POLICES).then(async c => {
      const garde = await c.match(e.request);
      if (garde) return garde;
      const r = await fetch(e.request);
      if (r.ok || r.type === 'opaque') c.put(e.request, r.clone());
      return r;
    }));
    return;
  }
  if (u.origin !== location.origin) return;
  if (u.pathname.includes('/histoires/tts') || u.pathname.includes('/histoires/partage') || u.pathname.includes('/histoires/ecouter')) return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => {
    const copie = r.clone();
    caches.open(CACHE).then(c => c.put(e.request, copie));
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
