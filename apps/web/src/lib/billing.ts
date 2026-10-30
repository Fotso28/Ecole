import type {
  SubscriptionInvoiceState,
  SubscriptionLine,
  SubscriptionPricing,
} from '@ecole/shared';

/** Types et libellés de la facturation des abonnements (plateforme et Paramètres). */

export interface Plan {
  id: string;
  name: string;
  pricing: SubscriptionPricing;
  pricePerStudent: number;
  modulePrices: Record<string, number>;
  active: boolean;
}

export interface InvoicePayment {
  id: string;
  amount: number;
  method: string;
  reference: string | null;
  paidOn: string;
  note: string | null;
  correctsId: string | null;
  corrected: boolean;
}

export interface Invoice {
  id: string;
  number: string;
  period: string;
  planName: string;
  pricing: SubscriptionPricing;
  studentCount: number;
  modules: string[];
  lines: SubscriptionLine[];
  amount: number;
  paid: number;
  due: number;
  dueDate: string;
  state: SubscriptionInvoiceState;
  issuedAt: string;
  cancelReason: string | null;
  payments: InvoicePayment[];
  reminders: number;
  lastReminderAt: string | null;
}

export interface BillingWarning {
  level: 'overdue' | 'due';
  due: number;
}

export const STATE_BADGE: Record<
  SubscriptionInvoiceState,
  { tone: 'success' | 'warn' | 'info' | 'danger' | 'neutral' }
> = {
  PAID: { tone: 'success' },
  PARTIAL: { tone: 'warn' },
  DUE: { tone: 'info' },
  OVERDUE: { tone: 'danger' },
  CANCELLED: { tone: 'neutral' },
};
