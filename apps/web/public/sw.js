/*
 * Service worker d'Ecole : lecture hors connexion du portail des parents et de « Ma journée ».
 *
 * - Fichiers statiques (/_next/static, icônes) : cache d'abord.
 * - Pages du portail et de « Ma journée » : réseau d'abord, dernière version en secours. Ces pages
 *   sont des coquilles statiques, identiques pour tous : aucune donnée personnelle dedans.
 * - Données (GET /api/portal/*, /api/teacher/*) : réseau d'abord, dernière réponse en secours,
 *   marquée de l'heure d'enregistrement (en-tête x-ecole-cached-at) pour le bandeau.
 * - Jamais de cache : authentification, paiements, santé, fichiers et documents PDF (bulletins,
 *   relevés, reçus), toute requête autre que GET.
 *   Le cache des données est purgé par le site à la déconnexion.
 */
const VERSION = 'v1';
const STATIC_CACHE = `ecole-static-${VERSION}`;
const PAGE_CACHE = `ecole-pages-${VERSION}`;
const DATA_CACHE = 'ecole-data';
const CACHED_AT = 'x-ecole-cached-at';

const OFFLINE_PAGES = [
  '/portail',
  '/portail/notes',
  '/portail/absences',
  '/portail/devoirs',
  '/portail/messages',
  '/portail/calendrier',
  '/enseignant',
];
const PAGE_SCOPE = /^\/(portail|enseignant)(\/|$)/;
const DATA_SCOPE = /^\/api\/(portal|teacher)\//;
const NEVER_CACHED =
  /\/(auth|health|payments?|paiement|finance|files?|webhooks?)(\/|$)|(\/|\.)pdf$/;

const OFFLINE_HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hors connexion · Ecole</title></head><body style="font-family:system-ui,sans-serif;background:#F6F5F0;color:#14201A;padding:24px;max-width:28rem;margin:auto"><h1 style="font-size:1.5rem">Hors connexion</h1><p>Cette page n’a pas encore été consultée sur ce téléphone. Elle sera disponible au retour du réseau.</p><p><a href="/portail" style="color:#0E6B4A;font-weight:600">Retour à l’accueil</a></p></body></html>`;

/** Met en cache une page et les fichiers statiques qu'elle charge (JS, CSS). */
async function cachePage(path) {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok || res.redirected) return;
  const pages = await caches.open(PAGE_CACHE);
  await pages.put(path, res.clone());
  const html = await res.text();
  const assets = [...new Set(html.match(/\/_next\/static\/[^"'\s)\\]+/g) ?? [])];
  const statics = await caches.open(STATIC_CACHE);
  await Promise.all(
    assets.map(async (url) => {
      if (await statics.match(url)) return;
      try {
        const asset = await fetch(url);
        if (asset.ok) await statics.put(url, asset);
      } catch {
        // Fichier indisponible : il sera mis en cache à la première consultation.
      }
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all(OFFLINE_PAGES.map((p) => cachePage(p).catch(() => undefined))).then(() =>
      self.skipWaiting(),
    ),
  );
});

/** Retire des données gardées ce qui n'aurait pas dû l'être (PDF gardés par une version antérieure). */
async function purgeNeverCached() {
  const data = await caches.open(DATA_CACHE);
  const keys = await data.keys();
  await Promise.all(
    keys
      .filter((req) => NEVER_CACHED.test(new URL(req.url).pathname.slice(4)))
      .map((req) => data.delete(req)),
  );
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (k) => k.startsWith('ecole-') && ![STATIC_CACHE, PAGE_CACHE, DATA_CACHE].includes(k),
            )
            .map((k) => caches.delete(k)),
        ),
      )
      .then(purgeNeverCached)
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'purge') event.waitUntil(caches.delete(DATA_CACHE));
});

async function staticFirst(request) {
  const cached = await caches.match(request, { cacheName: STATIC_CACHE });
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) (await caches.open(STATIC_CACHE)).put(request, res.clone());
  return res;
}

async function pageNetworkFirst(request, path) {
  try {
    const res = await fetch(request);
    if (res.ok && !res.redirected && PAGE_SCOPE.test(path))
      (await caches.open(PAGE_CACHE)).put(path, res.clone());
    return res;
  } catch {
    const cached = await caches.match(path, { cacheName: PAGE_CACHE });
    return (
      cached ??
      new Response(OFFLINE_HTML, {
        status: 503,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    );
  }
}

async function dataNetworkFirst(request) {
  try {
    const res = await fetch(request);
    if (res.ok && res.status === 200) {
      const body = await res.clone().blob();
      const headers = new Headers(res.headers);
      headers.set(CACHED_AT, new Date().toISOString());
      (await caches.open(DATA_CACHE)).put(
        request.url,
        new Response(body, { status: 200, headers }),
      );
    }
    return res;
  } catch {
    const cached = await caches.match(request.url, { cacheName: DATA_CACHE });
    return (
      cached ??
      new Response(
        JSON.stringify({ statusCode: 503, message: 'Hors connexion : données non disponibles.' }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      )
    );
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;

  if (path.startsWith('/api/')) {
    if (DATA_SCOPE.test(path) && !NEVER_CACHED.test(path.slice(4)))
      event.respondWith(dataNetworkFirst(request));
    return;
  }
  if (
    path.startsWith('/_next/static/') ||
    path === '/icon.svg' ||
    path === '/manifest.webmanifest'
  ) {
    event.respondWith(staticFirst(request));
    return;
  }
  if (request.mode === 'navigate') event.respondWith(pageNetworkFirst(request, path));
});
