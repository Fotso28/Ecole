import { AUDIT_ACTION_LABELS } from '@ecole/shared';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Fichiers sources de l'API (hors tests). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('libellés du journal d’audit', () => {
  it('chaque action journalisée par l’API a un libellé en français', () => {
    const codes = new Set<string>();
    for (const file of sources(join(__dirname, '..'))) {
      const text = readFileSync(file, 'utf8');
      // action: 'x.y', ou action: cond ? 'x.y' : 'x.z'
      for (const m of text.matchAll(/action:\s*([^,}]+)/g)) {
        for (const code of m[1]?.matchAll(/'([a-z_]+\.[a-z_]+)'/g) ?? []) codes.add(code[1] ?? '');
      }
    }
    expect(codes.size).toBeGreaterThan(100);
    const missing = [...codes].filter((c) => !AUDIT_ACTION_LABELS[c]).sort();
    expect(missing).toEqual([]);
  });
});
