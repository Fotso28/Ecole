import { Controller, Get, Module, NotFoundException, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { normalizeCameroonPhone } from '@ecole/shared';
import { env } from '../../config/env';
import { Public } from '../../common/decorators';
import { MemorySmsProvider } from '../notifications/sms.provider';

/**
 * Outils de développement et de tests de bout en bout : lecture du dernier SMS
 * envoyé par le fournisseur en mémoire. Inexistant en production.
 */
@ApiExcludeController()
@Controller('dev')
export class DevController {
  @Public()
  @Get('sms/last')
  last(@Query('to') to: string) {
    if (env().NODE_ENV === 'production' || env().SMS_PROVIDER !== 'memory')
      throw new NotFoundException();
    const phone = normalizeCameroonPhone(to);
    const body = phone ? MemorySmsProvider.lastTo(phone) : undefined;
    if (!body) throw new NotFoundException('Aucun SMS');
    return { to: phone, body };
  }
}

@Module({ controllers: [DevController] })
export class DevModule {}
