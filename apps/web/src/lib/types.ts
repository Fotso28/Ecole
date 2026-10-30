import type { Permission, StaffRole } from '@ecole/shared';

export interface Me {
  user: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    isPlatformAdmin: boolean;
    mfaEnabled: boolean;
  };
  kind: 'staff' | 'parent';
  schools: { id: string; name: string; city: string; roles: StaffRole[] }[];
  activeSchool: {
    id: string;
    name: string;
    city: string;
    modules: string[];
    mfaRequired: boolean;
    currentYear: { id: string; name: string } | null;
  } | null;
  roles: StaffRole[];
  permissions: Permission[];
}

export interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  kind: 'staff' | 'parent';
  activeSchoolId: string | null;
}

export interface ClassSummary {
  id: string;
  name: string;
  academicYearId: string;
  levelId: string;
  level: { id: string; name: string; cycle: { id: string; name: string } };
  _count: { enrollments: number };
}

export interface StudentListItem {
  id: string;
  matricule: string;
  firstName: string;
  lastName: string;
  gender: 'F' | 'M';
  birthDate: string;
  class: { id: string; name: string } | null;
  status: 'ENROLLED' | 'REPEATING' | 'TRANSFERRED' | 'LEFT' | null;
  guardian: { name: string; phone: string } | null;
  overdue: number | null;
  absences: number;
}

export interface Paged<T> {
  total: number;
  page: number;
  pageSize: number;
  items: T[];
}

export interface LineState {
  id: string;
  label: string;
  amount: number;
  discount: number;
  due: number;
  paid: number;
  outstanding: number;
  dueDate: string;
  status: 'PAID' | 'PARTIAL' | 'UNPAID';
  overdue: boolean;
}

export interface PaymentView {
  id: string;
  amount: number;
  method: 'CASH' | 'BANK' | 'MTN_MOMO' | 'ORANGE_MONEY';
  methodLabel: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  reversed: boolean;
  reversalReason: string | null;
  operatorReference: string | null;
  failureReason: string | null;
  createdAt: string;
  confirmedAt: string | null;
  receipt: { number: string; verificationCode: string } | null;
}

export interface AccountTotals {
  due: number;
  paid: number;
  outstanding: number;
  overdue: number;
  balance: number;
  credit: number;
}

export interface Account {
  student: { id: string; firstName: string; lastName: string; matricule: string };
  lines: LineState[];
  totals: AccountTotals;
  nextDue: { lineId: string; label: string; dueDate: string; amount: number } | null;
  payments: PaymentView[];
}
