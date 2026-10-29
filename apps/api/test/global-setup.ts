import { execSync } from 'node:child_process';

/** Applique les migrations en attente sur la base de test (opération non destructive). */
export default function setup(): void {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://ecole:ecole@localhost:5432/ecole_test';
  execSync('npx prisma migrate deploy', {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
