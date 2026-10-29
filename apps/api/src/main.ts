import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { env, loadDotEnv } from './config/env';

async function main(): Promise<void> {
  loadDotEnv();
  const config = env();
  const { AppModule } = await import('./app.module');
  const { configureApp } = await import('./bootstrap');
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app);
  await app.listen(config.PORT);
  new Logger('Ecole').log(`API prête sur le port ${config.PORT}`);
}

void main();
