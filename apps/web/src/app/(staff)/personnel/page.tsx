'use client';

import { ROLE_LABELS, STAFF_ROLES } from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { Checkbox, InputField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Me } from '@/lib/types';

interface StaffRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  mfaEnabled: boolean;
  roles: Me['roles'];
  active: boolean;
}

export default function StaffPage() {
  const { can, me } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const q = useQuery({ queryKey: ['staff'], queryFn: () => api<StaffRow[]>('/staff') });
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/staff', { method: 'POST', body }),
    onSuccess: () => {
      setOpen(false);
      setErrors({});
      toast('Compte créé. Transmettez le mot de passe provisoire en main propre.');
      void queryClient.invalidateQueries({ queryKey: ['staff'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fieldErrors.length)
        setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.path, f.message])));
      toast(e instanceof Error ? e.message : 'Erreur', 'error');
    },
  });
  const deactivate = useMutation({
    mutationFn: (id: string) => api(`/staff/${id}/deactivate`, { method: 'POST' }),
    onSuccess: () => {
      toast('Accès désactivé');
      void queryClient.invalidateQueries({ queryKey: ['staff'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });

  return (
    <>
      <PageHeader
        title="Personnel"
        actions={
          can('staff.write') ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="size-4" aria-hidden />
              Ajouter
            </Button>
          ) : undefined
        }
      />
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} />
      ) : (
        <ul className="grid gap-2 md:grid-cols-2">
          {q.data.map((u) => (
            <li key={u.id}>
              <Card className="flex flex-col gap-2 p-3 lg:p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col">
                    <strong className="truncate">
                      {u.lastName} {u.firstName}
                    </strong>
                    <span className="truncate text-[13px] text-muted">{u.email}</span>
                  </div>
                  {!u.active ? (
                    <Badge tone="danger">Désactivé</Badge>
                  ) : u.mfaEnabled ? (
                    <Badge tone="success">Double authentification</Badge>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {u.roles.map((r) => (
                    <Badge key={r} tone="info">
                      {ROLE_LABELS[r]}
                    </Badge>
                  ))}
                </div>
                {can('staff.write') && u.active && u.id !== me?.user.id ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="self-start text-danger"
                    onClick={() => deactivate.mutate(u.id)}
                  >
                    Désactiver l’accès
                  </Button>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Sheet open={open} onClose={() => setOpen(false)} title="Nouveau membre du personnel">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            create.mutate({
              firstName: fd.get('firstName'),
              lastName: fd.get('lastName'),
              email: fd.get('email'),
              phone: fd.get('phone') || undefined,
              password: fd.get('password'),
              roles: fd.getAll('roles'),
              maxWeeklyHours: fd.get('maxWeeklyHours')
                ? Number(fd.get('maxWeeklyHours'))
                : undefined,
            });
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <InputField label="Prénom" name="firstName" required error={errors.firstName} />
            <InputField label="Nom" name="lastName" required error={errors.lastName} />
          </div>
          <InputField
            label="Adresse e-mail"
            name="email"
            type="email"
            required
            error={errors.email}
          />
          <InputField label="Téléphone" name="phone" type="tel" optional error={errors.phone} />
          <InputField
            label="Mot de passe provisoire"
            name="password"
            type="text"
            minLength={10}
            required
            hint="10 caractères minimum."
            error={errors.password}
          />
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-semibold">Rôles</legend>
            {STAFF_ROLES.map((r) => (
              <Checkbox key={r} name="roles" value={r} label={ROLE_LABELS[r]} />
            ))}
            {errors.roles ? <span className="text-[13px] text-danger">{errors.roles}</span> : null}
          </fieldset>
          <InputField
            label="Charge horaire maximale (heures par semaine)"
            name="maxWeeklyHours"
            type="number"
            inputMode="numeric"
            min={1}
            max={60}
            optional
          />
          <Button type="submit" loading={create.isPending}>
            Créer le compte
          </Button>
        </form>
      </Sheet>
    </>
  );
}
