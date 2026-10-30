'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth';
import type { ClassSummary } from './types';

export interface YearStructure {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  terms: {
    id: string;
    name: string;
    order: number;
    startDate: string;
    endDate: string;
    sequences: { id: string; name: string; order: number }[];
  }[];
  classes: (ClassSummary & {
    subjects: {
      id: string;
      coefficient: number;
      teacherId: string | null;
      weeklyHours: number | null;
      subject: { id: string; name: string; code: string; group: string };
    }[];
  })[];
}

export function useClasses() {
  return useQuery({
    queryKey: ['classes'],
    queryFn: () => api<ClassSummary[]>('/academic/classes'),
  });
}

export function useCurrentStructure() {
  const { me } = useAuth();
  const yearId = me?.activeSchool?.currentYear?.id;
  return useQuery({
    queryKey: ['structure', yearId],
    queryFn: () => api<YearStructure>(`/academic/years/${yearId}/structure`),
    enabled: !!yearId,
  });
}

export interface MyClassSubjects {
  classSubjects: {
    id: string;
    classId: string;
    className: string;
    subjectId: string;
    subjectName: string;
    coefficient: number;
    teacherId: string | null;
  }[];
  sequences: { id: string; name: string; order: number; termId: string; termName: string }[];
}

export function useMyClassSubjects() {
  return useQuery({
    queryKey: ['my-class-subjects'],
    queryFn: () => api<MyClassSubjects>('/grades/class-subjects'),
  });
}
