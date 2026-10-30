'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth';

export interface ExamSessionSummary {
  id: string;
  name: string;
  kind: 'MOCK' | 'SEQUENCE' | 'PROMOTION';
  kindLabel: string;
  startDate: string;
  endDate: string;
  classes: { id: string; name: string }[];
  papers: number;
  candidates: number;
  rooms: number;
  published: boolean;
}

export interface ExamSupervisor {
  id: string;
  userId: string;
  name: string;
}

export interface ExamPaperDetail {
  id: string;
  subjectId: string;
  subjectName: string;
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  maxScore: number;
  classes: { id: string; name: string }[];
  scores: number;
  expected: number;
  rooms: { id: string; name: string; supervisors: ExamSupervisor[] }[];
}

export interface ExamSessionDetail {
  id: string;
  name: string;
  kind: ExamSessionSummary['kind'];
  kindLabel: string;
  startDate: string;
  endDate: string;
  mixClasses: boolean;
  supervisorsPerRoom: number;
  sequence: { id: string; name: string } | null;
  published: boolean;
  publishedAt: string | null;
  transferred: number;
  classes: { id: string; name: string; candidates: number }[];
  candidates: number;
  seated: number;
  rooms: { id: string; name: string; capacity: number; seated: number }[];
  papers: ExamPaperDetail[];
  conflicts: { kind: 'class' | 'room' | 'supervisor'; message: string }[];
}

export interface SeatingCandidate {
  id: string;
  seat: number | null;
  studentId: string;
  name: string;
  matricule: string;
  classId: string;
  className: string;
}

export interface Seating {
  rooms: { id: string; name: string; capacity: number; candidates: SeatingCandidate[] }[];
  unseated: SeatingCandidate[];
}

export interface ExamResults {
  published: boolean;
  papers: { id: string; subjectName: string; maxScore: number; classIds: string[] }[];
  missing: number;
  rows: {
    candidateId: string;
    code: string | null;
    name: string | null;
    matricule: string | null;
    classId: string;
    className: string;
    averageCenti: number | null;
    incomplete: boolean;
    rank: string | null;
    appreciation: string | null;
    scores: { paperId: string; value: string }[];
  }[];
}

export interface MySupervisions {
  today: string;
  supervisions: {
    id: string;
    sessionId: string;
    sessionName: string;
    paperId: string;
    subjectName: string;
    date: string;
    startTime: string;
    endTime: string;
    roomId: string;
    roomName: string;
  }[];
}

export interface ChildExamResult {
  sessionId: string;
  name: string;
  kindLabel: string;
  publishedAt: string;
  averageCenti: number | null;
  rank: string | null;
  appreciation: string | null;
  papers: { paperId: string; subjectName: string; maxScore: number; value: string }[];
}

export function useExamSession(id: string) {
  return useQuery({
    queryKey: ['exam-session', id],
    queryFn: () => api<ExamSessionDetail>(`/exams/sessions/${id}`),
  });
}

/** Surveillances à venir de l'enseignant, si le module Examens est activé. */
export function useMySupervisions() {
  const { me, can } = useAuth();
  const enabled = !!me?.activeSchool?.modules.includes('exams') && can('exams.read');
  return useQuery({
    queryKey: ['my-supervisions'],
    queryFn: () => api<MySupervisions>('/exams/my-supervisions'),
    enabled,
  });
}

/** Résultats d'examen publiés d'un enfant (portail). Vide si l'école n'a pas le module. */
export function useChildExams(id: string | undefined) {
  return useQuery({
    queryKey: ['portal-child-exams', id],
    queryFn: () => api<ChildExamResult[]>(`/portal/children/${id}/exams`),
    enabled: !!id,
    retry: false,
  });
}
