import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { env } from './config/env';
import { AuthGuard } from './common/auth.guard';
import { CoreModule } from './common/core.module';
import { ErrorsFilter } from './common/errors.filter';
import { PrismaModule } from './common/prisma';
import { AuthModule } from './modules/auth/auth.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PlatformModule } from './modules/platform/platform.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    PrismaModule,
    CoreModule,
    NotificationsModule,
    ThrottlerModule.forRootAsync({
      useFactory: () => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
        skipIf: () => env().NODE_ENV === 'test',
      }),
    }),
    AuthModule,
    PlatformModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorsFilter },
  ],
})
export class AppModule {}
