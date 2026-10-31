import {
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiTags } from '@nestjs/swagger';
import {
  schoolCreateSchema,
  subscriptionAssignSchema,
  subscriptionInvoiceIssueSchema,
  subscriptionPaymentSchema,
  subscriptionPlanSchema,
  subscriptionReasonSchema,
} from '@ecole/shared';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import type { AccessTokenPayload } from '../../common/auth.guard';
import { currentActorId } from '../../common/context';
import { PlatformAdminRoute, RequirePermissions } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma';
import { ZodPipe } from '../../common/zod.pipe';
import { AuthService } from '../auth/auth.service';
import { BillingService } from './billing.service';

const breakGlassSchema = z.object({
  reason: z.string().trim().min(10, 'Motif de 10 caractères minimum').max(300),
});

@Injectable()
export class PlatformService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly jwt: JwtService,
  ) {}

  async createSchool(input: z.infer<typeof schoolCreateSchema>) {
    const passwordHash = await AuthService.hashPassword(input.director.password);
    if (await this.db.school.findUnique({ where: { slug: input.slug }, select: { id: true } }))
      throw new ConflictException('Cet identifiant est déjà utilisé par un autre établissement');
    return this.db.$transaction(async (tx) => {
      const school = await tx.school.create({
        data: {
          name: input.name,
          slug: input.slug,
          city: input.city,
          matriculePrefix: input.matriculePrefix,
        },
      });
      const existing = await tx.user.findUnique({ where: { email: input.director.email } });
      const user =
        existing ??
        (await tx.user.create({
          data: {
            email: input.director.email,
            firstName: input.director.firstName,
            lastName: input.director.lastName,
            passwordHash,
          },
        }));
      await tx.membership.create({
        data: { userId: user.id, schoolId: school.id, roles: ['DIRECTOR'] },
      });
      await this.audit.log(
        {
          action: 'platform.school_created',
          entity: 'School',
          entityId: school.id,
          schoolId: school.id,
          after: { name: school.name },
        },
        tx,
      );
      // Compte existant : rattaché comme direction, son mot de passe reste inchangé.
      return { school, directorId: user.id, existingUser: !!existing };
    });
  }

  listSchools() {
    return this.db.school.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        city: true,
        status: true,
        modules: true,
        createdAt: true,
      },
    });
  }

  /** Accès exceptionnel en lecture seule, motivé et journalisé. */
  async breakGlass(schoolId: string, reason: string) {
    const school = await this.db.school.findUniqueOrThrow({ where: { id: schoolId } });
    const actorId = currentActorId();
    if (!actorId) throw new Error('Acteur inconnu');
    await this.audit.log({
      action: 'platform.break_glass',
      entity: 'School',
      entityId: school.id,
      schoolId: school.id,
      reason,
    });
    const payload: AccessTokenPayload = { sub: actorId, typ: 'staff', sch: school.id, bg: true };
    return { accessToken: await this.jwt.signAsync(payload, { expiresIn: 1800 }), expiresIn: 1800 };
  }
}

@ApiTags('platform')
@Controller('platform')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @PlatformAdminRoute()
  @Post('schools')
  create(@Body(new ZodPipe(schoolCreateSchema)) body: z.infer<typeof schoolCreateSchema>) {
    return this.platform.createSchool(body);
  }

  @PlatformAdminRoute()
  @Get('schools')
  list() {
    return this.platform.listSchools();
  }

  @PlatformAdminRoute()
  @Post('schools/:id/access')
  access(
    @Param('id') id: string,
    @Body(new ZodPipe(breakGlassSchema)) body: z.infer<typeof breakGlassSchema>,
  ) {
    return this.platform.breakGlass(id, body.reason);
  }
}

/** Facturation des abonnements : réservée au super-administrateur, chiffres agrégés seulement. */
@ApiTags('platform')
@Controller('platform/billing')
export class PlatformBillingController {
  constructor(private readonly billing: BillingService) {}

  @PlatformAdminRoute()
  @Get('plans')
  plans() {
    return this.billing.listPlans();
  }

  @PlatformAdminRoute()
  @Post('plans')
  createPlan(
    @Body(new ZodPipe(subscriptionPlanSchema)) body: z.infer<typeof subscriptionPlanSchema>,
  ) {
    return this.billing.createPlan(body);
  }

  @PlatformAdminRoute()
  @Post('plans/:id/archive')
  archivePlan(@Param('id') id: string) {
    return this.billing.archivePlan(id);
  }

  @PlatformAdminRoute()
  @Get('schools')
  overview() {
    return this.billing.overview();
  }

  @PlatformAdminRoute()
  @Get('schools/:id')
  school(@Param('id') id: string) {
    return this.billing.schoolDetail(id);
  }

  @PlatformAdminRoute()
  @Put('schools/:id/subscription')
  assign(
    @Param('id') id: string,
    @Body(new ZodPipe(subscriptionAssignSchema)) body: z.infer<typeof subscriptionAssignSchema>,
  ) {
    return this.billing.assignPlan(id, body.planId);
  }

  @PlatformAdminRoute()
  @Post('schools/:id/invoices')
  issue(
    @Param('id') id: string,
    @Body(new ZodPipe(subscriptionInvoiceIssueSchema))
    body: z.infer<typeof subscriptionInvoiceIssueSchema>,
  ) {
    return this.billing.issueInvoice(id, body);
  }

  @PlatformAdminRoute()
  @Post('invoices/:id/payments')
  pay(
    @Param('id') id: string,
    @Body(new ZodPipe(subscriptionPaymentSchema)) body: z.infer<typeof subscriptionPaymentSchema>,
  ) {
    return this.billing.recordPayment(id, body);
  }

  @PlatformAdminRoute()
  @Post('payments/:id/correct')
  correct(
    @Param('id') id: string,
    @Body(new ZodPipe(subscriptionReasonSchema)) body: z.infer<typeof subscriptionReasonSchema>,
  ) {
    return this.billing.correctPayment(id, body.reason);
  }

  @PlatformAdminRoute()
  @Post('invoices/:id/cancel')
  cancel(
    @Param('id') id: string,
    @Body(new ZodPipe(subscriptionReasonSchema)) body: z.infer<typeof subscriptionReasonSchema>,
  ) {
    return this.billing.cancelInvoice(id, body.reason);
  }

  @PlatformAdminRoute()
  @Post('invoices/:id/reminders')
  remind(@Param('id') id: string) {
    return this.billing.remind(id);
  }
}

/** Abonnement vu par la direction de l'établissement (Paramètres). */
@ApiTags('settings')
@Controller('subscription')
export class SubscriptionController {
  constructor(private readonly billing: BillingService) {}

  @RequirePermissions('subscription.read')
  @Get()
  mine() {
    return this.billing.forCurrentSchool();
  }
}

@Module({
  controllers: [PlatformController, PlatformBillingController, SubscriptionController],
  providers: [PlatformService, BillingService],
})
export class PlatformModule {}
