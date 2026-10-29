import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Module,
  NotFoundException,
  Param,
  Post,
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
import {
  createMobileMoneyProvider,
  MOBILE_MONEY_PROVIDER,
  signWebhook,
  SimulatorMobileMoneyProvider,
} from './mobile-money.provider';

const discountSchema = z.object({ amount: z.number().int().positive(), reason: z.string().trim().min(2).max(120) });
const journalSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  status: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED']).optional(),
});
const exportSchema = z.object({ from: isoDate, to: isoDate });
const webhookSchema = z.object({
  reference: z.string().min(1),
  status: z.enum(['SUCCESS', 'FAILED', 'PENDING']),
  amount: z.number().int().positive().optional(),
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
  generateInvoice(@Body(new ZodPipe(invoiceGenerateSchema)) body: z.infer<typeof invoiceGenerateSchema>) {
    return this.finance.generateInvoice(body.studentId, body.academicYearId, body.discounts);
  }

  @RequirePermissions('finance.fees.write')
  @Post('invoice-lines/:id/discounts')
  discount(@Param('id') id: string, @Body(new ZodPipe(discountSchema)) body: z.infer<typeof discountSchema>) {
    return this.finance.addDiscount(id, body.amount, body.reason);
  }

  @RequirePermissions('finance.read')
  @Get('students/:id/account')
  account(@Param('id') id: string) {
    return this.finance.account(id);
  }

  @RequirePermissions('finance.payments.create')
  @Post('payments')
  createPayment(@Body(new ZodPipe(paymentCreateSchema)) body: z.infer<typeof paymentCreateSchema>) {
    return this.finance.createPayment(body);
  }

  @RequirePermissions('finance.read')
  @Get('payments')
  journal(@Query(new ZodPipe(journalSchema)) q: z.infer<typeof journalSchema>) {
    return this.finance.journal(q);
  }

  @RequirePermissions('finance.read')
  @Get('payments/export.csv')
  async export(@Query(new ZodPipe(exportSchema)) q: z.infer<typeof exportSchema>, @Res() res: Response) {
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
  @Post('payments/:id/reverse')
  reverse(@Param('id') id: string, @Body(new ZodPipe(paymentReverseSchema)) body: z.infer<typeof paymentReverseSchema>) {
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
  closeCash(@Param('id') id: string, @Body(new ZodPipe(cashCloseSchema)) body: z.infer<typeof cashCloseSchema>) {
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
  async unpaid(@Query('classId') classId?: string, @Query('academicYearId') academicYearId?: string) {
    return this.finance.unpaid(academicYearId ?? (await this.scope.currentYear()).id, classId);
  }
}

/** Webhooks des opérateurs Mobile Money : signature HMAC obligatoire, liste d'IP optionnelle. */
@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly finance: FinanceService) {}

  @Public()
  @Post('mobile-money')
  @HttpCode(200)
  async mobileMoney(@Req() req: Request & { rawBody?: Buffer }, @Body(new ZodPipe(webhookSchema)) body: z.infer<typeof webhookSchema>) {
    const allowed = env()
      .MOBILE_MONEY_ALLOWED_IPS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(req.ip ?? '')) throw new ForbiddenException('Origine non autorisée');
    const signature = req.headers['x-ecole-signature'];
    if (typeof signature !== 'string' || !req.rawBody || !safeEqual(signature, signWebhook(req.rawBody))) {
      throw new UnauthorizedException('Signature invalide');
    }
    return this.finance.confirmMobileMoney(body.reference, body.status, body.amount);
  }
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
    if (env().NODE_ENV === 'production' || env().MOBILE_MONEY_PROVIDER !== 'simulator') throw new NotFoundException();
    if (status !== 'SUCCESS' && status !== 'FAILED') throw new NotFoundException();
    SimulatorMobileMoneyProvider.statuses.set(reference, status);
    return this.finance.confirmMobileMoney(reference, status);
  }
}

@Module({
  imports: [PdfModule],
  controllers: [FinanceController, WebhooksController, MobileMoneySimulatorController],
  providers: [FinanceService, { provide: MOBILE_MONEY_PROVIDER, useFactory: createMobileMoneyProvider }],
  exports: [FinanceService],
})
export class FinanceModule {}

