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
  runInNewContext(source, { self, URL, Response, Headers, caches: {}, fetch: () => undefined });
  const onFetch = listeners.get('fetch');
  if (!onFetch) throw new Error('Gestionnaire fetch absent');
  return (url, mode = 'cors') => {
    let handled = false;
    onFetch({
      request: { method: 'GET', url: `https://ecole.test${url}`, mode },
      respondWith: () => {
        handled = true;
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

  it('ne met jamais en cache l’authentification ni les fichiers', () => {
    expect(intercepts('/api/auth/me')).toBe(false);
    expect(intercepts('/api/portal/materials/abc/file')).toBe(false);
  });
});
