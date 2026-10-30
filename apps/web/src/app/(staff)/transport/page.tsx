'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TRANSPORT_DIRECTION_LABELS,
  TRANSPORT_DIRECTIONS,
  VEHICLE_DOCUMENT_LABELS,
  type DocumentState,
  type TransportDirection,
  type VehicleDocument,
} from '@ecole/shared';
import { Bus, MapPin, Plus, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { CreditNoteSheet, type CreditNoteTarget } from '@/components/credit-note-sheet';
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
import { Checkbox, InputField, SelectField } from '@/components/ui/field';
import { PillTabs } from '@/components/ui/pill-tabs';
import { Sheet } from '@/components/ui/sheet';
import { StudentPicker, type PickedStudent } from '@/components/ui/student-picker';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatFcfa, formatShortDate } from '@/lib/format';

interface Alert {
  document: VehicleDocument;
  state: DocumentState;
  daysLeft: number | null;
}
interface Vehicle {
  id: string;
  plate: string;
  capacity: number;
  driverName: string | null;
  driverPhone: string | null;
  insuranceExpiresOn: string | null;
  inspectionExpiresOn: string | null;
  alerts: Alert[];
}
interface Stop {
  id: string;
  name: string;
  order: number;
  morningTime: string | null;
  eveningTime: string | null;
}
interface Line {
  id: string;
  name: string;
  fee: number;
  oneWayFee: number;
  active: boolean;
  vehicle: Vehicle | null;
  stops: Stop[];
  staff: { id: string; name: string }[];
  occupancy: { OUTBOUND: number; RETURN: number };
  capacity: number | null;
}
interface Subscription {
  id: string;
  status: 'ACTIVE' | 'CANCELLED';
  direction: TransportDirection;
  fee: number;
  invoiced: boolean;
  line: { id: string; name: string };
  stop: { id: string; name: string; morningTime: string | null; eveningTime: string | null };
  student: { id: string; firstName: string; lastName: string; matricule: string } | null;
  cancelReason: string | null;
}
interface StaffUser {
  id: string;
  firstName: string;
  lastName: string;
}

type Tab = 'lines' | 'subscriptions' | 'vehicles' | 'settings';
const TABS = [
  ['lines', 'Lignes'],
  ['subscriptions', 'Abonnés'],
  ['vehicles', 'Véhicules'],
  ['settings', 'Réglages'],
] as const;

function alertText(a: Alert): string {
  const doc = VEHICLE_DOCUMENT_LABELS[a.document];
  if (a.state === 'MISSING') return `${doc} : date non renseignée`;
  if (a.state === 'EXPIRED') return `${doc} expirée`;
  return a.daysLeft === 0 ? `${doc} : expire aujourd’hui` : `${doc} : expire dans ${a.daysLeft} j`;
}

function useErrors() {
  const toast = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const onError = (e: unknown) => {
    if (e instanceof ApiError && e.fieldErrors.length > 0)
      setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.path, f.message])));
    toast(e instanceof Error ? e.message : 'Erreur', 'error');
  };
  return { errors, setErrors, onError };
}

function VehicleSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { errors, setErrors, onError } = useErrors();
  const empty = {
    plate: '',
    capacity: '',
    driverName: '',
    driverPhone: '',
    insuranceExpiresOn: '',
    inspectionExpiresOn: '',
  };
  const [form, setForm] = useState(empty);
  const save = useMutation({
    mutationFn: () =>
      api('/transport/vehicles', {
        method: 'POST',
        body: {
          plate: form.plate,
          capacity: Number(form.capacity),
          driverName: form.driverName || null,
          driverPhone: form.driverPhone || null,
          insuranceExpiresOn: form.insuranceExpiresOn || null,
          inspectionExpiresOn: form.inspectionExpiresOn || null,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transport'] });
      toast('Véhicule enregistré');
      setForm(empty);
      setErrors({});
      onClose();
    },
    onError,
  });
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Nouveau véhicule"
      footer={
        <Button
          block
          onClick={() => save.mutate()}
          loading={save.isPending}
          disabled={!form.plate || !form.capacity}
        >
          Enregistrer le véhicule
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <InputField
          label="Immatriculation"
          value={form.plate}
          onChange={set('plate')}
          error={errors.plate}
          placeholder="CE 482 AB"
        />
        <InputField
          label="Nombre de places"
          type="number"
          inputMode="numeric"
          min={1}
          value={form.capacity}
          onChange={set('capacity')}
          error={errors.capacity}
        />
        <InputField
          label="Chauffeur"
          value={form.driverName}
          onChange={set('driverName')}
          optional
        />
        <InputField
          label="Téléphone du chauffeur"
          type="tel"
          value={form.driverPhone}
          onChange={set('driverPhone')}
          optional
        />
        <InputField
          label="Fin de l’assurance"
          type="date"
          value={form.insuranceExpiresOn}
          onChange={set('insuranceExpiresOn')}
          optional
        />
        <InputField
          label="Fin de la visite technique"
          type="date"
          value={form.inspectionExpiresOn}
          onChange={set('inspectionExpiresOn')}
          optional
        />
      </div>
    </Sheet>
  );
}

function LineSheet({
  open,
  onClose,
  vehicles,
}: {
  open: boolean;
  onClose: () => void;
  vehicles: Vehicle[];
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const { errors, setErrors, onError } = useErrors();
  const staff = useQuery({
    queryKey: ['transport', 'staff'],
    queryFn: () => api<StaffUser[]>('/transport/staff'),
    enabled: open,
  });
  const empty = { name: '', vehicleId: '', fee: '', oneWayFee: '', staffUserIds: [] as string[] };
  const [form, setForm] = useState(empty);
  const save = useMutation({
    mutationFn: () =>
      api('/transport/lines', {
        method: 'POST',
        body: {
          name: form.name,
          vehicleId: form.vehicleId || null,
          fee: Number(form.fee || 0),
          oneWayFee: Number(form.oneWayFee || 0),
          staffUserIds: form.staffUserIds,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transport'] });
      toast('Ligne créée');
      setForm(empty);
      setErrors({});
      onClose();
    },
    onError,
  });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Nouvelle ligne"
      footer={
        <Button block onClick={() => save.mutate()} loading={save.isPending} disabled={!form.name}>
          Créer la ligne
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <InputField
          label="Nom de la ligne"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          error={errors.name}
          placeholder="Ligne 2 – Mvog-Mbi"
        />
        <SelectField
          label="Véhicule"
          value={form.vehicleId}
          onChange={(e) => setForm({ ...form, vehicleId: e.target.value })}
        >
          <option value="">Aucun pour l’instant</option>
          {vehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.plate} · {v.capacity} places
            </option>
          ))}
        </SelectField>
        <div className="grid gap-4 sm:grid-cols-2">
          <InputField
            label="Tarif annuel aller et retour (FCFA)"
            type="number"
            inputMode="numeric"
            min={0}
            value={form.fee}
            onChange={(e) => setForm({ ...form, fee: e.target.value })}
            error={errors.fee}
          />
          <InputField
            label="Tarif annuel un seul sens (FCFA)"
            type="number"
            inputMode="numeric"
            min={0}
            value={form.oneWayFee}
            onChange={(e) => setForm({ ...form, oneWayFee: e.target.value })}
            error={errors.oneWayFee}
          />
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-semibold">Chauffeur et accompagnateurs</legend>
          {staff.data?.length === 0 ? (
            <p className="text-sm text-muted">
              Créez d’abord un compte « Chauffeur ou accompagnateur » dans Personnel.
            </p>
          ) : null}
          {staff.data?.map((u) => (
            <Checkbox
              key={u.id}
              label={`${u.lastName} ${u.firstName}`}
              checked={form.staffUserIds.includes(u.id)}
              onChange={(e) =>
                setForm({
                  ...form,
                  staffUserIds: e.target.checked
                    ? [...form.staffUserIds, u.id]
                    : form.staffUserIds.filter((x) => x !== u.id),
                })
              }
            />
          ))}
        </fieldset>
      </div>
    </Sheet>
  );
}

function StopSheet({ line, onClose }: { line: Line | null; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { errors, setErrors, onError } = useErrors();
  const [form, setForm] = useState({ name: '', morningTime: '', eveningTime: '' });
  const save = useMutation({
    mutationFn: () =>
      api(`/transport/lines/${line?.id}/stops`, {
        method: 'POST',
        body: {
          name: form.name,
          order: Math.max(0, ...(line?.stops.map((s) => s.order) ?? [])) + 1,
          morningTime: form.morningTime || null,
          eveningTime: form.eveningTime || null,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transport'] });
      toast('Arrêt ajouté');
      setForm({ name: '', morningTime: '', eveningTime: '' });
      setErrors({});
      onClose();
    },
    onError,
  });
  return (
    <Sheet
      open={!!line}
      onClose={onClose}
      title={`Ajouter un arrêt · ${line?.name ?? ''}`}
      footer={
        <Button block onClick={() => save.mutate()} loading={save.isPending} disabled={!form.name}>
          Ajouter l’arrêt en fin de ligne
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <InputField
          label="Nom de l’arrêt"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          error={errors.name}
          containerClassName="sm:col-span-2"
        />
        <InputField
          label="Passage du matin"
          type="time"
          value={form.morningTime}
          onChange={(e) => setForm({ ...form, morningTime: e.target.value })}
          error={errors.morningTime}
          optional
        />
        <InputField
          label="Passage du soir"
          type="time"
          value={form.eveningTime}
          onChange={(e) => setForm({ ...form, eveningTime: e.target.value })}
          error={errors.eveningTime}
          optional
        />
      </div>
    </Sheet>
  );
}

function SubscribeSheet({
  open,
  onClose,
  lines,
}: {
  open: boolean;
  onClose: () => void;
  lines: Line[];
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const { onError } = useErrors();
  const [student, setStudent] = useState<PickedStudent | null>(null);
  const [lineId, setLineId] = useState('');
  const [stopId, setStopId] = useState('');
  const [direction, setDirection] = useState<TransportDirection>('BOTH');
  const line = lines.find((l) => l.id === lineId);
  const fee = line ? (direction === 'BOTH' ? line.fee : line.oneWayFee) : 0;
  const save = useMutation({
    mutationFn: () =>
      api('/transport/subscriptions', {
        method: 'POST',
        body: { studentId: student?.id, lineId, stopId, direction },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transport'] });
      toast('Élève abonné ; le tarif est ajouté à son échéancier');
      setStudent(null);
      setStopId('');
      onClose();
    },
    onError,
  });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Abonner un élève"
      footer={
        <Button
          block
          onClick={() => save.mutate()}
          loading={save.isPending}
          disabled={!student || !lineId || !stopId}
        >
          Abonner{fee > 0 ? ` (${formatFcfa(fee)})` : ''}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <StudentPicker value={student} onChange={setStudent} />
        <SelectField
          label="Ligne"
          value={lineId}
          onChange={(e) => {
            setLineId(e.target.value);
            setStopId('');
          }}
        >
          <option value="">Choisir une ligne</option>
          {lines
            .filter((l) => l.active)
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.capacity
                  ? ` · ${Math.max(l.occupancy.OUTBOUND, l.occupancy.RETURN)}/${l.capacity}`
                  : ''}
              </option>
            ))}
        </SelectField>
        <SelectField
          label="Arrêt"
          value={stopId}
          onChange={(e) => setStopId(e.target.value)}
          disabled={!line}
        >
          <option value="">Choisir un arrêt</option>
          {line?.stops.map((s) => (
            <option key={s.id} value={s.id}>
              {s.order}. {s.name}
              {s.morningTime ? ` · ${s.morningTime}` : ''}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Trajets"
          value={direction}
          onChange={(e) => setDirection(e.target.value as TransportDirection)}
        >
          {TRANSPORT_DIRECTIONS.map((d) => (
            <option key={d} value={d}>
              {TRANSPORT_DIRECTION_LABELS[d]}
            </option>
          ))}
        </SelectField>
        <p className="text-sm text-muted">
          Le tarif annuel est ajouté à l’échéancier de l’élève et se règle comme la scolarité.
        </p>
      </div>
    </Sheet>
  );
}

function LinesTab({ lines, manage }: { lines: Line[]; manage: boolean }) {
  const [stopFor, setStopFor] = useState<Line | null>(null);
  if (lines.length === 0)
    return (
      <EmptyState title="Aucune ligne">
        Créez une ligne, ses arrêts, puis abonnez les élèves.
      </EmptyState>
    );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {lines.map((l) => (
        <Card key={l.id}>
          <CardHeader
            title={l.name}
            subtitle={
              l.vehicle
                ? `${l.vehicle.plate} · ${l.staff.map((s) => s.name).join(', ') || 'Aucun accompagnateur'}`
                : 'Aucun véhicule affecté'
            }
            action={l.active ? null : <Badge>Inactive</Badge>}
          />
          <dl className="mb-3 grid grid-cols-2 gap-2 text-sm">
            <div>
              <dt className="text-muted">Places aller</dt>
              <dd className="font-semibold tabular">
                {l.occupancy.OUTBOUND} / {l.capacity ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Places retour</dt>
              <dd className="font-semibold tabular">
                {l.occupancy.RETURN} / {l.capacity ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Aller et retour</dt>
              <dd className="font-semibold tabular">{formatFcfa(l.fee)}</dd>
            </div>
            <div>
              <dt className="text-muted">Un seul sens</dt>
              <dd className="font-semibold tabular">{formatFcfa(l.oneWayFee)}</dd>
            </div>
          </dl>
          <ol className="flex flex-col" aria-label={`Arrêts de ${l.name}`}>
            {l.stops.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 border-t border-line py-2 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <MapPin className="size-4 shrink-0 text-primary" aria-hidden />
                  <span className="truncate">
                    {s.order}. {s.name}
                  </span>
                </span>
                <span className="text-muted tabular">
                  {s.morningTime ?? '—'} · {s.eveningTime ?? '—'}
                </span>
              </li>
            ))}
          </ol>
          {manage ? (
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => setStopFor(l)}>
              <Plus className="size-4" aria-hidden />
              Ajouter un arrêt
            </Button>
          ) : null}
        </Card>
      ))}
      <StopSheet line={stopFor} onClose={() => setStopFor(null)} />
    </div>
  );
}

function SubscriptionsTab({ lines, manage }: { lines: Line[]; manage: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [lineId, setLineId] = useState('');
  const [creditFor, setCreditFor] = useState<CreditNoteTarget | null>(null);
  const q = useQuery({
    queryKey: ['transport', 'subscriptions', lineId],
    queryFn: () =>
      api<Subscription[]>(`/transport/subscriptions${lineId ? `?lineId=${lineId}` : ''}`),
  });
  const cancel = useMutation({
    mutationFn: (id: string) =>
      api(`/transport/subscriptions/${id}/cancel`, {
        method: 'POST',
        body: { reason: 'Résiliation à la demande de la famille' },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transport'] });
      toast('Abonnement résilié ; accordez un avoir si un remboursement est décidé');
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  return (
    <div className="flex flex-col gap-3">
      <SelectField
        label="Ligne"
        value={lineId}
        onChange={(e) => setLineId(e.target.value)}
        containerClassName="sm:max-w-xs"
      >
        <option value="">Toutes les lignes</option>
        {lines.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </SelectField>
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState title="Aucun abonné">
          Abonnez un élève depuis le bouton en haut de page.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Abonnés au transport">
          {q.data.map((sub) => (
            <li
              key={sub.id}
              className="flex flex-col gap-2 rounded-[14px] border border-line bg-white p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-col">
                <strong className="truncate">
                  {sub.student ? `${sub.student.lastName} ${sub.student.firstName}` : '—'}
                </strong>
                <span className="text-[13px] text-muted">
                  {sub.line.name} · {sub.stop.name} · {TRANSPORT_DIRECTION_LABELS[sub.direction]}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold tabular">{formatFcfa(sub.fee)}</span>
                {sub.status === 'ACTIVE' ? (
                  <Badge tone="success">Actif</Badge>
                ) : (
                  <Badge>Résilié</Badge>
                )}
                {manage && sub.status === 'ACTIVE' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => cancel.mutate(sub.id)}
                    aria-label={`Résilier l’abonnement de ${sub.student?.firstName ?? 'l’élève'}`}
                  >
                    Résilier
                  </Button>
                ) : null}
                {manage && sub.invoiced ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setCreditFor({
                        url: `/transport/subscriptions/${sub.id}/credit`,
                        label: `l’abonnement de ${sub.student ? `${sub.student.firstName} ${sub.student.lastName}` : 'l’élève'}`,
                      })
                    }
                    aria-label={`Avoir sur l’abonnement de ${sub.student?.firstName ?? 'l’élève'}`}
                  >
                    Avoir
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <CreditNoteSheet
        target={creditFor}
        onClose={() => setCreditFor(null)}
        onDone={() => void qc.invalidateQueries({ queryKey: ['transport'] })}
      />
    </div>
  );
}

function VehiclesTab({ vehicles }: { vehicles: Vehicle[] }) {
  if (vehicles.length === 0)
    return <EmptyState title="Aucun véhicule">Ajoutez le car ou le minibus de l’école.</EmptyState>;
  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      {vehicles.map((v) => (
        <Card key={v.id} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Bus className="size-5 text-primary" aria-hidden />
            <strong className="text-[15px]">{v.plate}</strong>
            <span className="text-sm text-muted">{v.capacity} places</span>
          </div>
          <span className="text-sm text-muted">
            {v.driverName ?? 'Chauffeur non renseigné'}
            {v.driverPhone ? ` · ${v.driverPhone}` : ''}
          </span>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <dt className="text-muted">Assurance</dt>
              <dd className="font-semibold">
                {v.insuranceExpiresOn ? formatShortDate(v.insuranceExpiresOn) : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Visite technique</dt>
              <dd className="font-semibold">
                {v.inspectionExpiresOn ? formatShortDate(v.inspectionExpiresOn) : '—'}
              </dd>
            </div>
          </dl>
          {v.alerts.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {v.alerts.map((a) => (
                <Badge key={a.document} tone={a.state === 'SOON' ? 'warn' : 'danger'}>
                  {alertText(a)}
                </Badge>
              ))}
            </div>
          ) : (
            <Badge tone="success" className="self-start">
              Documents à jour
            </Badge>
          )}
        </Card>
      ))}
    </div>
  );
}

function SettingsTab({ manage }: { manage: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['transport', 'settings'],
    queryFn: () => api<{ missedBoardingSms: boolean }>('/transport/settings'),
  });
  const save = useMutation({
    mutationFn: (missedBoardingSms: boolean) =>
      api('/transport/settings', { method: 'PUT', body: { missedBoardingSms } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transport', 'settings'] });
      toast('Réglage enregistré');
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  if (!q.data) return <LoadingBlock />;
  return (
    <Card>
      <CardHeader
        title="Prévenir les parents"
        subtitle="Le SMS part quelques minutes après l’appel : une erreur de pointage corrigée entre-temps l’annule."
      />
      <Checkbox
        label="Envoyer un SMS au parent quand l’enfant attendu n’est pas monté dans le car"
        checked={q.data.missedBoardingSms}
        disabled={!manage || save.isPending}
        onChange={(e) => save.mutate(e.target.checked)}
      />
    </Card>
  );
}

export default function TransportPage() {
  const { can } = useAuth();
  const manage = can('transport.manage');
  const [tab, setTab] = useState<Tab>('lines');
  const [sheet, setSheet] = useState<'vehicle' | 'line' | 'subscribe' | null>(null);
  const lines = useQuery({
    queryKey: ['transport', 'lines'],
    queryFn: () => api<Line[]>('/transport/lines'),
  });
  const vehicles = useQuery({
    queryKey: ['transport', 'vehicles'],
    queryFn: () => api<Vehicle[]>('/transport/vehicles'),
  });
  const alerts = (vehicles.data ?? []).flatMap((v) =>
    v.alerts.filter((a) => a.state !== 'MISSING').map((a) => ({ ...a, plate: v.plate })),
  );

  return (
    <>
      <PageHeader
        title="Transport scolaire"
        subtitle="Lignes, arrêts, véhicules et abonnés. Le tarif est facturé dans la scolarité."
        actions={
          manage ? (
            <>
              <Button onClick={() => setSheet('subscribe')}>
                <Plus className="size-4" aria-hidden />
                Abonner un élève
              </Button>
              <Button variant="secondary" onClick={() => setSheet('line')}>
                Nouvelle ligne
              </Button>
              <Button variant="secondary" onClick={() => setSheet('vehicle')}>
                Nouveau véhicule
              </Button>
            </>
          ) : undefined
        }
      />
      {alerts.length > 0 ? (
        <section
          className="flex gap-3 rounded-[14px] bg-warn-soft p-4"
          aria-label="Alertes des véhicules"
        >
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
          <ul className="flex flex-col gap-1 text-sm">
            {alerts.map((a) => (
              <li key={`${a.plate}-${a.document}`}>
                <strong>{a.plate}</strong> · {alertText(a)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <PillTabs label="Rubriques du transport" tabs={TABS} value={tab} onChange={setTab} />
      {lines.isPending || vehicles.isPending ? (
        <LoadingBlock />
      ) : lines.isError ? (
        <ErrorBlock error={lines.error} onRetry={() => lines.refetch()} />
      ) : tab === 'lines' ? (
        <LinesTab lines={lines.data} manage={manage} />
      ) : tab === 'subscriptions' ? (
        <SubscriptionsTab lines={lines.data} manage={manage} />
      ) : tab === 'vehicles' ? (
        <VehiclesTab vehicles={vehicles.data ?? []} />
      ) : (
        <SettingsTab manage={manage} />
      )}
      <VehicleSheet open={sheet === 'vehicle'} onClose={() => setSheet(null)} />
      <LineSheet
        open={sheet === 'line'}
        onClose={() => setSheet(null)}
        vehicles={vehicles.data ?? []}
      />
      <SubscribeSheet
        open={sheet === 'subscribe'}
        onClose={() => setSheet(null)}
        lines={lines.data ?? []}
      />
    </>
  );
}
