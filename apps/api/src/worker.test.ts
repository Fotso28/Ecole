import { afterEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from './config/env';
import { main } from './worker';

describe('worker', () => {
  const redisUrl = process.env.REDIS_URL;
  afterEach(() => {
    delete process.env.QUEUES_ENABLED;
    if (redisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = redisUrl;
    resetEnvCache();
  });

  it('ne démarre ni la file ni Redis quand QUEUES_ENABLED=false', async () => {
    process.env.QUEUES_ENABLED = 'false';
    // Redis injoignable : une tentative de connexion bloquerait ou échouerait.
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    resetEnvCache();
    await expect(main()).resolves.toBe('disabled');
  });
});
