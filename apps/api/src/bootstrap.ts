import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { env } from './config/env';
import { contextMiddleware } from './common/context.middleware';

/** Configuration commune à l'application et aux tests d'intégration. */
export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  express.set('trust proxy', 1);
  express.use(helmet());
  express.use(cookieParser());
  express.use(contextMiddleware);
  express.enableCors({ origin: env().WEB_ORIGIN.split(','), credentials: true });
  express.enableShutdownHooks();
  if (env().NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('Ecole API')
      .setDescription('API de gestion scolaire multi-établissement')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', express, SwaggerModule.createDocument(express, config));
  }
}
