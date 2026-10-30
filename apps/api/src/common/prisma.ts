import { ForbiddenException, Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { currentContext } from './context';

/**
 * Modèles cloisonnés par établissement. Toute requête sur ces modèles reçoit
 * automatiquement un filtre `schoolId` issu du contexte, et toute écriture dont le
 * `schoolId` diffère du contexte est refusée.
 */
export const TENANT_MODELS: ReadonlySet<string> = new Set<Prisma.ModelName>([
  'AcademicYear',
  'Term',
  'Sequence',
  'Cycle',
  'Level',
  'Class',
  'Subject',
  'ClassSubject',
  'Student',
  'Guardian',
  'StudentGuardian',
  'Enrollment',
  'StudentDocument',
  'HealthRecord',
  'AttendanceSession',
  'AttendanceRecord',
  'Justification',
  'Incident',
  'Evaluation',
  'Grade',
  'ReportCard',
  'CouncilDecision',
  'FeeItem',
  'Invoice',
  'InvoiceLine',
  'Payment',
  'PaymentAllocation',
  'Receipt',
  'LedgerEntry',
  'CashSession',
  'Reminder',
  'Announcement',
  'MessageThread',
  'Message',
  'SchoolEvent',
  'Counter',
  'Room',
  'TimetableEntry',
  'SchoolSubscription',
  'SubscriptionInvoice',
  'SubscriptionPayment',
  'SubscriptionReminder',
  'DocumentTemplate',
  'AdminDocument',
  'StoredFile',
  'LessonLog',
  'CourseMaterial',
  'ExamSession',
  'ExamPaper',
  'ExamRoom',
  'ExamCandidate',
  'ExamSupervision',
  'ExamScore',
  'ExamTransfer',
  'AccountingAccount',
  'AccountingJournal',
  'FiscalYear',
  'AccountingEntry',
  'AccountingLine',
  'Supplier',
  'Expense',
  'AccountingSettings',
  'EmployeeFile',
  'EmploymentContract',
  'TeachingSession',
  'SalaryAdvance',
  'AdvanceRepayment',
  'PayrollScale',
  'PayrollRun',
  'Payslip',
  'TransportVehicle',
  'TransportLine',
  'TransportStop',
  'TransportSubscription',
  'TransportTrip',
  'TransportTripRecord',
  'LibraryBook',
  'LibraryCopy',
  'LibraryLoan',
  'StockItem',
  'StockMovement',
  'StaffPayout',
  'StockInventory',
]);

export class TenantIsolationError extends ForbiddenException {
  constructor(message: string) {
    super(message);
  }
}

/** Établissement à appliquer, ou `null` pour une tâche système explicitement globale. */
function scopeFor(model: string): string | null {
  const ctx = currentContext();
  if (ctx?.kind === 'staff') return ctx.schoolId;
  if (ctx?.kind === 'system') return ctx.schoolId ?? null;
  throw new TenantIsolationError(`Accès à ${model} sans établissement dans le contexte`);
}

type Data = Record<string, unknown>;

function withSchool(data: unknown, schoolId: string, model: string): Data {
  const d = { ...((data ?? {}) as Data) };
  const connected = (d.school as { connect?: { id?: string } } | undefined)?.connect?.id;
  if (connected !== undefined) {
    if (connected !== schoolId)
      throw new TenantIsolationError(`Écriture inter-établissement refusée sur ${model}`);
    return d;
  }
  if (d.schoolId === undefined) {
    d.schoolId = schoolId;
  } else if (d.schoolId !== schoolId) {
    throw new TenantIsolationError(`Écriture inter-établissement refusée sur ${model}`);
  }
  return d;
}

function assertNoSchoolChange(data: unknown, schoolId: string, model: string): void {
  const value = (data as Data | undefined)?.schoolId;
  if (value !== undefined && value !== schoolId) {
    throw new TenantIsolationError(`Changement d'établissement refusé sur ${model}`);
  }
}

export function scopeArgs(
  model: string,
  operation: string,
  args: unknown,
  schoolId: string,
): unknown {
  const a = { ...((args ?? {}) as Data) };
  const scopeWhere = () => {
    a.where = { ...((a.where as Data | undefined) ?? {}), schoolId };
  };
  switch (operation) {
    case 'create':
      a.data = withSchool(a.data, schoolId, model);
      break;
    case 'createMany':
    case 'createManyAndReturn':
      a.data = Array.isArray(a.data)
        ? a.data.map((d) => withSchool(d, schoolId, model))
        : withSchool(a.data, schoolId, model);
      break;
    case 'upsert':
      scopeWhere();
      a.create = withSchool(a.create, schoolId, model);
      assertNoSchoolChange(a.update, schoolId, model);
      break;
    case 'update':
    case 'updateMany':
    case 'updateManyAndReturn':
      scopeWhere();
      assertNoSchoolChange(a.data, schoolId, model);
      break;
    default:
      // find*, count, aggregate, groupBy, delete, deleteMany
      scopeWhere();
  }
  return a;
}

export function createDb(base: PrismaClient) {
  return base.$extends({
    name: 'tenant-isolation',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_MODELS.has(model)) return query(args);
          const schoolId = scopeFor(model);
          if (schoolId === null) return query(args);
          return query(scopeArgs(model, operation, args, schoolId) as typeof args);
        },
      },
    },
  });
}

export type Db = ReturnType<typeof createDb>;
/** Client transactionnel obtenu dans `db.$transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];

export const DB = Symbol('DB');
export const BASE_PRISMA = Symbol('BASE_PRISMA');

/** Injection du client Prisma cloisonné. */
export const InjectDb = () => Inject(DB);

class PrismaLifecycle implements OnApplicationShutdown {
  constructor(@Inject(BASE_PRISMA) private readonly base: PrismaClient) {}
  async onApplicationShutdown(): Promise<void> {
    await this.base.$disconnect();
  }
}

@Global()
@Module({
  providers: [
    { provide: BASE_PRISMA, useFactory: () => new PrismaClient() },
    { provide: DB, useFactory: (base: PrismaClient) => createDb(base), inject: [BASE_PRISMA] },
    PrismaLifecycle,
  ],
  exports: [DB, BASE_PRISMA],
})
export class PrismaModule {}
