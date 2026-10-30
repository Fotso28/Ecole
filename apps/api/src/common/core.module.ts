import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { env } from '../config/env';
import { AccessService } from './access.service';
import { AuditService } from './audit.service';
import { CountersService } from './counters.service';
import { ScopeService } from './scope.service';

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
  providers: [AccessService, AuditService, CountersService, ScopeService],
  exports: [AccessService, AuditService, CountersService, ScopeService],
})
export class CoreModule {}
