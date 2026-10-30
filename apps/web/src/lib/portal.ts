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
    justificationId: string | null;
    hasAttachment: boolean;
  }[];
  reportCards: {
    id: string;
    term: string;
    version: number;
    generalAverageCenti: number | null;
    rank: number | null;
    classSize: number;
    publishedAt: string;
  }[];
  announcements: { id: string; title: string; body: string; publishedAt: string }[];
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
