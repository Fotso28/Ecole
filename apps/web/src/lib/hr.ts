import type {
  ContractType,
  PayElement,
  PaymentMethod,
  PayoutMethod,
  PayrollScale,
  PayrollStatus,
  PayslipResult,
  StaffRole,
} from '@ecole/shared';

/** Types des réponses du module RH et paie. */

export interface ContractView {
  id: string;
  type: ContractType;
  startDate: string;
  endDate: string | null;
  baseSalary: number | null;
  hourlyRate: number | null;
  overtimeRate: number | null;
  endedAt: string | null;
  endReason: string | null;
  daysLeft: number | null;
  endingSoon: boolean;
}

export interface EmployeeRow {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  roles: StaffRole[];
  active: boolean;
  position: string;
  hireDate: string;
  payoutMethod: PayoutMethod;
  contract: ContractView | null;
}

export interface EmployeeDetail extends EmployeeRow {
  email: string | null;
  phone: string | null;
  diplomas: { title: string; year?: number; institution?: string }[];
  sensitive: {
    filled: string[];
    cnpsNumber: string | null;
    bankAccount: string | null;
    mobileMoneyNumber: string | null;
  };
  /** Changement de coordonnées de paiement en attente d'approbation (valeurs masquées). */
  pendingPayoutChange: PendingPayoutChange | null;
  contracts: ContractView[];
  advances: {
    id: string;
    amount: number;
    installments: number;
    firstMonth: string;
    status: AdvanceStatus;
    reason: string;
    repaid: number;
  }[];
}

export interface ContractAlert {
  employeeId: string;
  firstName: string;
  lastName: string;
  position: string;
  contract: ContractView;
}

export type AdvanceStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'REPAID';

export const ADVANCE_STATUS: Record<
  AdvanceStatus,
  { label: string; tone: 'warn' | 'success' | 'danger' | 'neutral' }
> = {
  REQUESTED: { label: 'En attente d’accord', tone: 'warn' },
  APPROVED: { label: 'Accordée', tone: 'success' },
  REJECTED: { label: 'Refusée', tone: 'danger' },
  REPAID: { label: 'Remboursée', tone: 'neutral' },
};

export interface AdvanceRow {
  id: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  amount: number;
  installments: number;
  monthly: number;
  firstMonth: string;
  reason: string;
  status: AdvanceStatus;
  repaid: number;
  remaining: number;
  requestedById: string;
  decidedById: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  payout: PayoutView | null;
}

/** Versement enregistré (salaires d'une paie validée ou avance accordée). */
export interface PayoutView {
  id: string;
  date: string;
  method: PaymentMethod;
  reference: string | null;
  amount: number;
  paidById: string;
  paidBy: string | null;
  paidAt: string;
  sameAsValidator: boolean;
  entry: string | null;
}

export interface HoursMonth {
  month: string;
  locked: boolean;
  totals: {
    plannedMinutes: number;
    doneMinutes: number;
    absentJustifiedMinutes: number;
    absentUnjustifiedMinutes: number;
    unmarkedMinutes: number;
    overtimeMinutes: number;
  };
  lessons: {
    timetableEntryId: string;
    date: string;
    startTime: string | null;
    endTime: string | null;
    minutes: number;
    className: string;
    subject: string;
    sessionId: string | null;
    status: 'DONE' | 'ABSENT' | null;
    justified: boolean;
    reason: string | null;
  }[];
  overtime: { id: string; date: string; minutes: number; reason: string | null }[];
}

export interface PayslipView {
  id: string;
  employeeId: string;
  number: string | null;
  firstName: string;
  lastName: string;
  position: string;
  contractType: ContractType;
  elements: PayElement[];
  absenceDays: number;
  inputs: {
    hours: HoursMonth['totals'];
    activeDays: number;
    daysInMonth: number;
    advances: { id: string; due: number }[];
  };
  result: PayslipResult;
  gross: number;
  net: number;
  employerCost: number;
}

export interface PayrollRunView {
  month: string;
  id?: string;
  status: PayrollStatus | null;
  scale: PayrollScale;
  computedAt?: string;
  computedBy?: string | null;
  computedById?: string;
  preparedAt?: string | null;
  preparedBy?: string | null;
  preparedById?: string | null;
  validatedAt?: string | null;
  validatedBy?: string | null;
  validatedById?: string | null;
  payout?: PayoutView | null;
  rejectedAt?: string | null;
  rejectedBy?: string | null;
  rejectReason?: string | null;
  totals: { headcount: number; gross: number; net: number; employerCost: number } | null;
  payslips: PayslipView[];
}

/** Mois courant (AAAA-MM), heure du Cameroun. */
export function currentMonth(now = new Date()): string {
  return new Date(now.getTime() + 3_600_000).toISOString().slice(0, 7);
}

/** Mois proposés dans les listes : les 12 derniers et le suivant. */
export function monthOptions(now = new Date()): string[] {
  const [y, m] = currentMonth(now).split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = 1; i >= -11; i--) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

export interface MaskedPayout {
  method: PayoutMethod;
  bankName: string | null;
  bankAccount: string | null;
  mobileMoneyNumber: string | null;
  mobileMoneyOperator: 'MTN' | 'ORANGE' | null;
}

export interface PendingPayoutChange {
  id: string;
  requestedById: string;
  requestedBy: string | null;
  requestedAt: string;
  before: MaskedPayout;
  after: MaskedPayout;
}
