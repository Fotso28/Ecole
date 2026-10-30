import { ForbiddenException, Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { currentContext, type RequestContext } from './context';

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
  'PayoutDetailsChange',
  'ManualEntryRequest',
  'StockInventory',
  'RoleOverride',
  'CustomRole',
]);

/**
 * Tables protégées par la Row-Level Security de PostgreSQL : les modèles cloisonnés, plus le
 * journal d'audit et la file des notifications, dont le `schoolId` peut être nul (événements de
 * plateforme, codes de connexion). Les lignes sans établissement ne sont visibles qu'en mode
 * système. Voir la migration `20261031130000_row_level_security`.
 */
export const RLS_MODELS: ReadonlySet<string> = new Set<string>([
  ...TENANT_MODELS,
  'AuditLog',
  'NotificationOutbox',
]);

/**
 * Tables portant un `schoolId` volontairement hors RLS : annuaire d'authentification, lu avant
 * que l'établissement ne soit connu (connexion, renouvellement de session, garde d'accès).
 */
export const RLS_EXEMPT_MODELS: ReadonlySet<string> = new Set<string>([
  'Membership',
  'RefreshToken',
]);

/**
 * Portée appliquée par la base : établissement du contexte, ou mode système (toutes les
 * écoles, rôle `ecole_system`) pour `runAsSystem` sans établissement. Sans contexte d'établissement (anonyme,
 * parent, compte), aucune ligne cloisonnée n'est visible.
 */
export interface RlsScope {
  system: boolean;
  schoolId: string | null;
}

export function rlsScope(ctx: RequestContext | undefined = currentContext()): RlsScope {
  if (ctx?.kind === 'staff') return { system: false, schoolId: ctx.schoolId };
  if (ctx?.kind === 'system') {
    return ctx.schoolId
      ? { system: false, schoolId: ctx.schoolId }
      : { system: true, schoolId: null };
  }
  return { system: false, schoolId: null };
}

/** La portée de la base couvre-t-elle cet établissement (ou toutes les écoles) ? */
export function rlsCovers(schoolId: string | null): boolean {
  const scope = rlsScope();
  return scope.system || (schoolId !== null && scope.schoolId === schoolId);
}

function scopeKey(scope: RlsScope): string {
  return scope.system ? 'system' : (scope.schoolId ?? '');
}

/**
 * Rôle PostgreSQL du mode système : sans connexion propre, BYPASSRLS, accordé au rôle applicatif.
 * Pris dans la transaction (`SET LOCAL ROLE`) par `runAsSystem` sans établissement.
 */
export const SYSTEM_ROLE = 'ecole_system';

/**
 * Portée de la transaction : établissement lu par les politiques (`app.school_id`) et rôle
 * courant (système ou rôle de connexion). `set_config(…, true)` s'annule à la fin de la
 * transaction.
 */
function scopeSql(scope: RlsScope): Prisma.Sql {
  return Prisma.sql`SELECT set_config('app.school_id', ${scope.schoolId ?? ''}, true), set_config('role', ${scope.system ? SYSTEM_ROLE : 'none'}, true)`;
}

const READ_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** La requête peut-elle toucher une table protégée (directement ou par une relation) ? */
function touchesRls(model: string | undefined, operation: string, args: unknown): boolean {
  if (!model || RLS_MODELS.has(model)) return true;
  if (!READ_OPERATIONS.has(operation)) return true;
  const a = (args ?? {}) as Data;
  if (a.include) return true;
  const select = a.select as Data | undefined;
  return !!select && Object.values(select).some((v) => typeof v === 'object' && v !== null);
}

/** Identifiant d'une transaction interactive, porté par son client (`tx`). */
const TX_ID = Symbol.for('prisma.client.transaction.id');

interface OpenTransaction {
  run: (sql: Prisma.Sql) => Promise<unknown>;
  key: string;
}

/** Transactions interactives en cours et portée actuellement posée dans chacune. */
const openTransactions = new Map<string, OpenTransaction>();

interface InternalParams {
  transaction?: { kind: 'itx' | 'batch'; id?: string };
}

type Data = Record<string, unknown>;

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

/**
 * Client cloisonné, en deux couches :
 * - filtre applicatif : `schoolId` ajouté aux requêtes sur `TENANT_MODELS`, écritures
 *   inter-établissements refusées ;
 * - Row-Level Security : la portée du contexte (`app.school_id`, ou le rôle `ecole_system` en
 *   mode système) est posée dans la transaction de chaque requête. Hors transaction, la requête est enveloppée dans une
 *   transaction courte (réglage puis requête) ; dans une transaction interactive, le réglage est
 *   posé à l'ouverture et reposé si le contexte change en cours de route (`runAsSystem`).
 *   `set_config(…, true)` s'annule à la fin de la transaction : rien ne fuit d'une requête à
 *   l'autre sur une même connexion du pool.
 */
export function createDb(base: PrismaClient) {
  const scoped = base.$extends({
    name: 'tenant-isolation',
    query: {
      async $allOperations({ model, operation, args, query, ...rest }) {
        let scopedArgs = args;
        if (model && TENANT_MODELS.has(model)) {
          const schoolId = scopeFor(model);
          if (schoolId !== null) {
            scopedArgs = scopeArgs(model, operation, args, schoolId) as typeof args;
          }
        }
        const scope = rlsScope();
        const key = scopeKey(scope);
        // Paramètre interne de Prisma 6 : transaction en cours de la requête, s'il y en a une.
        const transaction = (rest as { __internalParams?: InternalParams }).__internalParams
          ?.transaction;
        if (transaction?.kind === 'itx') {
          const open = transaction.id ? openTransactions.get(transaction.id) : undefined;
          if (open && open.key !== key) {
            open.key = key;
            await open.run(scopeSql(scope));
          }
          return query(scopedArgs);
        }
        // Lot `$transaction([…])` : portée posée en tête du lot. Sans portée : la base ne montre
        // aucune ligne cloisonnée, inutile d'ouvrir une transaction.
        if (transaction || key === '' || !touchesRls(model, operation, scopedArgs)) {
          return query(scopedArgs);
        }
        const [, result] = await base.$transaction([
          base.$executeRaw(scopeSql(scope)),
          query(scopedArgs),
        ]);
        return result;
      },
    },
  });

  const transaction = ((arg: unknown, options?: unknown) => {
    const scope = rlsScope();
    const key = scopeKey(scope);
    const opts = options as Parameters<typeof scoped.$transaction>[1];
    if (Array.isArray(arg)) {
      if (key === '') return scoped.$transaction(arg, opts);
      return scoped
        .$transaction([scoped.$executeRaw(scopeSql(scope)), ...arg], opts)
        .then((results) => results.slice(1));
    }
    const fn = arg as (tx: unknown) => Promise<unknown>;
    return scoped.$transaction(async (tx) => {
      const id = (tx as unknown as Record<symbol, string>)[TX_ID]!;
      const open: OpenTransaction = { run: (sql) => tx.$executeRaw(sql), key };
      openTransactions.set(id, open);
      try {
        if (key !== '') await tx.$executeRaw(scopeSql(scope));
        return await fn(tx);
      } finally {
        openTransactions.delete(id);
      }
    }, opts);
  }) as typeof scoped.$transaction;

  return scoped.$extends({ name: 'rls-transactions', client: { $transaction: transaction } });
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
