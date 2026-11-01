import {
  Controller,
  Get,
  Headers,
  Module,
  NotFoundException,
  Param,
  type INestApplicationContext,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { createHash, timingSafeEqual } from 'node:crypto';
import { runAsSystem } from '../../common/context';
import { Public } from '../../common/decorators';
import { env } from '../../config/env';
import { JOBS, runJob } from '../../jobs';

/** Comparaison à temps constant (empreintes de même longueur). */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Tâches de fond déclenchées par les tâches planifiées de l'hébergeur (Vercel Cron), là où aucun
 * worker permanent ne tourne. Route fermée (404) sans CRON_SECRET ou avec un mauvais secret.
 */
@ApiExcludeController()
@Controller('jobs')
export class JobsController {
  constructor(private readonly moduleRef: ModuleRef) {}

  @Public()
  @SkipThrottle()
  @Get(':name')
  async run(@Param('name') name: string, @Headers('authorization') authorization?: string) {
    const secret = env().CRON_SECRET;
    if (!secret || !sameSecret(authorization ?? '', `Bearer ${secret}`))
      throw new NotFoundException();
    // Préproduction seulement : chargement du jeu de démonstration depuis la région de la base
    // (trop lent depuis la construction, qui tourne loin de la base).
    const seed = name === 'seedDemo' && env().DEPLOY_STAGE === 'preprod';
    if (!seed && !Object.hasOwn(JOBS, name)) throw new NotFoundException('Tâche inconnue');
    // Services des autres modules : recherche dans toute l'application.
    const app = {
      get: (token: unknown) => this.moduleRef.get(token as never, { strict: false }),
    } as unknown as INestApplicationContext;
    const started = Date.now();
    const result = seed
      ? await import('../../seed').then(({ seedDemo }) => runAsSystem('seed', () => seedDemo(app)))
      : await runJob(app, name);
    return { job: name, ms: Date.now() - started, result: result ?? null };
  }
}

@Module({ controllers: [JobsController] })
export class JobsModule {}
