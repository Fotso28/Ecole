/**
 * Hébergement géré (Vercel + base Neon de la Marketplace) : la base fournit l'adresse de son rôle
 * propriétaire, sous un préfixe choisi à la connexion (NEON_DATABASE_URL…) ou sans préfixe
 * (DATABASE_URL, POSTGRES_URL…). L'API, elle, se connecte avec le rôle applicatif ecole_app, soumis à
 * la Row-Level Security ; seules les migrations utilisent le rôle propriétaire.
 *
 * Quand APP_DB_PASSWORD est défini (mot de passe du rôle ecole_app), on en déduit :
 * - MIGRATION_DATABASE_URL : adresse directe (sans pool) du rôle propriétaire ;
 * - DATABASE_URL : même base, pool de connexions, rôle ecole_app.
 * Sans APP_DB_PASSWORD (Docker, développement, tests), rien ne change.
 */

const APP_ROLE = 'ecole_app';

function firstUrl(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (!value) continue;
    try {
      const url = new URL(value);
      // Une adresse déjà au nom du rôle applicatif n'est pas celle du propriétaire.
      if (decodeURIComponent(url.username) !== APP_ROLE) return value;
    } catch {
      // Valeur illisible : on essaie la suivante.
    }
  }
  return undefined;
}

export function applyPlatformEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const password = env.APP_DB_PASSWORD;
  if (!password) return env;
  const pooled = firstUrl(env, [
    'NEON_DATABASE_URL',
    'NEON_POSTGRES_URL',
    'POSTGRES_URL',
    'DATABASE_URL',
  ]);
  if (!pooled) return env;
  const direct =
    firstUrl(env, [
      'NEON_DATABASE_URL_UNPOOLED',
      'NEON_POSTGRES_URL_NON_POOLING',
      'POSTGRES_URL_NON_POOLING',
      'DATABASE_URL_UNPOOLED',
    ]) ?? pooled;
  env.MIGRATION_DATABASE_URL ??= direct;
  const app = new URL(pooled);
  app.username = APP_ROLE;
  app.password = password;
  // Pool de Neon (PgBouncer, mode transaction) : pas d'instructions préparées côté Prisma.
  if (app.hostname.includes('-pooler')) app.searchParams.set('pgbouncer', 'true');
  if (!app.searchParams.has('sslmode')) app.searchParams.set('sslmode', 'require');
  env.DATABASE_URL = app.toString();
  return env;
}
