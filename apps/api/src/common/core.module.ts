import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { env } from '../config/env';
import { AuditService } from './audit.service';
import { CountersService } from './counters.service';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      useFactory: () => ({
        secret: env().JWT_SECRET,
        signOptions: { issuer: 'ecole', algorithm: 'HS256' },
        verifyOptions: { issuer: 'ecole', algorithms: ['HS256'] },
      }),
    }),
  ],
  providers: [AuditService, CountersService],
  exports: [AuditService, CountersService],
})
export class CoreModule {}
