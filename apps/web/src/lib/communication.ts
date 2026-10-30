'use client';

import { useQuery } from '@tanstack/react-query';
import type { EVENT_CATEGORIES, EVENT_SCOPES } from '@ecole/shared';
import { api } from './api';
import { useAuth } from './auth';

interface Person {
  id: string;
  firstName: string;
  lastName: string;
}

export interface ThreadSummary {
  id: string;
  student: Person & { className: string | null };
  guardian: Person & { relationship: 'FATHER' | 'MOTHER' | 'TUTOR' | 'OTHER' | null };
  staff: Person & { labels: string[] };
  school: { id: string; name: string };
  lastMessage: { body: string; authorKind: 'STAFF' | 'PARENT'; createdAt: string } | null;
  lastMessageAt: string;
  unread: number;
}

export interface ChatMessage {
  id: string;
  authorKind: 'STAFF' | 'PARENT';
  authorName: string;
  body: string;
  createdAt: string;
  mine: boolean;
}

export interface ThreadDetail extends ThreadSummary {
  messages: ChatMessage[];
}

export interface SchoolEvent {
  id: string;
  title: string;
  description: string | null;
  category: (typeof EVENT_CATEGORIES)[number];
  categoryLabel: string;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  scope: (typeof EVENT_SCOPES)[number];
  targetId: string | null;
  targetName: string;
  remindBySms: boolean;
  reminderSent: boolean;
}

export const RELATION_LABELS = {
  FATHER: 'Père',
  MOTHER: 'Mère',
  TUTOR: 'Tuteur',
  OTHER: 'Parent',
} as const;

/** Rafraîchissement régulier des non-lus et des fils ouverts (pas de temps réel). */
export const MESSAGES_REFRESH_MS = 30_000;

/** Nombre de messages non lus du membre du personnel (badge du menu). */
export function useStaffUnread() {
  const { me } = useAuth();
  const enabled =
    me?.kind === 'staff' &&
    me.permissions.includes('messaging.use') &&
    !!me.activeSchool?.modules.includes('communication');
  return useQuery({
    queryKey: ['messages-unread'],
    queryFn: () => api<{ count: number }>('/messages/unread'),
    enabled,
    refetchInterval: MESSAGES_REFRESH_MS,
  });
}

/** Nombre de messages non lus du parent, tous enfants confondus. */
export function useParentUnread() {
  const { me } = useAuth();
  return useQuery({
    queryKey: ['portal-messages-unread'],
    queryFn: () => api<{ count: number }>('/portal/messages/unread'),
    enabled: me?.kind === 'parent',
    refetchInterval: MESSAGES_REFRESH_MS,
  });
}
