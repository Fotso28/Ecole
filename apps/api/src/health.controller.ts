import { Controller, Get } from '@nestjs/common';
import { Public } from './common/decorators';
import { Db, InjectDb } from './common/prisma';

@Controller('health')
export class HealthController {
  constructor(@InjectDb() private readonly db: Db) {}

  @Public()
  @Get()
  async check() {
    await this.db.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  }
}
