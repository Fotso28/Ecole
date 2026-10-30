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
  status: 'PENDING_APPROVAL' | 'POSTED' | 'REJECTED';
  supplier: string;
  createdById: string;
  createdBy: string | null;
  approvedBy: string | null;
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
    default:
      return null;
  }
}

/** Contre-passation possible : saisie manuelle ou dépense, pas encore contre-passée. */
export function canReverse(e: EntryView): boolean {
  return (
    !e.reversedBy &&
    !e.reversesEntryId &&
    e.sourceType !== 'LEDGER' &&
    e.sourceType !== 'CARRY_FORWARD'
  );
}
