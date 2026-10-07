// Cache l'interface pour un démarrage instantané ; les appels API passent toujours par le réseau.
// Toujours le réseau d'abord, SANS le cache HTTP du navigateur (GitHub Pages garde les pages 10 min) :
// une nouvelle version arrive dès la réouverture. Le cache ne sert que hors ligne.
const CACHE = 'histoires-v8';
const FILES = ['./', 'index.html', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => {
    const copie = r.clone();
    caches.open(CACHE).then(c => c.put(e.request, copie));
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
