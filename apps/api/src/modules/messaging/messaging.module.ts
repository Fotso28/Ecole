import { Body, Controller, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  guardianContactSchema,
  messageSendSchema,
  parentThreadCreateSchema,
  staffThreadCreateSchema,
  threadConsultSchema,
} from '@ecole/shared';
import { z } from 'zod';
import { ParentRoute, RequireModule, RequirePermissions } from '../../common/decorators';
import { ZodPipe } from '../../common/zod.pipe';
import { MessagingService } from './messaging.service';
import { ParentLinkService } from './parent-link';

const studentQuery = z.object({ studentId: z.string().min(1) });

@ApiTags('messaging')
@ApiBearerAuth()
@RequireModule('communication')
@Controller('messages')
export class StaffMessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @RequirePermissions('messaging.use')
  @Get('threads')
  threads() {
    return this.messaging.staffThreads();
  }

  @RequirePermissions('messaging.use')
  @Get('unread')
  unread() {
    return this.messaging.staffUnread();
  }

  @RequirePermissions('messaging.use')
  @Get('contacts')
  contacts(@Query(new ZodPipe(studentQuery)) q: z.infer<typeof studentQuery>) {
    return this.messaging.guardiansFor(q.studentId);
  }

  @RequirePermissions('messaging.use')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('threads')
  start(@Body(new ZodPipe(staffThreadCreateSchema)) body: z.infer<typeof staffThreadCreateSchema>) {
    return this.messaging.staffStart(body);
  }

  @RequirePermissions('messaging.oversee')
  @Get('oversight')
  oversight() {
    return this.messaging.oversight();
  }

  @RequirePermissions('messaging.use')
  @Get('threads/:id')
  thread(@Param('id') id: string) {
    return this.messaging.staffThread(id);
  }

  @RequirePermissions('messaging.use')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('threads/:id/messages')
  reply(
    @Param('id') id: string,
    @Body(new ZodPipe(messageSendSchema)) body: z.infer<typeof messageSendSchema>,
  ) {
    return this.messaging.staffReply(id, body.body);
  }

  @RequirePermissions('messaging.oversee')
  @Post('threads/:id/consult')
  consult(
    @Param('id') id: string,
    @Body(new ZodPipe(threadConsultSchema)) body: z.infer<typeof threadConsultSchema>,
  ) {
    return this.messaging.consult(id, body.reason);
  }
}

@ApiTags('portal')
@ApiBearerAuth()
@Controller('portal')
export class ParentMessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @ParentRoute()
  @Get('messages/threads')
  threads() {
    return this.messaging.parentThreads();
  }

  @ParentRoute()
  @Get('contact')
  contact() {
    return this.messaging.parentContact();
  }

  @ParentRoute()
  @Patch('contact')
  setContact(
    @Body(new ZodPipe(guardianContactSchema)) body: z.infer<typeof guardianContactSchema>,
  ) {
    return this.messaging.setParentEmail(body.email);
  }

  @ParentRoute()
  @Get('messages/unread')
  unread() {
    return this.messaging.parentUnread();
  }

  @ParentRoute()
  @Get('children/:id/contacts')
  contacts(@Param('id') id: string) {
    return this.messaging.contactsFor(id);
  }

  @ParentRoute()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('messages/threads')
  start(
    @Body(new ZodPipe(parentThreadCreateSchema)) body: z.infer<typeof parentThreadCreateSchema>,
  ) {
    return this.messaging.parentStart(body);
  }

  @ParentRoute()
  @Get('messages/threads/:id')
  thread(@Param('id') id: string) {
    return this.messaging.parentThread(id);
  }

  @ParentRoute()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('messages/threads/:id/messages')
  reply(
    @Param('id') id: string,
    @Body(new ZodPipe(messageSendSchema)) body: z.infer<typeof messageSendSchema>,
  ) {
    return this.messaging.parentReply(id, body.body);
  }
}

@Module({
  controllers: [StaffMessagingController, ParentMessagingController],
  providers: [MessagingService, ParentLinkService],
  exports: [ParentLinkService],
})
export class MessagingModule {}
