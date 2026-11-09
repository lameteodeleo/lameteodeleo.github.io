// La météo de Léo : service worker minimal.
// Il rend l'app installable comme une vraie app et garde la dernière version pour l'afficher hors connexion.
const CACHE = "lameteodeleo-v1";
const BASE = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(BASE)).catch(() => {}));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Toujours le réseau d'abord (prévisions fraîches), la copie gardée seulement si le réseau ne répond pas
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const cle = url.pathname.endsWith("/data/meteo.json") ? url.origin + url.pathname : e.request;
  e.respondWith(
    fetch(e.request)
      .then(r => { if (r.ok) { const copie = r.clone(); caches.open(CACHE).then(c => c.put(cle, copie)); } return r; })
      .catch(() => caches.match(cle, { ignoreSearch: true }))
  );
});
