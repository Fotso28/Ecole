// Variables d'environnement des tests, chargées avant tout module applicatif.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://ecole:ecole@localhost:5432/ecole_test';
process.env.JWT_SECRET = 'test-jwt-secret-with-enough-length-0123456789';
process.env.OTP_SECRET = 'test-otp-secret-with-enough-length-0123456789';
process.env.DATA_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SMS_PROVIDER = 'memory';
process.env.MOBILE_MONEY_PROVIDER = 'simulator';
process.env.MOBILE_MONEY_WEBHOOK_SECRET = 'test-webhook-secret-0123456789';
process.env.QUEUES_ENABLED = 'false';
process.env.WEB_ORIGIN = 'http://localhost:3000';
process.env.STORAGE_PROVIDER = 'local';
process.env.STORAGE_LOCAL_DIR = `${process.env.TMPDIR ?? '/tmp'}/ecole-test-storage`;
