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
  customRoleIds?: string[];
  active: boolean;
}

interface RoleChoices {
  custom: { id: string; name: string }[];
}

/** Cases à cocher des rôles intégrés et des rôles propres à l'école. */
function RoleFields({
  custom,
  roles = [],
  customRoleIds = [],
  error,
}: {
  custom: RoleChoices['custom'];
  roles?: string[];
  customRoleIds?: string[];
  error?: string;
}) {
  return (
    <>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-semibold">Rôles</legend>
        {STAFF_ROLES.map((r) => (
          <Checkbox
            key={r}
            name="roles"
            value={r}
            label={ROLE_LABELS[r]}
            defaultChecked={roles.includes(r)}
          />
        ))}
        {error ? <span className="text-[13px] text-danger">{error}</span> : null}
      </fieldset>
      {custom.length > 0 ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-semibold">Rôles propres à l’école</legend>
          {custom.map((r) => (
            <Checkbox
              key={r.id}
              name="customRoleIds"
              value={r.id}
              label={r.name}
              defaultChecked={customRoleIds.includes(r.id)}
            />
          ))}
        </fieldset>
      ) : null}
    </>
  );
}

export default function StaffPage() {
  const { can, me } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const q = useQuery({ queryKey: ['staff'], queryFn: () => api<StaffRow[]>('/staff') });
  const invitations = useQuery({
    queryKey: ['staff', 'invitations'],
    queryFn: () =>
      api<{ id: string; email: string | null; roles: StaffRow['roles'] }[]>('/staff/invitations'),
  });
  const cancelInvitation = useMutation({
    mutationFn: (id: string) => api(`/staff/invitations/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      toast('Invitation annulée');
      void queryClient.invalidateQueries({ queryKey: ['staff'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const rolesQ = useQuery({ queryKey: ['roles'], queryFn: () => api<RoleChoices>('/roles') });
  const custom = rolesQ.data?.custom ?? [];
  const customName = new Map(custom.map((r) => [r.id, r.name]));
  const setRoles = useMutation({
    mutationFn: ({ id, ...body }: { id: string; roles: unknown[]; customRoleIds: unknown[] }) =>
      api(`/staff/${id}/roles`, { method: 'PATCH', body }),
    onSuccess: () => {
      setEditing(null);
      toast('Rôles mis à jour');
      void queryClient.invalidateQueries({ queryKey: ['staff'] });
      void queryClient.invalidateQueries({ queryKey: ['roles'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ status: 'CREATED' | 'INVITED' }>('/staff', { method: 'POST', body }),
    onSuccess: (r) => {
      setOpen(false);
      setErrors({});
      toast(
        r.status === 'INVITED'
          ? 'Cette adresse a déjà un compte : une invitation lui sera proposée à sa prochaine connexion.'
          : 'Compte créé. Transmettez le mot de passe provisoire en main propre.',
      );
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
                  {(u.customRoleIds ?? []).map((id) =>
                    customName.has(id) ? (
                      <Badge key={id} tone="success">
                        {customName.get(id)}
                      </Badge>
                    ) : null,
                  )}
                </div>
                {can('staff.write') && u.active ? (
                  <div className="flex flex-wrap gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(u)}
                      aria-label={`Modifier les rôles de ${u.firstName} ${u.lastName}`}
                    >
                      Modifier les rôles
                    </Button>
                    {u.id !== me?.user.id ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger"
                        onClick={() => deactivate.mutate(u.id)}
                      >
                        Désactiver l’accès
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {invitations.data && invitations.data.length > 0 ? (
        <section aria-labelledby="invitations-titre" className="flex flex-col gap-2">
          <h2 id="invitations-titre" className="text-base font-bold">
            Invitations en attente
          </h2>
          <ul className="grid gap-2 md:grid-cols-2" aria-label="Invitations en attente">
            {invitations.data.map((i) => (
              <li key={i.id}>
                <Card className="flex flex-col gap-2 p-3 lg:p-4">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 truncate font-semibold">{i.email}</span>
                    <Badge tone="warn">En attente</Badge>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {i.roles.map((r) => (
                      <Badge key={r} tone="info">
                        {ROLE_LABELS[r]}
                      </Badge>
                    ))}
                  </div>
                  {can('staff.write') ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="self-start text-danger"
                      onClick={() => cancelInvitation.mutate(i.id)}
                      aria-label={`Annuler l’invitation de ${i.email ?? 'cette personne'}`}
                    >
                      Annuler l’invitation
                    </Button>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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
              customRoleIds: fd.getAll('customRoleIds'),
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
            hint="10 caractères minimum. Si l’adresse a déjà un compte, une invitation lui est proposée à la place."
            error={errors.password}
          />
          <RoleFields custom={custom} error={errors.roles} />
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
      <Sheet
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing ? `Rôles de ${editing.firstName} ${editing.lastName}` : 'Rôles'}
      >
        {editing ? (
          <form
            key={editing.id}
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              setRoles.mutate({
                id: editing.id,
                roles: fd.getAll('roles'),
                customRoleIds: fd.getAll('customRoleIds'),
              });
            }}
          >
            <RoleFields
              custom={custom}
              roles={editing.roles}
              customRoleIds={editing.customRoleIds}
            />
            <p className="text-[13px] text-muted">
              Les droits de chaque rôle se règlent dans Paramètres, Rôles et droits. Les changements
              s’appliquent dès la prochaine action de la personne.
            </p>
            <Button type="submit" loading={setRoles.isPending}>
              Enregistrer les rôles
            </Button>
          </form>
        ) : null}
      </Sheet>
    </>
  );
}
