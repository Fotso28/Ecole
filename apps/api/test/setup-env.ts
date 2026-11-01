// Variables d'environnement des tests, chargées avant tout module applicatif.
process.env.NODE_ENV = 'test';
/** Rôle applicatif ecole_app : l'API testée subit la Row-Level Security comme en production. */
export const TEST_APP_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://ecole_app:ecole_app@localhost:5432/ecole_test';
/** Rôle propriétaire (superutilisateur en local et en CI) : migrations et jeux de données. */
export const TEST_OWNER_URL =
  process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgresql://ecole:ecole@localhost:5432/ecole_test';
process.env.DATABASE_URL = TEST_APP_URL;
process.env.MIGRATION_DATABASE_URL = TEST_OWNER_URL;
process.env.JWT_SECRET = 'test-jwt-secret-with-enough-length-0123456789';
process.env.OTP_SECRET = 'test-otp-secret-with-enough-length-0123456789';
process.env.DATA_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SMS_PROVIDER = 'memory';
process.env.EMAIL_PROVIDER = 'memory';
process.env.MOBILE_MONEY_PROVIDER = 'simulator';
process.env.MOBILE_MONEY_WEBHOOK_SECRET = 'test-webhook-secret-0123456789';
process.env.QUEUES_ENABLED = 'false';
/** Route des tâches planifiées (Vercel Cron) ouverte aux seuls appels portant ce secret. */
process.env.CRON_SECRET = 'test-cron-secret-0123456789';
process.env.WEB_ORIGIN = 'http://localhost:3000';
process.env.STORAGE_PROVIDER = 'local';
process.env.STORAGE_LOCAL_DIR = `${process.env.TMPDIR ?? '/tmp'}/ecole-test-storage`;
