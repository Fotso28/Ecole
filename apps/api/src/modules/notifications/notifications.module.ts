import { Global, Module } from '@nestjs/common';
import { createEmailProvider, EMAIL_PROVIDER } from './email.provider';
import { NotificationsService } from './notifications.service';
import { createSmsProvider, SMS_PROVIDER } from './sms.provider';

@Global()
@Module({
  providers: [
    NotificationsService,
    { provide: SMS_PROVIDER, useFactory: createSmsProvider },
    { provide: EMAIL_PROVIDER, useFactory: createEmailProvider },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
