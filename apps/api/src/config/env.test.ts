import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

const production = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://ecole:secret@db:5432/ecole',
  JWT_SECRET: 'jwt-secret-de-production-suffisamment-long-0123456789',
  OTP_SECRET: 'otp-secret-de-production-suffisamment-long-0123456789',
  DATA_ENCRYPTION_KEY: 'c'.repeat(64),
  MOBILE_MONEY_WEBHOOK_SECRET: 'webhook-secret-de-production-0123456789',
};

describe('configuration de production', () => {
  it('accepte une passerelle SMS réelle', () => {
    expect(loadEnv({ ...production, SMS_PROVIDER: 'http' }).SMS_PROVIDER).toBe('http');
  });

  it('refuse les fournisseurs SMS qui journalisent ou gardent les codes de connexion', () => {
    for (const SMS_PROVIDER of [undefined, 'console', 'memory']) {
      expect(() => loadEnv({ ...production, SMS_PROVIDER })).toThrow(/SMS_PROVIDER=http/);
    }
  });
});
