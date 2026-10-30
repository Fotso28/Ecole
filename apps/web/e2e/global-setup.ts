import { execSync } from 'node:child_process';
import path from 'node:path';
import { apiEnv, E2E_DATABASE_URL } from '../playwright.config';

/**
 * Base de bout en bout : migrations, remise à zéro des tables (base dédiée aux tests),
 * puis jeu de démonstration « Collège Démo ».
 */
export default function globalSetup(): void {
  const apiDir = path.resolve(__dirname, '../../api');
  const env = { ...process.env, ...apiEnv, DATABASE_URL: E2E_DATABASE_URL };
  execSync('npx prisma migrate deploy', { cwd: apiDir, env, stdio: 'pipe' });
  const sql = `DO $$ DECLARE t text; BEGIN SELECT string_agg(format('%I', tablename), ', ') INTO t FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'; EXECUTE 'TRUNCATE TABLE ' || t || ' RESTART IDENTITY CASCADE'; END $$;`;
  execSync(`psql "${E2E_DATABASE_URL}" -v ON_ERROR_STOP=1`, {
    input: sql,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  execSync('node dist/seed.js', { cwd: apiDir, env, stdio: 'pipe' });
}
