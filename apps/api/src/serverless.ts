import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { env, loadDotEnv } from './config/env';
// Embarque les polices standard de pdfkit dans la fonction (voir common/pdf-fonts.ts).
import './common/pdf-fonts';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Point d'entrée des fonctions serverless (Vercel) : l'application Nest est démarrée une seule fois
 * par instance, puis chaque requête est confiée à Express. Mêmes réglages que `main.ts`.
 */
let ready: Promise<Handler> | undefined;

async function start(): Promise<Handler> {
  loadDotEnv();
  const config = env();
  const { AppModule } = await import('./app.module');
  const { configureApp } = await import('./bootstrap');
  const { appLogger } = await import('./common/logger');
  const logger = appLogger({
    format: config.LOG_FORMAT ?? 'json',
    level: config.LOG_LEVEL,
    service: 'api',
  });
  const app = await NestFactory.create(AppModule, { rawBody: true, logger });
  configureApp(app);
  await app.init();
  return app.getHttpAdapter().getInstance() as Handler;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ready ??= start().catch((error: unknown) => {
    // Échec au démarrage (configuration, base) : la prochaine requête retentera.
    ready = undefined;
    throw error;
  });
  const app = await ready;
  app(req, res);
}
