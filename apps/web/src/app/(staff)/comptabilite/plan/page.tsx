'use client';

import { ACCOUNT_CLASS_LABELS } from '@ecole/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
} from '@/components/ui/card';
import { InputField, SelectField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { useAccounts } from '@/lib/accounting';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

export default function ChartPage() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [parent, setParent] = useState('');
  const create = useMutation({
    mutationFn: (body: { parentNumber: string; number: string; label: string }) =>
      api('/accounting/accounts', { method: 'POST', body }),
    onSuccess: () => {
      setAdding(false);
      toast('Sous-compte ajouté');
      void queryClient.invalidateQueries({ queryKey: ['accounting', 'accounts'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const term = search.trim().toLowerCase();
  const list = (accounts.data ?? []).filter(
    (a) => !term || a.number.startsWith(term) || a.label.toLowerCase().includes(term),
  );
  const classes = [...new Set(list.map((a) => a.class))].sort();

  return (
    <>
      <PageHeader
        title="Plan comptable"
        subtitle="SYSCOHADA révisé, complété par les sous-comptes de l’école"
        actions={
          can('accounting.write') ? (
            <Button onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden />
              Ajouter un sous-compte
            </Button>
          ) : null
        }
      />
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Numéro ou intitulé du compte"
          aria-label="Rechercher un compte"
          className="h-12 w-full rounded-[10px] border border-line-strong bg-white pr-3 pl-10 text-base lg:h-10 lg:text-sm"
        />
      </div>
      {accounts.isPending ? (
        <LoadingBlock />
      ) : accounts.isError ? (
        <ErrorBlock error={accounts.error} onRetry={() => accounts.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState title="Aucun compte ne correspond" />
      ) : (
        classes.map((c) => (
          <Card key={c}>
            <CardHeader title={`Classe ${c} · ${ACCOUNT_CLASS_LABELS[c] ?? ''}`} />
            <ul className="flex flex-col divide-y divide-line">
              {list
                .filter((a) => a.class === c)
                .map((a) => (
                  <li
                    key={a.number}
                    className={cn(
                      'flex items-baseline gap-3 py-2',
                      a.number.length === 2 && 'font-bold',
                    )}
                    style={{ paddingLeft: `${Math.min(a.number.length - 2, 4) * 12}px` }}
                  >
                    <span className="w-16 shrink-0 tabular">{a.number}</span>
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{a.label}</span>
                    {!a.isSystem ? <Badge tone="info">École</Badge> : null}
                  </li>
                ))}
            </ul>
          </Card>
        ))
      )}
      <Sheet open={adding} onClose={() => setAdding(false)} title="Ajouter un sous-compte">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            create.mutate({
              parentNumber: parent,
              number: String(data.get('number')).trim(),
              label: String(data.get('label')).trim(),
            });
          }}
        >
          <SelectField
            label="Compte parent"
            value={parent}
            onChange={(e) => setParent(e.target.value)}
            required
          >
            <option value="" disabled>
              Choisir un compte
            </option>
            {(accounts.data ?? [])
              .filter((a) => a.number.length >= 3)
              .map((a) => (
                <option key={a.number} value={a.number}>
                  {a.number} · {a.label}
                </option>
              ))}
          </SelectField>
          <InputField
            key={parent}
            label="Numéro du sous-compte"
            name="number"
            inputMode="numeric"
            required
            pattern="\d{3,10}"
            defaultValue={parent}
            hint={parent ? `Commence par ${parent}, par exemple ${parent}1` : undefined}
          />
          <InputField label="Intitulé" name="label" required minLength={2} maxLength={120} />
          <Button type="submit" loading={create.isPending}>
            Ajouter le compte
          </Button>
        </form>
      </Sheet>
    </>
  );
}
