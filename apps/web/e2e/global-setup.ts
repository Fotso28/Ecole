import { execSync } from 'node:child_process';
import path from 'node:path';
import { apiEnv, E2E_APP_DATABASE_URL, E2E_DATABASE_URL } from '../playwright.config';

/**
 * Base de bout en bout : rôle applicatif ecole_app, migrations (rôle propriétaire), remise à zéro
 * des tables (base dédiée aux tests), puis jeu de démonstration « Collège Démo », écrit par le rôle
 * applicatif comme en production.
 */
export default function globalSetup(): void {
  const apiDir = path.resolve(__dirname, '../../api');
  const env = { ...process.env, ...apiEnv };
  const password = (new URL(E2E_APP_DATABASE_URL).password || 'ecole_app').replace(/'/g, "''");
  execSync(`psql "${E2E_DATABASE_URL}" -v ON_ERROR_STOP=1`, {
    input: `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecole_app') THEN CREATE ROLE ecole_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'; END IF; END $$;`,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  execSync('npx prisma migrate deploy', { cwd: apiDir, env, stdio: 'pipe' });
  execSync(`psql "${E2E_DATABASE_URL}" -v ON_ERROR_STOP=1 -f prisma/app-role-grants.sql`, {
    cwd: apiDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sql = `DO $$ DECLARE t text; BEGIN SELECT string_agg(format('%I', tablename), ', ') INTO t FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'; EXECUTE 'TRUNCATE TABLE ' || t || ' RESTART IDENTITY CASCADE'; END $$;`;
  execSync(`psql "${E2E_DATABASE_URL}" -v ON_ERROR_STOP=1`, {
    input: sql,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  execSync('node dist/seed.js', { cwd: apiDir, env, stdio: 'pipe' });
}
