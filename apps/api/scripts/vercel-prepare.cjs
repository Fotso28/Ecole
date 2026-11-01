/* eslint-disable @typescript-eslint/no-require-imports -- fichier CommonJS exécuté tel quel par Node et par Vercel */
/**
 * Préparation au déploiement Vercel, après la compilation : base Neon (rôles, migrations, droits).
 * Sans base gérée (ni APP_SECRET ni APP_DB_PASSWORD), ne fait que créer le dossier statique attendu
 * par Vercel. Le jeu de démonstration de la préproduction se charge à l'exécution (tâche
 * `/jobs/seedDemo`) : la construction tourne loin de la base et chaque requête y coûte un aller-retour
 * transatlantique.
 */
const { execFileSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
mkdirSync(join(root, 'public'), { recursive: true });

async function main() {
  // Secrets dérivés de APP_SECRET, puis adresses de la base Neon (src/config/platform-env.ts).
  const { applyPlatformEnv } = require('../dist/config/platform-env.js');
  const env = applyPlatformEnv(process.env);
  if (!env.APP_DB_PASSWORD) {
    console.log(
      '[préparation] Pas de base gérée (ni APP_SECRET ni APP_DB_PASSWORD) : rien à faire.',
    );
    return;
  }
  if (!env.MIGRATION_DATABASE_URL)
    throw new Error(
      'Base Neon introuvable : connectez-la au projet (Storage → Neon), puis relancez le déploiement.',
    );
  const { PrismaClient } = require('@prisma/client');
  const owner = new PrismaClient({ datasourceUrl: env.MIGRATION_DATABASE_URL });
  const literal = (s) => `'${String(s).replace(/'/g, "''")}'`;
  try {
    console.log('[préparation] Rôles ecole_app et ecole_system');
    await owner.$executeRawUnsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecole_app') THEN
        CREATE ROLE ecole_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecole_system') THEN
        CREATE ROLE ecole_system WITH NOLOGIN BYPASSRLS;
      END IF;
    END $$`);
    await owner.$executeRawUnsafe(
      `ALTER ROLE ecole_app WITH LOGIN NOBYPASSRLS PASSWORD ${literal(env.APP_DB_PASSWORD)}`,
    );
    await owner.$executeRawUnsafe('GRANT ecole_system TO ecole_app WITH INHERIT FALSE, SET TRUE');
    const [{ db }] = await owner.$queryRawUnsafe('SELECT current_database() AS db');
    await owner.$executeRawUnsafe(`GRANT CONNECT ON DATABASE "${db}" TO ecole_app`);
  } finally {
    await owner.$disconnect();
  }
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env });
  console.log('[préparation] Migrations');
  run('npx', ['prisma', 'migrate', 'deploy']);
  console.log('[préparation] Droits des rôles applicatifs');
  run('npx', [
    'prisma',
    'db',
    'execute',
    '--file',
    'prisma/app-role-grants.sql',
    '--url',
    env.MIGRATION_DATABASE_URL,
  ]);
  if (env.DEPLOY_STAGE === 'preprod')
    console.log(
      '[préparation] Jeu de démonstration : chargé par la tâche planifiée /jobs/seedDemo (Vercel → Settings → Cron Jobs → Run).',
    );
}

main().catch((error) => {
  console.error('[préparation] Échec :', error);
  process.exit(1);
});
