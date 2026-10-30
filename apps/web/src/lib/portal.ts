'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Account } from './types';

export interface ChildOverview {
  student: { id: string; firstName: string; lastName: string; matricule: string };
  className: string | null;
  finance: {
    totals: Account['totals'];
    nextDue: Account['nextDue'];
    lines: Account['lines'];
    payments: Account['payments'];
  };
  grades: {
    id: string;
    subject: string;
    evaluation: string;
    sequence: string;
    maxScore: number;
    value: string;
  }[];
  absences: {
    id: string;
    date: string;
    startTime: string;
    endTime: string;
    status: 'ABSENT' | 'LATE';
    justification: 'PENDING' | 'ACCEPTED' | 'REJECTED' | null;
  }[];
  reportCards: {
    id: string;
    term: string;
    version: number;
    generalAverageCenti: number | null;
    rank: number | null;
    classSize: number;
    publishedAt: string;
    annualAverageCenti: number | null;
    annualRankLabel: string | null;
    yearEndDecision: string | null;
  }[];
  transcripts: {
    sequences: { id: string; name: string }[];
    terms: { id: string; name: string }[];
    year: { id: string } | null;
  };
  announcements: { id: string; title: string; body: string; publishedAt: string }[];
}

export function useChildOverview(id: string | undefined) {
  return useQuery({
    queryKey: ['portal-child', id],
    queryFn: () => api<ChildOverview>(`/portal/children/${id}`),
    enabled: !!id,
  });
}
