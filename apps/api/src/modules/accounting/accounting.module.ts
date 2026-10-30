import { Body, Controller, Get, Module, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  accountCreateSchema,
  ACCOUNTING_REPORTS,
  accountingPeriodSchema,
  accountingSettingsSchema,
  entryReverseSchema,
  expenseCreateSchema,
  expenseRejectSchema,
  fiscalYearOpenSchema,
  manualEntrySchema,
  supplierCreateSchema,
  type AccountingReport,
} from '@ecole/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { RequireModule, RequirePermissions } from '../../common/decorators';
import { ZodPipe } from '../../common/zod.pipe';
import { AccountingReportsService } from './accounting.reports';
import { AccountingService } from './accounting.service';

const reportKind = z.enum(ACCOUNTING_REPORTS);
const requestStatus = z
  .object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() })
  .strict();
const expenseStatus = z
  .object({ status: z.enum(['PENDING_APPROVAL', 'POSTED', 'REJECTED', 'CANCELLED']).optional() })
  .strict();

@ApiTags('accounting')
@ApiBearerAuth()
@RequireModule('accounting')
@Controller('accounting')
export class AccountingController {
  constructor(
    private readonly accounting: AccountingService,
    private readonly reports: AccountingReportsService,
  ) {}

  @RequirePermissions('accounting.read')
  @Get('overview')
  overview() {
    return this.accounting.overview();
  }

  /**
   * Rattrapage immédiat : scolarité, paie, versements au personnel et achats de stock (le worker
   * le fait aussi chaque minute).
   */
  @RequirePermissions('accounting.write')
  @Post('sync')
  sync() {
    return this.accounting.syncAll();
  }

  @RequirePermissions('accounting.read')
  @Get('accounts')
  accounts() {
    return this.accounting.listAccounts();
  }

  @RequirePermissions('accounting.write')
  @Post('accounts')
  createAccount(@Body(new ZodPipe(accountCreateSchema)) body: z.infer<typeof accountCreateSchema>) {
    return this.accounting.createAccount(body);
  }

  @RequirePermissions('accounting.read')
  @Get('journals')
  journals() {
    return this.accounting.listJournals();
  }

  @RequirePermissions('accounting.read')
  @Get('fiscal-years')
  fiscalYears() {
    return this.accounting.listFiscalYears();
  }

  @RequirePermissions('accounting.close')
  @Post('fiscal-years')
  openFiscalYear(
    @Body(new ZodPipe(fiscalYearOpenSchema)) body: z.infer<typeof fiscalYearOpenSchema>,
  ) {
    return this.accounting.openFiscalYear(body);
  }

  @RequirePermissions('accounting.close')
  @Post('fiscal-years/:id/close')
  closeFiscalYear(@Param('id') id: string) {
    return this.accounting.closeFiscalYear(id);
  }

  @RequirePermissions('accounting.read')
  @Get('entries')
  entries(@Query(new ZodPipe(accountingPeriodSchema)) q: z.infer<typeof accountingPeriodSchema>) {
    return this.accounting.listEntries(q);
  }

  @RequirePermissions('accounting.write')
  @Post('entries')
  createEntry(@Body(new ZodPipe(manualEntrySchema)) body: z.infer<typeof manualEntrySchema>) {
    return this.accounting.createManualEntry(body);
  }

  /** Écritures de trésorerie au-delà du seuil, en attente de validation par une autre personne. */
  @RequirePermissions('accounting.read')
  @Get('entry-requests')
  entryRequests(@Query(new ZodPipe(requestStatus)) q: z.infer<typeof requestStatus>) {
    return this.accounting.listEntryRequests(q.status);
  }

  @RequirePermissions('accounting.write')
  @Post('entry-requests/:id/approve')
  approveEntryRequest(@Param('id') id: string) {
    return this.accounting.approveEntryRequest(id);
  }

  @RequirePermissions('accounting.write')
  @Post('entry-requests/:id/reject')
  rejectEntryRequest(
    @Param('id') id: string,
    @Body(new ZodPipe(expenseRejectSchema)) body: z.infer<typeof expenseRejectSchema>,
  ) {
    return this.accounting.rejectEntryRequest(id, body.reason);
  }

  @RequirePermissions('accounting.read')
  @Get('entries/:id')
  entry(@Param('id') id: string) {
    return this.accounting.getEntry(id);
  }

  @RequirePermissions('accounting.write')
  @Post('entries/:id/reverse')
  reverse(
    @Param('id') id: string,
    @Body(new ZodPipe(entryReverseSchema)) body: z.infer<typeof entryReverseSchema>,
  ) {
    return this.accounting.reverseEntry(id, body.reason, body.date);
  }

  @RequirePermissions('accounting.read')
  @Get('suppliers')
  suppliers() {
    return this.accounting.listSuppliers();
  }

  @RequirePermissions('accounting.write')
  @Post('suppliers')
  createSupplier(
    @Body(new ZodPipe(supplierCreateSchema)) body: z.infer<typeof supplierCreateSchema>,
  ) {
    return this.accounting.createSupplier(body);
  }

  @RequirePermissions('accounting.read')
  @Get('expenses')
  expenses(@Query(new ZodPipe(expenseStatus)) q: z.infer<typeof expenseStatus>) {
    return this.accounting.listExpenses(q.status);
  }

  @RequirePermissions('accounting.write')
  @Post('expenses')
  createExpense(@Body(new ZodPipe(expenseCreateSchema)) body: z.infer<typeof expenseCreateSchema>) {
    return this.accounting.createExpense(body);
  }

  @RequirePermissions('accounting.write')
  @Post('expenses/:id/approve')
  approveExpense(@Param('id') id: string) {
    return this.accounting.approveExpense(id);
  }

  @RequirePermissions('accounting.write')
  @Post('expenses/:id/reject')
  rejectExpense(
    @Param('id') id: string,
    @Body(new ZodPipe(expenseRejectSchema)) body: z.infer<typeof expenseRejectSchema>,
  ) {
    return this.accounting.rejectExpense(id, body.reason);
  }

  /** Annulation d'une dépense comptabilisée : motif, contre-passation de ses écritures. */
  @RequirePermissions('accounting.write')
  @Post('expenses/:id/cancel')
  cancelExpense(
    @Param('id') id: string,
    @Body(new ZodPipe(expenseRejectSchema)) body: z.infer<typeof expenseRejectSchema>,
  ) {
    return this.accounting.cancelExpense(id, body.reason);
  }

  @RequirePermissions('accounting.read')
  @Get('settings')
  settings() {
    return this.accounting.getSettings();
  }

  /** Seuil de validation des dépenses : réservé à la direction (paramètres de l'école). */
  @RequirePermissions('accounting.read', 'settings.write')
  @Put('settings')
  updateSettings(
    @Body(new ZodPipe(accountingSettingsSchema)) body: z.infer<typeof accountingSettingsSchema>,
  ) {
    return this.accounting.updateSettings(body);
  }

  @RequirePermissions('accounting.read')
  @Get('reports/:kind')
  report(
    @Param('kind', new ZodPipe(reportKind)) kind: AccountingReport,
    @Query(new ZodPipe(accountingPeriodSchema)) q: z.infer<typeof accountingPeriodSchema>,
  ) {
    return this.reports.build(kind, q);
  }

  @RequirePermissions('accounting.read')
  @Get('reports/:kind/export.xlsx')
  async reportXlsx(
    @Param('kind', new ZodPipe(reportKind)) kind: AccountingReport,
    @Query(new ZodPipe(accountingPeriodSchema)) q: z.infer<typeof accountingPeriodSchema>,
    @Res() res: Response,
  ) {
    const buffer = await this.reports.xlsx(await this.reports.build(kind, q));
    res.setHeader(
      'content-type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('content-disposition', `attachment; filename="${kind}-${q.from}-${q.to}.xlsx"`);
    res.send(buffer);
  }

  @RequirePermissions('accounting.read')
  @Get('reports/:kind/export.pdf')
  async reportPdf(
    @Param('kind', new ZodPipe(reportKind)) kind: AccountingReport,
    @Query(new ZodPipe(accountingPeriodSchema)) q: z.infer<typeof accountingPeriodSchema>,
    @Res() res: Response,
  ) {
    const buffer = await this.reports.pdf(await this.reports.build(kind, q));
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `inline; filename="${kind}-${q.from}-${q.to}.pdf"`);
    res.send(buffer);
  }
}

@Module({
  controllers: [AccountingController],
  providers: [AccountingService, AccountingReportsService],
  exports: [AccountingService],
})
export class AccountingModule {}
