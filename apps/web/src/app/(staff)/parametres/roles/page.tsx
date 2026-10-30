'use client';

import {
  PERMISSION_GROUPS,
  PERMISSION_LABELS,
  resolveAccess,
  type Permission,
  type StaffRole,
} from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Eye, Lock, Plus, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { Checkbox, InputField, TextareaField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { visibleNav } from '@/lib/nav';
import type { Me } from '@/lib/types';

interface BuiltinRole {
  key: StaffRole;
  name: string;
  permissions: Permission[];
  defaults: Permission[];
  customized: boolean;
  locked: Permission[];
  classScoped: boolean;
  lineScoped: boolean;
  adminAccess: boolean;
  members: number;
}

interface CustomRole {
  id: string;
  name: string;
  description: string | null;
  permissions: Permission[];
  classScoped: boolean;
  lineScoped: boolean;
  adminAccess: boolean;
  members: number;
}

interface RolesResponse {
  builtin: BuiltinRole[];
  custom: CustomRole[];
}

type Editing = { kind: 'builtin'; role: BuiltinRole } | { kind: 'custom'; role: CustomRole | null };

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

function RoleCard({
  name,
  description,
  badges,
  members,
  permissions,
  onEdit,
  canEdit,
}: {
  name: string;
  description?: string | null;
  badges: React.ReactNode;
  members: number;
  permissions: number;
  onEdit: () => void;
  canEdit: boolean;
}) {
  return (
    <Card className="flex h-full flex-col gap-2 p-3 lg:p-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="font-bold [overflow-wrap:anywhere]">{name}</h3>
        {description ? (
          <p className="text-[13px] text-muted [overflow-wrap:anywhere]">{description}</p>
        ) : null}
        <p className="text-[13px] text-muted">
          {plural(members, 'personne')} · {plural(permissions, 'droit')}
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">{badges}</div>
      <Button
        variant="secondary"
        size="sm"
        className="mt-auto self-start"
        onClick={onEdit}
        aria-label={canEdit ? `Modifier le rôle ${name}` : `Voir les droits du rôle ${name}`}
      >
        {canEdit ? 'Modifier' : 'Voir les droits'}
      </Button>
    </Card>
  );
}

function ScopeBadges({ classScoped, lineScoped }: { classScoped: boolean; lineScoped: boolean }) {
  return (
    <>
      {classScoped ? <Badge tone="info">Limité à ses classes</Badge> : null}
      {lineScoped ? <Badge tone="info">Limité à ses lignes</Badge> : null}
    </>
  );
}

/** Aperçu du menu d'une personne ayant ce rôle, calculé comme pour la navigation réelle. */
function Preview({
  me,
  permissions,
  builtin,
  classScoped,
  lineScoped,
}: {
  me: Me;
  permissions: Permission[];
  builtin?: StaffRole;
  classScoped: boolean;
  lineScoped: boolean;
}) {
  const fake: Me = {
    ...me,
    user: { ...me.user, isPlatformAdmin: false },
    roles: builtin ? [builtin] : [],
    customRoles: [],
    permissions,
    scopes: { classes: classScoped, lines: lineScoped },
  };
  const groups = visibleNav(fake);
  const access = resolveAccess([{ permissions, classScoped, lineScoped, builtin }]);
  return (
    <section
      aria-labelledby="apercu-titre"
      className="flex flex-col gap-2 rounded-[12px] bg-paper p-3"
    >
      <h3 id="apercu-titre" className="flex items-center gap-2 text-sm font-bold">
        <Eye className="size-4" aria-hidden />
        Aperçu : ce que verra une personne ayant ce rôle
      </h3>
      {groups.length === 0 ? (
        <p className="text-[13px] text-muted">Aucun écran accessible avec ces droits.</p>
      ) : (
        <ul className="flex flex-col gap-1.5" data-testid="apercu-menu">
          {groups.map((g) => (
            <li key={g.label} className="text-[13px]">
              <span className="font-semibold">{g.label} : </span>
              {g.items.map((i) => i.label).join(', ')}
            </li>
          ))}
        </ul>
      )}
      <ul className="flex flex-col gap-1 text-[13px] text-muted">
        {classScoped ? <li>Ne voit que ses classes et ses élèves.</li> : null}
        {lineScoped ? <li>Ne fait l’appel que sur ses lignes de transport.</li> : null}
        {access.requiresMfa ? (
          <li className="flex items-center gap-1.5 text-ink">
            <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden />
            Droits administratifs : double authentification exigée si l’école l’impose.
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function PermissionPicker({
  selected,
  locked,
  defaults,
  disabled,
  onToggle,
}: {
  selected: Set<Permission>;
  locked: Permission[];
  defaults?: Permission[];
  disabled: boolean;
  onToggle: (p: Permission, on: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {PERMISSION_GROUPS.map((g) => {
        const count = g.permissions.filter((p) => selected.has(p)).length;
        return (
          <details
            key={g.key}
            className="group rounded-[12px] border border-line"
            open={count > 0 || undefined}
          >
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 font-semibold [&::-webkit-details-marker]:hidden">
              <span className="[overflow-wrap:anywhere]">{g.label}</span>
              <span className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-muted">
                  {count}/{g.permissions.length}
                </span>
                <ChevronDown
                  className="size-4 transition-transform group-open:rotate-180"
                  aria-hidden
                />
              </span>
            </summary>
            <fieldset className="flex flex-col gap-0.5 border-t border-line px-3 py-2">
              <legend className="sr-only">{g.label}</legend>
              {g.permissions.map((p) => {
                const isLocked = locked.includes(p);
                const changed = defaults && defaults.includes(p) !== selected.has(p);
                return (
                  <Checkbox
                    key={p}
                    name="permissions"
                    value={p}
                    checked={selected.has(p)}
                    disabled={disabled || isLocked}
                    onChange={(e) => onToggle(p, e.currentTarget.checked)}
                    label={
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span>{PERMISSION_LABELS[p]}</span>
                        {isLocked ? (
                          <span className="inline-flex items-center gap-1 text-[13px] text-muted">
                            <Lock className="size-3.5" aria-hidden />
                            toujours accordé à la direction
                          </span>
                        ) : changed ? (
                          <span className="text-[13px] font-semibold text-warn">
                            {selected.has(p) ? 'ajouté' : 'retiré'}
                          </span>
                        ) : null}
                      </span>
                    }
                  />
                );
              })}
            </fieldset>
          </details>
        );
      })}
    </div>
  );
}

function RoleEditor({
  editing,
  canEdit,
  onClose,
}: {
  editing: Editing;
  canEdit: boolean;
  onClose: () => void;
}) {
  const { me, reload } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const initial =
    editing.kind === 'builtin' ? editing.role.permissions : (editing.role?.permissions ?? []);
  const [selected, setSelected] = useState(() => new Set<Permission>(initial));
  const [classScoped, setClassScoped] = useState(
    editing.kind === 'custom' ? !!editing.role?.classScoped : editing.role.classScoped,
  );
  const [lineScoped, setLineScoped] = useState(
    editing.kind === 'custom' ? !!editing.role?.lineScoped : editing.role.lineScoped,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const done = (message: string) => {
    toast(message);
    void queryClient.invalidateQueries({ queryKey: ['roles'] });
    // Mes propres droits ont pu changer : le menu suit ce que l'API autorise.
    void reload().catch(() => undefined);
    onClose();
  };
  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.fieldErrors.length)
      setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.path, f.message])));
    toast(e instanceof Error ? e.message : 'Erreur', 'error');
  };

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      editing.kind === 'builtin'
        ? api(`/roles/builtin/${editing.role.key}`, {
            method: 'PUT',
            body: { permissions: body.permissions },
          })
        : editing.role
          ? api(`/roles/custom/${editing.role.id}`, { method: 'PUT', body })
          : api('/roles/custom', { method: 'POST', body }),
    onSuccess: () =>
      done(editing.kind === 'custom' && !editing.role ? 'Rôle créé' : 'Rôle enregistré'),
    onError: fail,
  });
  const reset = useMutation({
    mutationFn: (role: StaffRole) => api(`/roles/builtin/${role}/reset`, { method: 'POST' }),
    onSuccess: () => done('Valeurs par défaut rétablies'),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/roles/custom/${id}`, { method: 'DELETE' }),
    onSuccess: () => done('Rôle supprimé'),
    onError: fail,
  });

  if (!me) return null;
  const permissions = [...selected];
  const title =
    editing.kind === 'builtin' ? editing.role.name : (editing.role?.name ?? 'Nouveau rôle');
  const formId = 'role-form';

  return (
    <Sheet
      open
      onClose={onClose}
      title={title}
      footer={
        canEdit ? (
          <div className="flex flex-col gap-2 sm:flex-row-reverse sm:justify-between">
            <Button type="submit" form={formId} loading={save.isPending}>
              Enregistrer
            </Button>
            {editing.kind === 'builtin' && editing.role.customized ? (
              <Button
                variant="secondary"
                loading={reset.isPending}
                onClick={() => reset.mutate(editing.role.key)}
              >
                Rétablir les valeurs par défaut
              </Button>
            ) : null}
            {editing.kind === 'custom' && editing.role ? (
              <Button
                variant="danger"
                loading={remove.isPending}
                onClick={() => {
                  if (
                    editing.role &&
                    window.confirm(`Supprimer le rôle « ${editing.role.name} » ?`)
                  )
                    remove.mutate(editing.role.id);
                }}
              >
                Supprimer le rôle
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setErrors({});
          const fd = new FormData(e.currentTarget);
          save.mutate({
            name: String(fd.get('name') ?? ''),
            description: String(fd.get('description') ?? '') || undefined,
            permissions,
            classScoped,
            lineScoped,
          });
        }}
      >
        {editing.kind === 'custom' ? (
          <>
            <InputField
              label="Nom du rôle"
              name="name"
              required
              minLength={2}
              maxLength={60}
              defaultValue={editing.role?.name ?? ''}
              error={errors.name}
              disabled={!canEdit}
            />
            <TextareaField
              label="Description"
              name="description"
              optional
              maxLength={200}
              defaultValue={editing.role?.description ?? ''}
              error={errors.description}
              disabled={!canEdit}
            />
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-sm font-semibold">Limites de périmètre</legend>
              <Checkbox
                name="classScoped"
                checked={classScoped}
                disabled={!canEdit}
                onChange={(e) => setClassScoped(e.currentTarget.checked)}
                label="Limité à ses classes (comme un enseignant)"
              />
              <Checkbox
                name="lineScoped"
                checked={lineScoped}
                disabled={!canEdit}
                onChange={(e) => setLineScoped(e.currentTarget.checked)}
                label="Limité à ses lignes de transport (comme un chauffeur)"
              />
            </fieldset>
          </>
        ) : (
          <p className="text-sm text-muted">
            {editing.role.classScoped
              ? 'Rôle limité aux classes de la personne. '
              : editing.role.lineScoped
                ? 'Rôle limité aux lignes de transport de la personne. '
                : ''}
            Les cases cochées par défaut sont celles prévues pour toutes les écoles ; vos
            adaptations ne concernent que votre établissement.
          </p>
        )}
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Droits accordés</h3>
          {errors.permissions ? (
            <span className="text-[13px] font-medium text-danger" role="alert">
              {errors.permissions}
            </span>
          ) : null}
          <PermissionPicker
            selected={selected}
            locked={editing.kind === 'builtin' ? editing.role.locked : []}
            defaults={editing.kind === 'builtin' ? editing.role.defaults : undefined}
            disabled={!canEdit}
            onToggle={(p, on) =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (on) next.add(p);
                else next.delete(p);
                return next;
              })
            }
          />
        </div>
        <Preview
          me={me}
          permissions={permissions}
          builtin={editing.kind === 'builtin' ? editing.role.key : undefined}
          classScoped={classScoped}
          lineScoped={lineScoped}
        />
      </form>
    </Sheet>
  );
}

export default function RolesPage() {
  const { can } = useAuth();
  const canEdit = can('roles.manage');
  const [editing, setEditing] = useState<Editing | null>(null);
  const q = useQuery({ queryKey: ['roles'], queryFn: () => api<RolesResponse>('/roles') });

  return (
    <>
      <PageHeader
        title="Rôles et droits"
        subtitle="Adaptez les droits de chaque rôle pour votre établissement. Chaque modification est journalisée."
        actions={
          canEdit ? (
            <Button onClick={() => setEditing({ kind: 'custom', role: null })}>
              <Plus className="size-4" aria-hidden />
              Nouveau rôle
            </Button>
          ) : undefined
        }
      />
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} />
      ) : (
        <>
          <section aria-labelledby="roles-ecole" className="flex flex-col gap-2">
            <h2 id="roles-ecole" className="text-base font-bold lg:text-[17px]">
              Rôles propres à l’école
            </h2>
            {q.data.custom.length === 0 ? (
              <EmptyState title="Aucun rôle propre pour l’instant">
                Créez un rôle (bibliothécaire, intendant…) avec exactement les droits utiles, puis
                attribuez-le depuis l’écran du personnel.
              </EmptyState>
            ) : (
              <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {q.data.custom.map((r) => (
                  <li key={r.id}>
                    <RoleCard
                      name={r.name}
                      description={r.description}
                      members={r.members}
                      permissions={r.permissions.length}
                      canEdit={canEdit}
                      onEdit={() => setEditing({ kind: 'custom', role: r })}
                      badges={
                        <>
                          <ScopeBadges classScoped={r.classScoped} lineScoped={r.lineScoped} />
                          {r.adminAccess ? (
                            <Badge tone="saffron">Droits administratifs</Badge>
                          ) : null}
                        </>
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="roles-integres" className="flex flex-col gap-2">
            <h2 id="roles-integres" className="text-base font-bold lg:text-[17px]">
              Rôles intégrés
            </h2>
            <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {q.data.builtin.map((r) => (
                <li key={r.key}>
                  <RoleCard
                    name={r.name}
                    members={r.members}
                    permissions={r.permissions.length}
                    canEdit={canEdit}
                    onEdit={() => setEditing({ kind: 'builtin', role: r })}
                    badges={
                      <>
                        {r.customized ? (
                          <Badge tone="warn">Adapté pour l’école</Badge>
                        ) : (
                          <Badge>Valeurs par défaut</Badge>
                        )}
                        <ScopeBadges classScoped={r.classScoped} lineScoped={r.lineScoped} />
                        {r.adminAccess ? <Badge tone="saffron">Droits administratifs</Badge> : null}
                      </>
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
      {editing ? (
        <RoleEditor
          key={editing.kind === 'builtin' ? editing.role.key : (editing.role?.id ?? 'new')}
          editing={editing}
          canEdit={canEdit}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}
