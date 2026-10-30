import { defineConfig, devices } from '@playwright/test';

const API_PORT = 4100;
const WEB_PORT = 3100;
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgresql://ecole:ecole@localhost:5432/ecole_e2e';

export const apiEnv = {
  NODE_ENV: 'test' as const,
  PORT: String(API_PORT),
  DATABASE_URL: E2E_DATABASE_URL,
  JWT_SECRET: 'e2e-jwt-secret-with-enough-length-0123456789',
  OTP_SECRET: 'e2e-otp-secret-with-enough-length-0123456789',
  DATA_ENCRYPTION_KEY: 'b'.repeat(64),
  SMS_PROVIDER: 'memory',
  EMAIL_PROVIDER: 'memory',
  MOBILE_MONEY_PROVIDER: 'simulator',
  MOBILE_MONEY_WEBHOOK_SECRET: 'e2e-webhook-secret-0123456789',
  QUEUES_ENABLED: 'false',
  WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
  PUBLIC_VERIFY_URL: `http://localhost:${WEB_PORT}/verifier`,
  STORAGE_PROVIDER: 'local',
  STORAGE_LOCAL_DIR: '../api/storage/e2e',
};

export const API_URL = `http://localhost:${API_PORT}`;

/** Parcours complets sur téléphone (Pixel 7) et sur ordinateur, contre une base dédiée. */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    locale: 'fr-FR',
    timezoneId: 'Africa/Douala',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], locale: 'fr-FR' } },
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        locale: 'fr-FR',
      },
    },
  ],
  webServer: [
    {
      command: 'node --enable-source-maps ../api/dist/main.js',
      url: `${API_URL}/health`,
      env: apiEnv,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm exec next build && pnpm exec next start -p ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}/connexion`,
      env: { API_URL, NEXT_PUBLIC_MOBILE_MONEY_SIMULATOR: 'true', NEXT_TELEMETRY_DISABLED: '1' },
      reuseExistingServer: false,
      timeout: 400_000,
    },
  ],
});
