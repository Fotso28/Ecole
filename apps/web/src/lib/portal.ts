'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Account } from './types';

export interface ChildOverview {
  student: { id: string; firstName: string; lastName: string; matricule: string };
  className: string | null;
  modules: { grades: boolean; finance: boolean };
  /** Absent si l'école de l'enfant n'a pas activé les finances. */
  finance: {
    totals: Account['totals'];
    nextDue: Account['nextDue'];
    lines: Account['lines'];
    payments: Account['payments'];
  } | null;
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
    justificationId: string | null;
    hasAttachment: boolean;
    /** Dernier justificatif refusé pour cette absence (à justifier de nouveau), avec son motif. */
    rejection: { note: string | null; reviewedAt: string | null } | null;
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
  /** Exclusions temporaires de l'année (date de l'incident, précisions de la vie scolaire). */
  exclusions?: { id: string; date: string; details: string | null }[];
}

export function useChildOverview(id: string | undefined) {
  return useQuery({
    queryKey: ['portal-child', id],
    queryFn: () => api<ChildOverview>(`/portal/children/${id}`),
    enabled: !!id,
  });
}

export interface ChildHomework {
  className: string | null;
  homework: {
    id: string;
    subjectName: string | null;
    date: string;
    content: string;
    homework: string | null;
    homeworkDueDate: string | null;
    materials: PortalMaterial[];
  }[];
  materials: PortalMaterial[];
}

export interface PortalMaterial {
  id: string;
  title: string;
  subjectName: string | null;
  createdAt: string;
  file: { id: string; name: string; mimeType: string; size: number } | null;
}

export function useChildHomework(id: string | undefined) {
  return useQuery({
    queryKey: ['portal-homework', id],
    queryFn: () => api<ChildHomework>(`/portal/children/${id}/homework`),
    enabled: !!id,
  });
}
