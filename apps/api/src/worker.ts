import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { env, loadDotEnv } from './config/env';

const QUEUE = 'ecole-jobs';

/** Processus des tâches de fond : file BullMQ sur Redis, une tâche à la fois. */
async function main(): Promise<void> {
  loadDotEnv();
  const config = env();
  const logger = new Logger('Worker');
  const { AppModule } = await import('./app.module');
  const { JOBS, runJob } = await import('./jobs');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(QUEUE, { connection });
  for (const [name, repeat] of Object.entries(JOBS)) {
    await queue.upsertJobScheduler(name, repeat, {
      name,
      opts: { removeOnComplete: 100, removeOnFail: 500 },
    });
  }
  const worker = new Worker(
    QUEUE,
    async (job) => {
      const result = await runJob(app, job.name);
      if (
        !['outbox', 'accounting'].includes(job.name) ||
        (typeof result === 'number' && result > 0)
      )
        logger.log(`${job.name} : ${JSON.stringify(result)}`);
      return result;
    },
    { connection, concurrency: 1 },
  );
  worker.on('failed', (job, err) => logger.error(`Échec de ${job?.name} : ${err.message}`));
  logger.log('Worker démarré');
  const stop = async () => {
    await worker.close();
    await queue.close();
    await connection.quit();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

void main();
