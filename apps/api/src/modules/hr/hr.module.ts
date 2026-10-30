import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  advanceCreateSchema,
  advanceDecisionSchema,
  contractCreateSchema,
  contractEndSchema,
  employeeCreateSchema,
  employeeUpdateSchema,
  hoursConfirmSchema,
  lessonMarkSchema,
  overtimeSchema,
  payrollMonth,
  payrollRejectSchema,
  payrollScaleSchema,
  payslipUpdateSchema,
  sensitiveReadSchema,
} from '@ecole/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { RequireModule, RequirePermissions } from '../../common/decorators';
import { ZodPipe } from '../../common/zod.pipe';
import { EmployeesService } from './employees.service';
import { HoursService } from './hours.service';
import { payslipsPdf, transfersCsv, transfersWorkbook } from './payroll.exports';
import { PayrollService } from './payroll.service';

const monthPipe = new ZodPipe(payrollMonth);
const hoursQuery = z.object({ teacherId: z.string().min(1), month: payrollMonth });
const transfersQuery = z.object({ format: z.enum(['csv', 'xlsx']).default('csv') });

@ApiTags('hr')
@ApiBearerAuth()
@RequireModule('hr')
@Controller('hr')
export class HrController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly hours: HoursService,
    private readonly payroll: PayrollService,
    private readonly audit: AuditService,
  ) {}

  // Dossiers et contrats

  @RequirePermissions('hr.read')
  @Get('employees')
  list() {
    return this.employees.list();
  }

  @RequirePermissions('hr.write')
  @Get('employees/candidates')
  candidates() {
    return this.employees.candidates();
  }

  @RequirePermissions('hr.write')
  @Post('employees')
  create(@Body(new ZodPipe(employeeCreateSchema)) body: z.infer<typeof employeeCreateSchema>) {
    return this.employees.create(body);
  }

  @RequirePermissions('hr.read')
  @Get('employees/:id')
  get(@Param('id') id: string) {
    return this.employees.get(id);
  }

  /** Données sensibles en clair : motif obligatoire, consultation journalisée. */
  @RequirePermissions('hr.read')
  @Post('employees/:id/sensitive')
  sensitive(
    @Param('id') id: string,
    @Body(new ZodPipe(sensitiveReadSchema)) body: z.infer<typeof sensitiveReadSchema>,
  ) {
    return this.employees.sensitive(id, body.reason);
  }

  @RequirePermissions('hr.write')
  @Patch('employees/:id')
  update(
    @Param('id') id: string,
    @Body(new ZodPipe(employeeUpdateSchema)) body: z.infer<typeof employeeUpdateSchema>,
  ) {
    return this.employees.update(id, body);
  }

  @RequirePermissions('hr.write')
  @Post('employees/:id/contracts')
  addContract(
    @Param('id') id: string,
    @Body(new ZodPipe(contractCreateSchema)) body: z.infer<typeof contractCreateSchema>,
  ) {
    return this.employees.addContract(id, body);
  }

  @RequirePermissions('hr.write')
  @Post('contracts/:id/end')
  endContract(
    @Param('id') id: string,
    @Body(new ZodPipe(contractEndSchema)) body: z.infer<typeof contractEndSchema>,
  ) {
    return this.employees.endContract(id, body.endDate, body.reason);
  }

  @RequirePermissions('hr.read')
  @Get('alerts')
  alerts() {
    return this.employees.alerts();
  }

  // Heures de cours

  @RequirePermissions('hr.read')
  @Get('hours/teachers')
  teachers() {
    return this.hours.teachers();
  }

  @RequirePermissions('hr.read')
  @Get('hours')
  month(@Query(new ZodPipe(hoursQuery)) q: z.infer<typeof hoursQuery>) {
    return this.hours.month(q.teacherId, q.month);
  }

  @RequirePermissions('hr.write')
  @Post('hours/lessons')
  mark(@Body(new ZodPipe(lessonMarkSchema)) body: z.infer<typeof lessonMarkSchema>) {
    return this.hours.mark(body);
  }

  @RequirePermissions('hr.write')
  @Post('hours/overtime')
  overtime(@Body(new ZodPipe(overtimeSchema)) body: z.infer<typeof overtimeSchema>) {
    return this.hours.addOvertime(body);
  }

  @RequirePermissions('hr.write')
  @Post('hours/confirm')
  confirm(@Body(new ZodPipe(hoursConfirmSchema)) body: z.infer<typeof hoursConfirmSchema>) {
    return this.hours.confirm(body.teacherId, body.month);
  }

  @RequirePermissions('hr.write')
  @Delete('hours/sessions/:id')
  removeSession(@Param('id') id: string) {
    return this.hours.remove(id);
  }

  // Avances sur salaire

  @RequirePermissions('hr.read')
  @Get('advances')
  advances() {
    return this.payroll.advances();
  }

  @RequirePermissions('hr.payroll.prepare')
  @Post('advances')
  requestAdvance(
    @Body(new ZodPipe(advanceCreateSchema)) body: z.infer<typeof advanceCreateSchema>,
  ) {
    return this.payroll.requestAdvance(body);
  }

  @RequirePermissions('hr.payroll.validate')
  @Post('advances/:id/approve')
  approveAdvance(
    @Param('id') id: string,
    @Body(new ZodPipe(advanceDecisionSchema)) body: z.infer<typeof advanceDecisionSchema>,
  ) {
    return this.payroll.decideAdvance(id, true, body.reason);
  }

  @RequirePermissions('hr.payroll.validate')
  @Post('advances/:id/reject')
  rejectAdvance(
    @Param('id') id: string,
    @Body(new ZodPipe(advanceDecisionSchema)) body: z.infer<typeof advanceDecisionSchema>,
  ) {
    return this.payroll.decideAdvance(id, false, body.reason);
  }

  // Barèmes

  @RequirePermissions('hr.read')
  @Get('scales')
  scales() {
    return this.payroll.scales();
  }

  @RequirePermissions('hr.payroll.validate')
  @Post('scales')
  addScale(@Body(new ZodPipe(payrollScaleSchema)) body: z.infer<typeof payrollScaleSchema>) {
    return this.payroll.addScale(body);
  }

  // Paie mensuelle

  @RequirePermissions('hr.read')
  @Get('payroll')
  runs() {
    return this.payroll.runs();
  }

  @RequirePermissions('hr.read')
  @Get('payroll/:month')
  run(@Param('month', monthPipe) month: string) {
    return this.payroll.get(month);
  }

  @RequirePermissions('hr.payroll.prepare')
  @Post('payroll/:month/compute')
  compute(@Param('month', monthPipe) month: string) {
    return this.payroll.computeMonth(month);
  }

  @RequirePermissions('hr.payroll.prepare')
  @Put('payroll/:month/payslips/:id')
  updatePayslip(
    @Param('month', monthPipe) month: string,
    @Param('id') id: string,
    @Body(new ZodPipe(payslipUpdateSchema)) body: z.infer<typeof payslipUpdateSchema>,
  ) {
    return this.payroll.updatePayslip(month, id, body.elements, body.absenceDays);
  }

  @RequirePermissions('hr.payroll.prepare')
  @Post('payroll/:month/submit')
  submit(@Param('month', monthPipe) month: string) {
    return this.payroll.submit(month);
  }

  @RequirePermissions('hr.payroll.validate')
  @Post('payroll/:month/validate')
  validate(@Param('month', monthPipe) month: string) {
    return this.payroll.validate(month);
  }

  @RequirePermissions('hr.payroll.validate')
  @Post('payroll/:month/reject')
  reject(
    @Param('month', monthPipe) month: string,
    @Body(new ZodPipe(payrollRejectSchema)) body: z.infer<typeof payrollRejectSchema>,
  ) {
    return this.payroll.reject(month, body.reason);
  }

  /** Récapitulatif d'une paie validée, lisible par la comptabilité générale. */
  @RequirePermissions('hr.read')
  @Get('payroll/:month/summary')
  summary(@Param('month', monthPipe) month: string) {
    return this.payroll.validatedSummary(month);
  }

  @RequirePermissions('hr.read')
  @Get('payroll/:month/payslips.pdf')
  async allPdf(@Param('month', monthPipe) month: string, @Res() res: Response) {
    const batch = await this.payroll.printable(month);
    const buffer = await payslipsPdf(batch);
    await this.audit.log({
      action: 'hr.payslips_printed',
      entity: 'PayrollRun',
      entityId: month,
      after: { month, count: batch.slips.length },
    });
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `inline; filename="bulletins-paie-${month}.pdf"`);
    res.send(buffer);
  }

  @RequirePermissions('hr.read')
  @Get('payroll/:month/payslips/:id/pdf')
  async onePdf(
    @Param('month', monthPipe) month: string,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const batch = await this.payroll.printable(month, id);
    const buffer = await payslipsPdf(batch);
    await this.audit.log({
      action: 'hr.payslip_printed',
      entity: 'Payslip',
      entityId: id,
      after: { month, number: batch.slips[0]?.number },
    });
    res.setHeader('content-type', 'application/pdf');
    res.setHeader(
      'content-disposition',
      `inline; filename="${batch.slips[0]?.number ?? `bulletin-${month}`}.pdf"`,
    );
    res.send(buffer);
  }

  /** État des virements à exécuter manuellement : jamais d'envoi automatique. */
  @RequirePermissions('hr.payroll.prepare')
  @Get('payroll/:month/transfers')
  async transfers(
    @Param('month', monthPipe) month: string,
    @Query(new ZodPipe(transfersQuery)) q: z.infer<typeof transfersQuery>,
    @Res() res: Response,
  ) {
    const { school, rows } = await this.payroll.transferRows(month);
    await this.audit.log({
      action: 'hr.transfers_exported',
      entity: 'PayrollRun',
      entityId: month,
      after: {
        month,
        format: q.format,
        count: rows.length,
        total: rows.reduce((s, r) => s + r.net, 0),
      },
    });
    if (q.format === 'xlsx') {
      res.setHeader(
        'content-type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('content-disposition', `attachment; filename="virements-${month}.xlsx"`);
      res.send(await transfersWorkbook(school, month, rows));
      return;
    }
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="virements-${month}.csv"`);
    res.send(String.fromCharCode(0xfeff) + transfersCsv(month, rows));
  }
}

@Module({
  controllers: [HrController],
  providers: [EmployeesService, HoursService, PayrollService],
  exports: [PayrollService],
})
export class HrModule {}
