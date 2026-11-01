import { describe, expect, it } from 'vitest';
import { applyPlatformEnv, deriveSecrets } from './platform-env';

const OWNER_POOLED =
  'postgresql://neondb_owner:secret@ep-cool-1-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require';
const OWNER_DIRECT =
  'postgresql://neondb_owner:secret@ep-cool-1.eu-central-1.aws.neon.tech/neondb?sslmode=require';

describe('adresses de la base sur l’hébergement géré', () => {
  it('ne change rien sans mot de passe du rôle applicatif', () => {
    const env = { DATABASE_URL: 'postgresql://ecole_app:x@localhost:5432/ecole' };
    expect(applyPlatformEnv({ ...env })).toEqual(env);
  });

  it('se connecte avec ecole_app sur le pool, migre avec le propriétaire en direct', () => {
    const env = applyPlatformEnv({
      APP_DB_PASSWORD: 'p@ss/w0rd',
      NEON_DATABASE_URL: OWNER_POOLED,
      NEON_DATABASE_URL_UNPOOLED: OWNER_DIRECT,
    });
    expect(env.MIGRATION_DATABASE_URL).toBe(OWNER_DIRECT);
    const app = new URL(env.DATABASE_URL ?? '');
    expect(app.username).toBe('ecole_app');
    expect(decodeURIComponent(app.password)).toBe('p@ss/w0rd');
    expect(app.hostname).toBe('ep-cool-1-pooler.eu-central-1.aws.neon.tech');
    expect(app.searchParams.get('pgbouncer')).toBe('true');
    expect(app.searchParams.get('sslmode')).toBe('require');
  });

  it('accepte la base connectée sans préfixe (DATABASE_URL du propriétaire)', () => {
    const env = applyPlatformEnv({
      APP_DB_PASSWORD: 'pw',
      DATABASE_URL: OWNER_POOLED,
      DATABASE_URL_UNPOOLED: OWNER_DIRECT,
    });
    expect(env.MIGRATION_DATABASE_URL).toBe(OWNER_DIRECT);
    expect(new URL(env.DATABASE_URL ?? '').username).toBe('ecole_app');
    // Rejouée (plusieurs appels au démarrage), la déduction reste la même.
    const again = applyPlatformEnv({ ...env });
    expect(again.DATABASE_URL).toBe(env.DATABASE_URL);
    expect(again.MIGRATION_DATABASE_URL).toBe(OWNER_DIRECT);
  });

  it('garde une adresse de migration déjà fournie', () => {
    const env = applyPlatformEnv({
      APP_DB_PASSWORD: 'pw',
      NEON_DATABASE_URL: OWNER_POOLED,
      MIGRATION_DATABASE_URL: 'postgresql://autre@h/db',
    });
    expect(env.MIGRATION_DATABASE_URL).toBe('postgresql://autre@h/db');
  });

  it('dérive les secrets d’un seul secret maître, de façon stable et distincte', () => {
    const master = 'm'.repeat(40);
    const a = deriveSecrets({ APP_SECRET: master });
    const b = deriveSecrets({ APP_SECRET: master });
    expect(a.JWT_SECRET).toBe(b.JWT_SECRET);
    expect(a.DATA_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(a.APP_DB_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
    const values = [a.JWT_SECRET, a.OTP_SECRET, a.DATA_ENCRYPTION_KEY, a.APP_DB_PASSWORD];
    expect(new Set(values).size).toBe(values.length);
    expect(deriveSecrets({ APP_SECRET: 'n'.repeat(40) }).JWT_SECRET).not.toBe(a.JWT_SECRET);
    // Un secret déjà fourni n'est pas remplacé.
    expect(deriveSecrets({ APP_SECRET: master, JWT_SECRET: 'fourni' }).JWT_SECRET).toBe('fourni');
    expect(() => deriveSecrets({ APP_SECRET: 'court' })).toThrow(/32 caractères/);
    expect(deriveSecrets({})).toEqual({});
  });

  it('avec le secret maître, la base Neon suffit : rôle applicatif déduit', () => {
    const env = applyPlatformEnv({ APP_SECRET: 's'.repeat(40), NEON_DATABASE_URL: OWNER_POOLED });
    const app = new URL(env.DATABASE_URL ?? '');
    expect(app.username).toBe('ecole_app');
    expect(decodeURIComponent(app.password)).toBe(env.APP_DB_PASSWORD);
  });
});
