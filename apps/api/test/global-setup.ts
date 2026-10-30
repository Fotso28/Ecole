import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { TEST_APP_URL, TEST_OWNER_URL } from './setup-env';

/**
 * Prépare la base de test (opérations non destructives) : rôles ecole_app (soumis à la
 * Row-Level Security) et ecole_system (mode système), migrations avec le rôle propriétaire, puis
 * droits des rôles.
 */
export default async function setup(): Promise<void> {
  const owner = new PrismaClient({ datasourceUrl: TEST_OWNER_URL });
  const password = new URL(TEST_APP_URL).password || 'ecole_app';
  try {
    await owner.$executeRawUnsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecole_app') THEN
        CREATE ROLE ecole_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password.replace(/'/g, "''")}';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecole_system') THEN
        CREATE ROLE ecole_system WITH NOLOGIN BYPASSRLS;
      END IF;
    END $$`);
  } finally {
    await owner.$disconnect();
  }
  const env = {
    ...process.env,
    DATABASE_URL: TEST_APP_URL,
    MIGRATION_DATABASE_URL: TEST_OWNER_URL,
  };
  execSync('npx prisma migrate deploy', { cwd: process.cwd(), env, stdio: 'pipe' });
  execSync(`npx prisma db execute --url "${TEST_OWNER_URL}" --file prisma/app-role-grants.sql`, {
    cwd: process.cwd(),
    env,
    stdio: 'pipe',
  });
}
