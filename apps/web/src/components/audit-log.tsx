'use client';

import { AUDIT_CATEGORIES, auditActionLabel } from '@ecole/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, ErrorBlock, LoadingBlock } from '@/components/ui/card';
import { InputField, SelectField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { formatDateTime, plural } from '@/lib/format';

type Person = { id: string; firstName: string; lastName: string };

interface AuditPage {
  total: number;
  page: number;
  pages: number;
  items: {
    id: string;
    action: string;
    label?: string;
    entity: string;
    createdAt: string;
    reason: string | null;
    actor: Person | null;
  }[];
}

const PAGE_SIZE = 50;

/** Journal d'audit : filtres (période, personne, type d'action), pages et libellés en français. */
export function AuditLogCard() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [actorId, setActorId] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const filters = new URLSearchParams({
    pageSize: String(PAGE_SIZE),
    page: String(page),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(actorId ? { actorId } : {}),
    ...(category ? { action: category } : {}),
  }).toString();
  const q = useQuery({
    queryKey: ['audit', filters],
    queryFn: () => api<AuditPage>(`/audit-logs?${filters}`),
    placeholderData: keepPreviousData,
  });
  const actors = useQuery({
    queryKey: ['audit-actors'],
    queryFn: () => api<Person[]>('/audit-logs/actors'),
  });
  // Tout changement de filtre repart de la première page.
  const filter =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPage(1);
    };
  const filtered = !!(from || to || actorId || category);

  return (
    <Card id="audit">
      <CardHeader
        title="Journal d’audit"
        subtitle={
          q.data
            ? `${plural(q.data.total, 'action enregistrée', 'actions enregistrées')}${filtered ? ' pour ces filtres' : ''}`
            : undefined
        }
      />
      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <InputField
          label="Du"
          type="date"
          value={from}
          max={to || undefined}
          onChange={(e) => filter(setFrom)(e.target.value)}
        />
        <InputField
          label="Au"
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => filter(setTo)(e.target.value)}
        />
        <SelectField
          label="Personne"
          value={actorId}
          onChange={(e) => filter(setActorId)(e.target.value)}
        >
          <option value="">Tout le monde</option>
          {actors.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.lastName} {a.firstName}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Type d’action"
          value={category}
          onChange={(e) => filter(setCategory)(e.target.value)}
        >
          <option value="">Toutes les actions</option>
          {AUDIT_CATEGORIES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
      </div>
      {filtered ? (
        <Button
          variant="ghost"
          size="sm"
          className="mb-2"
          onClick={() => {
            setFrom('');
            setTo('');
            setActorId('');
            setCategory('');
            setPage(1);
          }}
        >
          Effacer les filtres
        </Button>
      ) : null}
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <p className="text-sm text-muted">Aucune action pour ces filtres.</p>
      ) : (
        <>
          <ol className="flex flex-col" aria-label="Actions enregistrées">
            {q.data.items.map((a) => (
              <li
                key={a.id}
                className="flex flex-col gap-0.5 border-t border-line py-2 text-sm first:border-t-0 sm:flex-row sm:gap-3"
              >
                <span className="w-36 shrink-0 text-muted tabular">
                  {formatDateTime(a.createdAt)}
                </span>
                <span className="flex-1 [overflow-wrap:anywhere]">
                  <strong className="font-semibold">
                    {a.actor ? `${a.actor.lastName} ${a.actor.firstName}` : 'Système'}
                  </strong>{' '}
                  · {a.label ?? auditActionLabel(a.action)}
                  {a.reason ? <span className="text-muted"> · motif : {a.reason}</span> : null}
                </span>
              </li>
            ))}
          </ol>
          {q.data.pages > 1 ? (
            <nav
              aria-label="Pages du journal d’audit"
              className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3"
            >
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Précédentes
              </Button>
              <span className="text-sm text-muted tabular" aria-live="polite">
                Page {q.data.page} sur {q.data.pages}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= q.data.pages}
                onClick={() => setPage((p) => p + 1)}
              >
                Suivantes
              </Button>
            </nav>
          ) : null}
        </>
      )}
    </Card>
  );
}
