import { describe, expect, it } from 'vitest';
import { runWithContext } from './context';
import { AppLogger, redact, redactValue } from './logger';

function capture(level: 'log' | 'warn' = 'log') {
  const lines: string[] = [];
  const logger = new AppLogger({
    format: 'json',
    level,
    service: 'api',
    write: (l) => lines.push(l),
  });
  return { logger, lines, json: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('redact', () => {
  it('masque téléphones, e-mails et jetons', () => {
    expect(redact('SMS → +237677123456 : bonjour')).toBe('SMS → [téléphone] : bonjour');
    expect(redact('parent 677123456 et 699 88 77 66')).toBe('parent [téléphone] et [téléphone]');
    expect(redact('écrire à awa.mbarga@example.cm')).toBe('écrire à [e-mail]');
    expect(redact('Authorization: Bearer abc.def-ghi')).toBe('Authorization: Bearer [masqué]');
    expect(redact('jeton eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl')).toBe('jeton [jeton]');
  });

  it('laisse intacts les dates, montants et identifiants', () => {
    const text = 'Paiement cmvuupopu00jy7d8wrfwma14b de 35000 FCFA le 2026-10-30 (R-2026-000001)';
    expect(redact(text)).toBe(text);
  });

  it('retire les champs sensibles des objets', () => {
    expect(
      redactValue({ phone: '677123456', password: 'x', nested: { token: 't', amount: 5000 } }),
    ).toEqual({
      phone: '[masqué]',
      password: '[masqué]',
      nested: { token: '[masqué]', amount: 5000 },
    });
  });
});

describe('AppLogger', () => {
  it('écrit une ligne JSON avec le contexte de requête et d’école, sans utilisateur', () => {
    const { logger, json } = capture();
    runWithContext(
      {
        kind: 'staff',
        userId: 'user-1',
        schoolId: 'school-1',
        roles: [],
        permissions: new Set(),
        isPlatformAdmin: false,
        breakGlass: false,
      },
      () => logger.log('Relance envoyée au 677123456', 'Finance'),
      'req-12345678',
    );
    const [line] = json();
    expect(line).toMatchObject({
      level: 'info',
      service: 'api',
      context: 'Finance',
      msg: 'Relance envoyée au [téléphone]',
      requestId: 'req-12345678',
      schoolId: 'school-1',
    });
    expect(JSON.stringify(line)).not.toContain('user-1');
    expect(typeof line!.time).toBe('string');
  });

  it('journalise les erreurs avec leur pile et respecte le niveau minimal', () => {
    const { logger, json } = capture('warn');
    logger.log('ignoré');
    logger.error('Échec', 'Error: boom\n    at f (x.ts:1:1)', 'Errors');
    logger.error(new Error('Erreur pour a@b.cm'));
    const lines = json();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: 'error', context: 'Errors', msg: 'Échec' });
    expect(lines[0]!.stack).toContain('at f');
    expect(lines[1]).toMatchObject({ msg: 'Erreur pour [e-mail]' });
  });

  it('format texte lisible en développement', () => {
    const lines: string[] = [];
    new AppLogger({ format: 'text', write: (l) => lines.push(l) }).warn('Attention', 'Test');
    expect(lines[0]).toMatch(/^\S+ WARN \[Test\] Attention$/);
  });
});
