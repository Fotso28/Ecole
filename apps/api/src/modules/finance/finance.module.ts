import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Logger,
  Module,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  cashCloseSchema,
  feeItemCreateSchema,
  invoiceGenerateSchema,
  isoDate,
  paymentCreateSchema,
  paymentReverseSchema,
  PAYMENT_METHODS,
} from '@ecole/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { safeEqual } from '../../common/crypto';
import { Public, RequireModule, RequirePermissions } from '../../common/decorators';
import { ScopeService } from '../../common/scope.service';
import { ZodPipe } from '../../common/zod.pipe';
import { PdfModule } from '../pdf/pdf.module';
import { PdfService } from '../pdf/pdf.service';
import { FinanceService } from './finance.service';
import { RateLimit } from '../../common/rate-limit';
import { createMobileMoneyProvider } from './mobile-money.factory';
import {
  MOBILE_MONEY_PROVIDER,
  type MobileMoneyProvider,
  OperatorsMobileMoneyProvider,
  signWebhook,
  SimulatorMobileMoneyProvider,
} from './mobile-money.provider';

const discountSchema = z.object({
  amount: z.number().int().positive(),
  reason: z.string().trim().min(2).max(120),
});
const journalSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  status: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED']).optional(),
  /** Pagination par curseur : identifiant du dernier paiement de la page précédente. */
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const unpaidSchema = z.object({
  classId: z.string().min(1).optional(),
  academicYearId: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const exportSchema = z.object({ from: isoDate, to: isoDate });
const webhookSchema = z
  .object({
    /** Référence de l'opérateur ; à défaut, notre identifiant de paiement (externalId). */
    reference: z.string().min(1).optional(),
    externalId: z.string().min(1).optional(),
    operator: z.enum(['MTN_MOMO', 'ORANGE_MONEY']).optional(),
    status: z.enum(['SUCCESS', 'FAILED', 'PENDING']),
    amount: z.number().int().positive().optional(),
  })
  .refine((b) => b.reference || b.externalId, { message: 'reference ou externalId requis' })
  .refine((b) => b.status !== 'SUCCESS' || b.amount !== undefined, {
    message: 'Le montant est obligatoire pour confirmer un paiement',
  });

@ApiTags('finance')
@ApiBearerAuth()
@RequireModule('finance')
@Controller('finance')
export class FinanceController {
  constructor(
    private readonly finance: FinanceService,
    private readonly scope: ScopeService,
    private readonly pdf: PdfService,
  ) {}

  @RequirePermissions('finance.read')
  @Get('fee-items')
  async feeItems(@Query('academicYearId') academicYearId?: string) {
    const yearId = academicYearId ?? (await this.scope.currentYear()).id;
    return this.finance.listFeeItems(yearId);
  }

  @RequirePermissions('finance.fees.write')
  @Post('fee-items')
  createFeeItem(@Body(new ZodPipe(feeItemCreateSchema)) body: z.infer<typeof feeItemCreateSchema>) {
    return this.finance.createFeeItem(body);
  }

  @RequirePermissions('finance.fees.write')
  @Delete('fee-items/:id')
  deleteFeeItem(@Param('id') id: string) {
    return this.finance.deleteFeeItem(id);
  }

  @RequirePermissions('finance.fees.write')
  @Post('invoices')
  generateInvoice(
    @Body(new ZodPipe(invoiceGenerateSchema)) body: z.infer<typeof invoiceGenerateSchema>,
  ) {
    return this.finance.generateInvoice(body.studentId, body.academicYearId, body.discounts);
  }

  @RequirePermissions('finance.fees.write')
  @Post('invoice-lines/:id/discounts')
  discount(
    @Param('id') id: string,
    @Body(new ZodPipe(discountSchema)) body: z.infer<typeof discountSchema>,
  ) {
    return this.finance.addDiscount(id, body.amount, body.reason);
  }

  @RequirePermissions('finance.read')
  @Get('students/:id/account')
  account(@Param('id') id: string) {
    return this.finance.account(id);
  }

  @RequirePermissions('finance.payments.create')
  @RateLimit('cashier-payment')
  @Post('payments')
  createPayment(@Body(new ZodPipe(paymentCreateSchema)) body: z.infer<typeof paymentCreateSchema>) {
    return this.finance.createPayment(body);
  }

  @RequirePermissions('finance.read')
  @Get('payments')
  journal(@Query(new ZodPipe(journalSchema)) q: z.infer<typeof journalSchema>) {
    return this.finance.journalPage(q);
  }

  @RequirePermissions('finance.read')
  @Get('payments/export.csv')
  async export(
    @Query(new ZodPipe(exportSchema)) q: z.infer<typeof exportSchema>,
    @Res() res: Response,
  ) {
    const csv = await this.finance.exportCsv(q.from, q.to);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="paiements-${q.from}-${q.to}.csv"`);
    res.send(String.fromCharCode(0xfeff) + csv);
  }

  @RequirePermissions('finance.read')
  @Get('payments/:id')
  payment(@Param('id') id: string) {
    return this.finance.getPayment(id);
  }

  @RequirePermissions('finance.read')
  @Get('payments/:id/receipt.pdf')
  async receipt(@Param('id') id: string, @Res() res: Response) {
    const buffer = await this.pdf.receipt(id);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `inline; filename="recu-${id}.pdf"`);
    res.send(buffer);
  }

  @RequirePermissions('finance.payments.reverse')
  @RateLimit('cashier-payment')
  @Post('payments/:id/reverse')
  reverse(
    @Param('id') id: string,
    @Body(new ZodPipe(paymentReverseSchema)) body: z.infer<typeof paymentReverseSchema>,
  ) {
    return this.finance.reversePayment(id, body.reason);
  }

  @RequirePermissions('finance.payments.create')
  @Post('cash-sessions/open')
  openCash() {
    return this.finance.openCashSession();
  }

  @RequirePermissions('finance.payments.create')
  @Get('cash-sessions/current')
  currentCash() {
    return this.finance.currentCashSession();
  }

  @RequirePermissions('finance.read')
  @Get('cash-sessions')
  cashSessions(@Query('status') status?: 'OPEN' | 'CLOSED' | 'APPROVED') {
    return this.finance.listCashSessions(status);
  }

  @RequirePermissions('finance.cash.close')
  @Post('cash-sessions/:id/close')
  closeCash(
    @Param('id') id: string,
    @Body(new ZodPipe(cashCloseSchema)) body: z.infer<typeof cashCloseSchema>,
  ) {
    return this.finance.closeCashSession(id, body.countedAmount, body.note);
  }

  @RequirePermissions('finance.cash.approve')
  @Post('cash-sessions/:id/approve')
  approveCash(@Param('id') id: string) {
    return this.finance.approveCashSession(id);
  }

  @RequirePermissions('finance.read')
  @Get('summary')
  async summary(@Query('academicYearId') academicYearId?: string) {
    return this.finance.summary(academicYearId ?? (await this.scope.currentYear()).id);
  }

  @RequirePermissions('finance.read')
  @Get('unpaid')
  async unpaid(@Query(new ZodPipe(unpaidSchema)) q: z.infer<typeof unpaidSchema>) {
    return this.finance.unpaid(q.academicYearId ?? (await this.scope.currentYear()).id, q.classId, {
      page: q.page,
      pageSize: q.pageSize,
    });
  }
}

function assertAllowedOrigin(req: Request): void {
  const allowed = env()
    .MOBILE_MONEY_ALLOWED_IPS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(req.ip ?? ''))
    throw new ForbiddenException('Origine non autorisée');
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= 100 ? v : undefined;

/**
 * Confirmations des opérateurs Mobile Money. Passerelle générique : signature HMAC obligatoire.
 * MTN MoMo et Orange Money : rappels non signés, qui ne font que déclencher une vérification du
 * statut auprès de l'opérateur. Liste d'IP optionnelle et limite de débit par adresse.
 */
@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly finance: FinanceService,
    @Inject(MOBILE_MONEY_PROVIDER) private readonly provider: MobileMoneyProvider,
  ) {}

  @Public()
  @RateLimit('operator-callback')
  @Post('mobile-money')
  @HttpCode(200)
  async mobileMoney(@Req() req: Request & { rawBody?: Buffer }, @Body() raw: unknown) {
    assertAllowedOrigin(req);
    const signature = req.headers['x-ecole-signature'];
    if (
      typeof signature !== 'string' ||
      !req.rawBody ||
      !safeEqual(signature, signWebhook(req.rawBody))
    ) {
      throw new UnauthorizedException('Signature invalide');
    }
    // Le contenu n'est validé qu'une fois l'émetteur authentifié.
    const body = new ZodPipe(webhookSchema).transform(raw);
    return this.finance.confirmMobileMoney(
      { reference: body.reference, externalId: body.externalId, operator: body.operator },
      body.status,
      body.amount,
    );
  }

  /** Rappel MTN MoMo (X-Callback-Url) : corps { externalId, status, … }, sans signature. */
  @Public()
  @RateLimit('operator-callback')
  @Put('mtn-momo')
  @HttpCode(200)
  mtnMomoPut(@Req() req: Request, @Body() raw: unknown) {
    return this.mtnMomo(req, raw);
  }

  @Public()
  @RateLimit('operator-callback')
  @Post('mtn-momo')
  @HttpCode(200)
  async mtnMomo(@Req() req: Request, @Body() raw: unknown) {
    assertAllowedOrigin(req);
    if (!(this.provider instanceof OperatorsMobileMoneyProvider)) throw new NotFoundException();
    const body = (raw ?? {}) as Record<string, unknown>;
    await this.verify('MTN_MOMO', {
      externalId: str(body.externalId),
      reference: str(body.referenceId) ?? str(req.headers['x-reference-id']),
      claimedStatus: str(body.status),
    });
    return { received: true };
  }

  /** Notification Orange Money (notifUrl) : corps { payToken, status, … }, sans signature. */
  @Public()
  @RateLimit('operator-callback')
  @Post('orange-money')
  @HttpCode(200)
  async orangeMoney(@Req() req: Request, @Body() raw: unknown) {
    assertAllowedOrigin(req);
    if (!(this.provider instanceof OperatorsMobileMoneyProvider)) throw new NotFoundException();
    const body = (raw ?? {}) as Record<string, unknown>;
    const data = (body.data ?? {}) as Record<string, unknown>;
    await this.verify('ORANGE_MONEY', {
      reference: str(body.payToken) ?? str(data.payToken) ?? str(body.pay_token),
      claimedStatus: str(body.status) ?? str(data.status),
    });
    return { received: true };
  }

  /** L'opérateur reçoit toujours 200 : la réconciliation reprend les vérifications en échec. */
  private async verify(
    method: 'MTN_MOMO' | 'ORANGE_MONEY',
    hint: { reference?: string; externalId?: string; claimedStatus?: string },
  ): Promise<void> {
    try {
      await this.finance.verifyOperatorCallback(method, hint);
    } catch (e) {
      this.logger.warn(
        `Vérification du rappel ${method} impossible : ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  private readonly logger = new Logger('Webhooks');
}

/** Outils du simulateur Mobile Money, désactivés en production. */
@ApiTags('dev')
@Controller('dev/mobile-money')
export class MobileMoneySimulatorController {
  constructor(private readonly finance: FinanceService) {}

  @Public()
  @Post(':reference/:status')
  @HttpCode(200)
  async simulate(@Param('reference') reference: string, @Param('status') status: string) {
    if (env().NODE_ENV === 'production' || env().MOBILE_MONEY_PROVIDER !== 'simulator')
      throw new NotFoundException();
    if (status !== 'SUCCESS' && status !== 'FAILED') throw new NotFoundException();
    SimulatorMobileMoneyProvider.statuses.set(reference, status);
    return this.finance.confirmMobileMoney({ reference, externalId: reference }, status);
  }
}

@Module({
  imports: [PdfModule],
  controllers: [FinanceController, WebhooksController, MobileMoneySimulatorController],
  providers: [
    FinanceService,
    { provide: MOBILE_MONEY_PROVIDER, useFactory: createMobileMoneyProvider },
  ],
  exports: [FinanceService],
})
export class FinanceModule {}
