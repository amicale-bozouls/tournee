/* =============================================
   SERVICE WORKER — fonctionnement hors connexion
   Changer VERSION à chaque mise en ligne pour que les téléphones prennent la mise à jour.
   ============================================= */

const VERSION = 'terrain-0.2.3';
const CACHE_APP = 'app-' + VERSION;
const CACHE_EXTERNE = 'externe-v1';   // Leaflet + tuiles de carte déjà vues
const MAX_TUILES = 600;
const CACHE_PARTAGE = 'partage';      // fichier reçu par « Partager → Tournée », lu puis effacé par l'app
const CLE_PARTAGE = 'fichier-partage';

const FICHIERS_APP = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'demo/tournee_demo.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

// Mise en cache fichier par fichier : un fichier manquant ne doit pas bloquer le hors connexion
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_APP)
      // cache: 'reload' : ne pas reprendre les anciens fichiers gardés par le navigateur
      .then(c => Promise.allSettled(FICHIERS_APP.map(f => c.add(new Request(f, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(cles => Promise.all(cles.filter(k => k.startsWith('app-') && k !== CACHE_APP).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Fichier partagé depuis WhatsApp / Mail (Android) : on le garde puis on ouvre l'app
  if (req.method === 'POST' && url.pathname.endsWith('/partage')) {
    e.respondWith(recevoirPartage(req));
    return;
  }
  if (req.method !== 'GET') return;

  // API Adresse : toujours en direct (pas de cache, l'app gère l'absence de réseau)
  if (url.hostname === 'api-adresse.data.gouv.fr') return;
  // L'app de gestion (PC) n'est pas concernée par le mode hors connexion du terrain
  if (url.pathname.includes('/gestion/')) return;

  // Tuiles de carte : cache d'abord, puis réseau (les zones déjà vues restent disponibles)
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    e.respondWith(caches.open(CACHE_EXTERNE).then(async cache => {
      const enCache = await cache.match(req);
      if (enCache) return enCache;
      const rep = await fetch(req);
      if (rep.ok) { cache.put(req, rep.clone()); limiterCache(cache); }
      return rep;
    }));
    return;
  }

  // Fichiers de l'app : réseau d'abord (mises à jour), cache si hors connexion
  if (url.origin === self.location.origin) {
    e.respondWith(
      // no-cache : contourne le cache HTTP de GitHub Pages (10 min) pour voir les mises à jour tout de suite
      // (req.url et non req : une requête de navigation ne peut pas recevoir d'options)
      fetch(req.url, { cache: 'no-cache' })
        .then(rep => {
          if (rep.ok) caches.open(CACHE_APP).then(c => c.put(req, rep.clone()));
          return rep;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
    );
    return;
  }

  // Autres ressources externes (Leaflet) : cache d'abord
  e.respondWith(caches.match(req).then(r => r || fetch(req)));
});

async function recevoirPartage(req) {
  try {
    const formulaire = await req.formData();
    // Description de ce qui a été reçu, pour diagnostiquer un partage qui échoue
    const recu = [];
    const fichiers = [];
    for (const [nom, valeur] of formulaire.entries()) {
      if (typeof valeur === 'string') {
        recu.push(`${nom}=texte(${valeur.length})`);
      } else {
        recu.push(`${nom}=${valeur.name || '?'} [${valeur.type || 'type ?'}, ${valeur.size} o]`);
        fichiers.push(valeur);
      }
    }
    // WhatsApp envoie aussi un petit « shared.txt » (le nom du fichier) : on garde le vrai fichier JSON
    const note = (f) => (/\.json$/i.test(f.name || '') ? 4 : 0) + (/json/i.test(f.type || '') ? 2 : 0) + (/^shared\.txt$/i.test(f.name || '') ? -4 : 0);
    fichiers.sort((a, b) => note(b) - note(a) || b.size - a.size);
    const contenu = fichiers.length ? await fichiers[0].text() : '';
    const cache = await caches.open(CACHE_PARTAGE);
    await cache.put(CLE_PARTAGE, new Response(contenu, { headers: { 'X-Recu': encodeURIComponent(recu.join(' ; ') || 'rien') } }));
  } catch (err) {
    console.warn('Partage illisible', err);
  }
  return Response.redirect('./?partage=1', 303);
}

async function limiterCache(cache) {
  const cles = await cache.keys();
  const tuiles = cles.filter(r => r.url.includes('tile.openstreetmap.org'));
  for (let i = 0; i < tuiles.length - MAX_TUILES; i++) await cache.delete(tuiles[i]);
}
