import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type Listener = (event: unknown) => void;

/** Charge le service worker dans un bac à sable et renvoie son gestionnaire de requêtes. */
function loadServiceWorker(): (url: string, mode?: string) => boolean {
  const listeners = new Map<string, Listener>();
  const self = {
    location: { origin: 'https://ecole.test' },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
  };
  const source = readFileSync(
    fileURLToPath(new URL('../../public/sw.js', import.meta.url)),
    'utf8',
  );
  // Réseau et caches factices : les stratégies lancées par respondWith vont jusqu'au bout.
  const caches = {
    match: async () => undefined,
    open: async () => ({ put: async () => undefined }),
  };
  const fetch = async () => new Response('{}', { status: 200 });
  runInNewContext(source, { self, URL, Response, Headers, caches, fetch });
  const onFetch = listeners.get('fetch');
  if (!onFetch) throw new Error('Gestionnaire fetch absent');
  return (url, mode = 'cors') => {
    let handled = false;
    onFetch({
      request: { method: 'GET', url: `https://ecole.test${url}`, mode },
      respondWith: (response: Promise<unknown>) => {
        handled = true;
        void Promise.resolve(response).catch(() => undefined);
      },
    });
    return handled;
  };
}

describe('service worker', () => {
  const intercepts = loadServiceWorker();

  it('garde hors connexion les données du portail et de « Ma journée »', () => {
    expect(intercepts('/api/portal/children')).toBe(true);
    expect(intercepts('/api/teacher/today')).toBe(true);
  });

  it('garde aussi les grilles de notes et les listes d’appel de l’enseignant, pas le reste', () => {
    expect(intercepts('/api/grades/class-subjects')).toBe(true);
    expect(intercepts('/api/grades/sheet?classSubjectId=c1&sequenceId=s1')).toBe(true);
    expect(intercepts('/api/attendance/roster?classId=c1&date=2026-10-31&startTime=07:30')).toBe(
      true,
    );
    expect(intercepts('/api/academic/classes')).toBe(true);
    expect(intercepts('/api/grades/progress?sequenceId=s1')).toBe(false);
    expect(intercepts('/api/attendance/justifications')).toBe(false);
    expect(intercepts('/api/finance/payments')).toBe(false);
  });

  it('ne met jamais en cache les documents PDF (bulletins, relevés, reçus)', () => {
    expect(intercepts('/api/portal/report-cards/abc/pdf')).toBe(false);
    expect(intercepts('/api/portal/children/abc/transcript.pdf?termId=t1')).toBe(false);
    expect(intercepts('/api/portal/payments/abc/receipt.pdf')).toBe(false);
  });

  it('purge à l’activation les PDF gardés par une version précédente', async () => {
    const listeners = new Map<string, Listener>();
    const stored = new Set([
      'https://ecole.test/api/portal/children',
      'https://ecole.test/api/portal/report-cards/abc/pdf',
    ]);
    const cache = {
      keys: async () => [...stored].map((url) => ({ url })),
      delete: async (req: { url: string }) => stored.delete(req.url),
    };
    const source = readFileSync(
      fileURLToPath(new URL('../../public/sw.js', import.meta.url)),
      'utf8',
    );
    runInNewContext(source, {
      self: {
        location: { origin: 'https://ecole.test' },
        addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
        clients: { claim: async () => undefined },
      },
      URL,
      caches: {
        keys: async () => ['ecole-data'],
        open: async () => cache,
        delete: async () => true,
      },
    });
    let done: Promise<unknown> = Promise.resolve();
    listeners.get('activate')?.({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect([...stored]).toEqual(['https://ecole.test/api/portal/children']);
  });

  it('garde aussi l’appel du car et les surveillances de « Ma journée », rien d’autre', () => {
    expect(intercepts('/api/transport/my-lines')).toBe(true);
    expect(intercepts('/api/transport/trips')).toBe(true);
    expect(intercepts('/api/exams/my-supervisions')).toBe(true);
    expect(intercepts('/api/transport/lines')).toBe(false);
    expect(intercepts('/api/exams/sessions')).toBe(false);
    expect(intercepts('/api/grades/sheets')).toBe(false);
    expect(intercepts('/api/grades/evaluations')).toBe(false);
  });

  it('page de secours : message juste et retour à l’accueil du rôle', async () => {
    const listeners = new Map<string, Listener>();
    const source = readFileSync(
      fileURLToPath(new URL('../../public/sw.js', import.meta.url)),
      'utf8',
    );
    runInNewContext(source, {
      self: {
        location: { origin: 'https://ecole.test' },
        addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
      },
      URL,
      Response,
      Headers,
      caches: { match: async () => undefined, open: async () => ({ put: async () => undefined }) },
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const page = async (path: string) => {
      let response: Promise<Response> | null = null;
      listeners.get('fetch')?.({
        request: { method: 'GET', url: `https://ecole.test${path}`, mode: 'navigate' },
        respondWith: (r: Promise<Response>) => (response = r),
      });
      if (!response) throw new Error('navigation non interceptée');
      return (await (response as Promise<Response>)).text();
    };
    // Page gardée hors connexion (Notes, Présences) jamais ouverte avec le réseau sur l'appareil.
    expect(await page('/notes')).toContain('pas encore été ouverte sur cet appareil');
    expect(await page('/presences')).toContain('pas encore été ouverte sur cet appareil');
    // Page non prévue hors connexion, sous-page comprise.
    const other = await page('/presences/justificatifs');
    expect(other).toContain('Cette page n’est pas disponible hors connexion');
    expect(other).not.toContain('href="/portail"');
    // Le lien suit le profil gardé sur l'appareil : enseignant, chauffeur ou parent.
    expect(other).toContain("'/enseignant'");
    expect(other).toContain("'/transport/appel'");
    const rollCall = await page('/transport/appel');
    expect(rollCall).toContain('pas encore été ouverte sur cet appareil');
    expect(await page('/portail/notes')).toContain('href="/portail"');
  });

  it('ne met jamais en cache l’authentification ni les fichiers', () => {
    expect(intercepts('/api/auth/me')).toBe(false);
    expect(intercepts('/api/portal/materials/abc/file')).toBe(false);
  });
});

describe('mise en cache des pages par le service worker', () => {
  /** Charge le service worker et renvoie ses fonctions internes. */
  function internals(fetchImpl: (url: string) => Promise<Response>) {
    const context: Record<string, unknown> = {
      self: { location: { origin: 'https://ecole.test' }, addEventListener: () => undefined },
      URL,
      Response,
      Headers,
      caches: {
        match: async () => undefined,
        open: async () => ({ put: async () => undefined, match: async () => undefined }),
      },
      fetch: fetchImpl,
    };
    runInNewContext(
      readFileSync(fileURLToPath(new URL('../../public/sw.js', import.meta.url)), 'utf8'),
      context,
    );
    return context as {
      assetUrls: (html: string) => string[];
      cachePage: (path: string) => Promise<void>;
    };
  }

  it('lit les chemins de Next qui contiennent des parenthèses', () => {
    const { assetUrls } = internals(async () => new Response(''));
    const html =
      '<script src="/_next/static/chunks/app/(staff)/notes/page-1a2b.js" async></script>' +
      '<link rel="stylesheet" href="/_next/static/css/app-9f.css">' +
      'self.__next_f.push([1,"I[\\"/_next/static/chunks/app/(staff)/layout-77.js\\"]"])' +
      '<style>@font-face{src:url(/_next/static/media/font-x.woff2)}</style>' +
      '<script src="/_next/static/chunks/app/(staff)/notes/page-1a2b.js"></script>';
    expect(assetUrls(html)).toEqual([
      '/_next/static/chunks/app/(staff)/notes/page-1a2b.js',
      '/_next/static/css/app-9f.css',
      '/_next/static/chunks/app/(staff)/layout-77.js',
      '/_next/static/media/font-x.woff2',
    ]);
  });

  it('libère toute réponse non gardée (page en erreur, fichier introuvable)', async () => {
    const cancelled: string[] = [];
    const response = (url: string, status: number, body: string) =>
      new Response(
        new ReadableStream({
          start: (c) => {
            c.enqueue(new TextEncoder().encode(body));
            // La page gardée se lit jusqu'au bout ; les autres restent ouvertes tant qu'on ne les libère pas.
            if (status === 200) c.close();
          },
          cancel: () => void cancelled.push(url),
        }),
        { status },
      );
    const { cachePage } = internals(async (url) =>
      url === '/notes'
        ? response(url, 200, '<script src="/_next/static/chunks/absent.js"></script>')
        : url === '/erreur'
          ? response(url, 500, 'erreur')
          : response(url, 404, 'introuvable'),
    );
    await cachePage('/erreur');
    await cachePage('/notes');
    expect(cancelled).toEqual(['/erreur', '/_next/static/chunks/absent.js']);
  });
});
