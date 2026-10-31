import { describe, expect, it, vi } from 'vitest';
import { once, writeKey } from './api';

describe('writeKey', () => {
  it('ne regroupe jamais les lectures', () => {
    expect(writeKey('/students', {})).toBeNull();
    expect(writeKey('/students', { method: 'GET' })).toBeNull();
  });

  it('identifie une écriture par méthode, chemin et contenu', () => {
    const a = writeKey('/lessons', { method: 'POST', body: { content: 'Fractions' } });
    expect(a).toBe(writeKey('/lessons', { method: 'POST', body: { content: 'Fractions' } }));
    expect(a).not.toBe(writeKey('/lessons', { method: 'POST', body: { content: 'Équations' } }));
    expect(a).not.toBe(writeKey('/lessons', { method: 'PUT', body: { content: 'Fractions' } }));
    expect(writeKey('/lessons/1', { method: 'DELETE' })).toBe('DELETE /lessons/1 ');
  });
});

describe('once', () => {
  it('un double appui n’envoie qu’une demande et les deux appels reçoivent la même réponse', async () => {
    let resolve: (v: number) => void = () => {};
    const run = vi.fn(() => new Promise<number>((r) => (resolve = r)));
    const first = once('POST /lessons {}', run);
    const second = once('POST /lessons {}', run);
    expect(run).toHaveBeenCalledTimes(1);
    resolve(42);
    await expect(first).resolves.toBe(42);
    await expect(second).resolves.toBe(42);
    // Une fois la première terminée, une nouvelle demande part normalement.
    const third = once('POST /lessons {}', run);
    expect(run).toHaveBeenCalledTimes(2);
    resolve(7);
    await expect(third).resolves.toBe(7);
  });

  it('libère la demande après un échec', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('Réseau')));
    await expect(once('POST /payments {}', failing)).rejects.toThrow('Réseau');
    const ok = vi.fn(() => Promise.resolve('ok'));
    await expect(once('POST /payments {}', ok)).resolves.toBe('ok');
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('n’attend jamais sans clé', async () => {
    const run = vi.fn(() => Promise.resolve(1));
    await Promise.all([once(null, run), once(null, run)]);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
