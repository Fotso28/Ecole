'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface AccountView {
  id: string;
  number: string;
  label: string;
  class: number;
  isSystem: boolean;
  postable: boolean;
}

export interface FiscalYearView {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: 'OPEN' | 'CLOSED';
  closedAt: string | null;
  entries?: number;
}

export interface EntryView {
  id: string;
  reference: string;
  journal: string;
  number: number;
  date: string;
  label: string;
  pieceRef: string | null;
  sourceType: string | null;
  total: number;
  reversesEntryId: string | null;
  reversedBy: string | null;
  createdAt: string;
  lines: { accountNumber: string; label: string | null; debit: number; credit: number }[];
}

export interface ExpenseView {
  id: string;
  date: string;
  label: string;
  amount: number;
  accountNumber: string;
  method: 'CASH' | 'BANK' | 'MTN_MOMO' | 'ORANGE_MONEY';
  pieceRef: string;
  status: 'PENDING_APPROVAL' | 'POSTED' | 'REJECTED' | 'CANCELLED';
  supplier: string;
  createdById: string;
  createdBy: string | null;
  approvedBy: string | null;
  cancelledBy?: string | null;
  cancelledAt?: string | null;
  cancelReason?: string | null;
  rejectedReason: string | null;
  entries: string[];
}

export interface AccountingOverview {
  fiscalYear: FiscalYearView | null;
  treasury: { method: string; accountNumber: string; label: string; balance: number }[];
  receivables: number;
  products: number;
  charges: number;
  result: number;
  pendingTuition: number;
  /** Paies validées, versements au personnel et achats de stock pas encore comptabilisés. */
  pendingOperations: number;
  pendingExpenses: number;
  /** Écritures de trésorerie en attente de validation. */
  pendingEntries: number;
  expenseApprovalThreshold: number;
}

export function useAccounts() {
  return useQuery({
    queryKey: ['accounting', 'accounts'],
    queryFn: () => api<AccountView[]>('/accounting/accounts'),
    staleTime: 60_000,
  });
}

export function useFiscalYears() {
  return useQuery({
    queryKey: ['accounting', 'fiscal-years'],
    queryFn: () => api<FiscalYearView[]>('/accounting/fiscal-years'),
  });
}

/** Libellé d'origine d'une écriture. */
export function entryOrigin(e: Pick<EntryView, 'sourceType' | 'reversesEntryId'>): string | null {
  if (e.reversesEntryId) return 'Contre-passation';
  switch (e.sourceType) {
    case 'LEDGER':
      return 'Scolarité';
    case 'EXPENSE':
    case 'EXPENSE_PAYMENT':
      return 'Dépense';
    case 'CARRY_FORWARD':
      return 'Report à nouveau';
    case 'PAYROLL':
      return 'Paie';
    case 'PAYROLL_PAYMENT':
      return 'Versement des salaires';
    case 'ADVANCE_PAYMENT':
      return 'Avance sur salaire';
    case 'STOCK_PURCHASE':
      return 'Achat de stock';
    default:
      return null;
  }
}

/** Contre-passation possible : saisie manuelle ou dépense, pas encore contre-passée. */
export function canReverse(e: EntryView): boolean {
  return (
    !e.reversedBy &&
    !e.reversesEntryId &&
    ![
      'LEDGER',
      'CARRY_FORWARD',
      'PAYROLL',
      'STOCK_PURCHASE',
      'EXPENSE',
      'EXPENSE_PAYMENT',
    ].includes(e.sourceType ?? '')
  );
}

/** Écriture de trésorerie au-delà du seuil, en attente de validation par une autre personne. */
export interface EntryRequestView {
  id: string;
  journal: string;
  date: string;
  label: string;
  pieceRef: string | null;
  lines: { accountNumber: string; debit: number; credit: number; label?: string }[];
  total: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdById: string;
  createdBy: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  reference: string | null;
}
