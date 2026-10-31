'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatFileSize } from '@ecole/shared';
import { ChevronRight, Eye, FileText, Lock, Phone, Upload, Wallet } from 'lucide-react';
import Link from 'next/link';
import { use, useState } from 'react';
import { Badge, ENROLLMENT_BADGE, LINE_BADGE } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, CardHeader, ErrorBlock, LoadingBlock } from '@/components/ui/card';
import { InputField, TextareaField } from '@/components/ui/field';
import { FilePicker } from '@/components/ui/file-picker';
import { Sheet } from '@/components/ui/sheet';
import { PhotoCard, StudentAvatar, type PhotoState } from '@/components/student-photo';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, openFile, openPdf, uploadFile } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  formatCameroonPhone,
  formatDate,
  formatDateTime,
  formatFcfa,
  formatGrade,
  formatShortDate,
} from '@/lib/format';
import type { Account, AccountTotals } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Overview {
  id: string;
  matricule: string;
  firstName: string;
  lastName: string;
  gender: 'F' | 'M';
  birthDate: string;
  birthPlace: string | null;
  nationality: string;
  photoConsent: boolean;
  photo: PhotoState;
  previousSchool: string | null;
  guardians: {
    linkId: string;
    firstName: string;
    lastName: string;
    phone: string;
    email: string | null;
    relationship: 'FATHER' | 'MOTHER' | 'TUTOR' | 'OTHER';
    isPrimary: boolean;
    isEmergencyContact: boolean;
    canPickUp: boolean;
    portalActive: boolean;
  }[];
  enrollments: {
    id: string;
    status: keyof typeof ENROLLMENT_BADGE;
    academicYear: string;
    isCurrent: boolean;
    class: { id: string; name: string; level: string };
  }[];
  documents: StudentDocument[];
  attendance: {
    absences: number;
    unjustified: number;
    lates: number;
    recent: {
      id: string;
      date: string;
      startTime: string;
      endTime: string;
      status: 'ABSENT' | 'LATE';
      justification: string | null;
    }[];
  };
  incidents: { id: string; date: string; description: string; sanction: string | null }[];
  reportCards: {
    id: string;
    version: number;
    generalAverageCenti: number | null;
    rank: number | null;
    classSize: number;
    publishedAt: string;
  }[];
  finance: {
    totals: AccountTotals;
    nextDue: { label: string; dueDate: string; amount: number } | null;
  } | null;
}

interface StudentDocument {
  id: string;
  type: string;
  status: 'RECEIVED' | 'MISSING';
  hasFile: boolean;
  file: { id: string; name: string; mimeType: string; size: number; createdAt: string } | null;
}

/** Dépôt ou remplacement du fichier d'une pièce (photo prise au téléphone ou fichier). */
function DocumentUploadSheet({
  studentId,
  doc,
  onClose,
}: {
  studentId: string;
  doc: StudentDocument | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const upload = useMutation({
    mutationFn: () => uploadFile(`/students/${studentId}/documents/${doc?.id}/file`, file!),
    onSuccess: () => {
      toast(doc?.file ? 'Pièce remplacée' : 'Pièce déposée');
      setFile(null);
      void queryClient.invalidateQueries({ queryKey: ['student', studentId] });
      onClose();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  return (
    <Sheet
      open={!!doc}
      onClose={() => {
        setFile(null);
        onClose();
      }}
      title={doc ? `${doc.file ? 'Remplacer' : 'Déposer'} : ${doc.type}` : ''}
      footer={
        <Button
          block
          size="lg"
          disabled={!file}
          loading={upload.isPending}
          onClick={() => upload.mutate()}
        >
          Enregistrer la pièce
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {doc?.file ? (
          <p className="text-sm text-muted">
            Le fichier actuel ({doc.file.name}) sera remplacé ; il reste consultable dans
            l’historique d’audit.
          </p>
        ) : null}
        <FilePicker label="Fichier de la pièce" value={file} onChange={setFile} />
        <p className="text-[13px] text-muted">
          Le fichier est chiffré et n’est visible que du secrétariat et de la direction.
        </p>
      </div>
    </Sheet>
  );
}

const RELATION: Record<Overview['guardians'][number]['relationship'], string> = {
  FATHER: 'père',
  MOTHER: 'mère',
  TUTOR: 'tuteur',
  OTHER: 'autre',
};

function HealthSheet({
  studentId,
  open,
  onClose,
}: {
  studentId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [data, setData] = useState<Record<string, string> | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const read = useMutation({
    mutationFn: () =>
      api<Record<string, string> | null>(
        `/students/${studentId}/health?reason=${encodeURIComponent(reason)}`,
      ),
    onSuccess: (d) => setData(d ?? {}),
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Erreur'),
  });
  const save = useMutation({
    mutationFn: (payload: Record<string, string>) =>
      api(`/students/${studentId}/health`, { method: 'PUT', body: payload }),
    onSuccess: () => onClose(),
  });
  return (
    <Sheet open={open} onClose={onClose} title="Fiche santé">
      {data === undefined ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            read.mutate();
          }}
        >
          <p className="text-sm text-muted">
            Indiquez le motif de la consultation : il est enregistré dans le journal d’audit.
          </p>
          <InputField
            label="Motif"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            error={error ?? undefined}
            minLength={5}
            required
          />
          <Button type="submit" loading={read.isPending} disabled={reason.trim().length < 5}>
            Consulter
          </Button>
        </form>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            save.mutate(
              Object.fromEntries(
                [...fd.entries()].map(([k, v]) => [k, String(v)]).filter(([, v]) => v !== ''),
              ),
            );
          }}
        >
          <TextareaField label="Allergies" name="allergies" defaultValue={data?.allergies ?? ''} />
          <TextareaField
            label="Maladies ou conditions"
            name="conditions"
            defaultValue={data?.conditions ?? ''}
          />
          <TextareaField
            label="Traitements"
            name="treatments"
            defaultValue={data?.treatments ?? ''}
          />
          <InputField label="Médecin traitant" name="doctor" defaultValue={data?.doctor ?? ''} />
          <Button type="submit" loading={save.isPending}>
            Enregistrer
          </Button>
        </form>
      )}
    </Sheet>
  );
}

export default function StudentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'overview' | 'payments' | 'attendance'>('overview');
  const [healthOpen, setHealthOpen] = useState(false);
  const [uploadDoc, setUploadDoc] = useState<StudentDocument | null>(null);
  const q = useQuery({
    queryKey: ['student', id],
    queryFn: () => api<Overview>(`/students/${id}`),
  });
  const account = useQuery({
    queryKey: ['account', id],
    queryFn: () => api<Account>(`/finance/students/${id}/account`),
    enabled: can('finance.read') && tab === 'payments',
  });
  const toggleDoc = useMutation({
    mutationFn: ({ docId, status }: { docId: string; status: 'RECEIVED' | 'MISSING' }) =>
      api(`/students/${id}/documents/${docId}`, { method: 'PATCH', body: { status } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['student', id] }),
  });

  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data;
  const current = s.enrollments.find((e) => e.isCurrent);
  const tabs = [
    ['overview', 'Vue d’ensemble'],
    ...(can('finance.read') ? [['payments', 'Paiements'] as const] : []),
    ['attendance', 'Présences'],
  ] as const;

  return (
    <>
      <nav aria-label="Fil d’Ariane" className="flex items-center gap-1.5 text-sm text-muted">
        <Link href="/eleves" className="font-semibold text-primary">
          Élèves
        </Link>
        <ChevronRight className="size-3.5" aria-hidden />
        <span aria-current="page" className="truncate">
          {s.lastName} {s.firstName}
        </span>
      </nav>

      <Card className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-4">
          <StudentAvatar
            studentId={s.id}
            name={`${s.lastName} ${s.firstName}`}
            hasPhoto={s.photo.hasPhoto}
          />
          <div className="flex min-w-0 flex-col gap-1.5">
            <h1 className="font-display text-2xl leading-tight font-bold lg:text-3xl">
              {s.lastName} {s.firstName}
            </h1>
            <div className="flex flex-wrap gap-1.5">
              {current ? (
                <Badge tone={ENROLLMENT_BADGE[current.status].tone}>
                  {ENROLLMENT_BADGE[current.status].label}
                </Badge>
              ) : (
                <Badge>Non inscrit cette année</Badge>
              )}
              {s.finance ? (
                s.finance.totals.overdue > 0 ? (
                  <Badge tone="danger">Retard {formatFcfa(s.finance.totals.overdue)}</Badge>
                ) : (
                  <Badge tone="success">Scolarité à jour</Badge>
                )
              ) : null}
            </div>
          </div>
        </div>
        <dl className="grid flex-1 grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted">Matricule</dt>
            <dd className="font-semibold tabular">{s.matricule}</dd>
          </div>
          <div>
            <dt className="text-muted">Classe</dt>
            <dd className="font-semibold">{current?.class.name ?? '—'}</dd>
          </div>
          <div className="col-span-2 sm:col-span-1">
            <dt className="text-muted">Né(e) le</dt>
            <dd className="font-semibold">
              {formatDate(s.birthDate)}
              {s.birthPlace ? ` à ${s.birthPlace}` : ''}
            </dd>
          </div>
        </dl>
        {can('finance.payments.create') ? (
          <ButtonLink href={`/caisse?eleve=${s.id}`} className="sm:self-center">
            <Wallet className="size-4" aria-hidden />
            Encaisser
          </ButtonLink>
        ) : null}
      </Card>

      <DocumentUploadSheet studentId={id} doc={uploadDoc} onClose={() => setUploadDoc(null)} />
      {can('health.read') ? (
        <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-line bg-white p-3">
          <Lock className="size-5 text-muted" aria-hidden />
          <span className="flex-1 text-sm text-muted">
            <strong className="text-ink">Fiche santé à accès restreint.</strong> Chaque consultation
            est journalisée avec son motif.
          </span>
          <Button variant="secondary" size="sm" onClick={() => setHealthOpen(true)}>
            Consulter avec un motif
          </Button>
          <HealthSheet studentId={s.id} open={healthOpen} onClose={() => setHealthOpen(false)} />
        </div>
      ) : null}

      <div
        role="tablist"
        aria-label="Sections de la fiche"
        className="-mx-4 flex gap-6 overflow-x-auto border-b border-line px-4 lg:mx-0 lg:px-0"
      >
        {tabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              'min-h-11 shrink-0 border-b-2 text-[15px] lg:text-sm',
              tab === value
                ? 'border-primary font-bold'
                : 'border-transparent font-medium text-muted',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {s.finance ? (
            <Card>
              <CardHeader title="Situation financière" />
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm text-muted">Reste à payer</span>
                <strong className="font-display text-2xl tabular">
                  {formatFcfa(s.finance.totals.outstanding)}
                </strong>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-soft">
                <div
                  className="h-2 bg-primary"
                  style={{
                    width: `${s.finance.totals.due ? Math.round((s.finance.totals.paid / s.finance.totals.due) * 100) : 0}%`,
                  }}
                />
              </div>
              <div className="mt-1.5 flex justify-between text-[13px] text-muted tabular">
                <span>Payé {formatFcfa(s.finance.totals.paid, false)}</span>
                <span>Total {formatFcfa(s.finance.totals.due, false)}</span>
              </div>
              {s.finance.nextDue ? (
                <div className="mt-3 flex items-center justify-between gap-2 rounded-[10px] bg-paper p-3 text-sm">
                  <span>
                    {s.finance.nextDue.label} ·{' '}
                    <strong>{formatShortDate(s.finance.nextDue.dueDate)}</strong>
                  </span>
                  <strong className="tabular">{formatFcfa(s.finance.nextDue.amount)}</strong>
                </div>
              ) : null}
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Assiduité · année" />
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-[10px] bg-danger-soft p-3 text-danger">
                <strong className="block text-xl tabular">{s.attendance.absences}</strong>
                <span className="text-xs font-semibold">Absences</span>
              </div>
              <div className="rounded-[10px] bg-warn-soft p-3 text-warn">
                <strong className="block text-xl tabular">{s.attendance.lates}</strong>
                <span className="text-xs font-semibold">Retards</span>
              </div>
              <div className="rounded-[10px] bg-paper p-3">
                <strong className="block text-xl tabular">{s.incidents.length}</strong>
                <span className="text-xs font-semibold text-muted">Incidents</span>
              </div>
            </div>
            <p className="mt-3 text-sm text-muted">
              {s.attendance.unjustified} absence(s) non justifiée(s).
            </p>
          </Card>

          <Card>
            <CardHeader title="Parents et tuteurs" />
            <ul className="flex flex-col gap-2">
              {s.guardians.map((g) => (
                <li
                  key={g.linkId}
                  className="flex flex-col gap-2 rounded-[10px] border border-line p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <strong className="text-sm">
                      {g.firstName} {g.lastName} · {RELATION[g.relationship]}
                    </strong>
                    <a
                      href={`tel:${g.phone}`}
                      className="flex min-h-11 items-center gap-1.5 text-sm font-semibold text-primary tabular"
                    >
                      <Phone className="size-4" aria-hidden />
                      {formatCameroonPhone(g.phone)}
                    </a>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {g.isPrimary ? <Badge tone="success">Contact principal</Badge> : null}
                    {g.isEmergencyContact ? <Badge tone="danger">Urgence</Badge> : null}
                    {g.canPickUp ? <Badge>Peut récupérer</Badge> : null}
                    <Badge tone={g.portalActive ? 'info' : 'warn'}>
                      {g.portalActive ? 'Portail actif' : 'Portail jamais utilisé'}
                    </Badge>
                  </div>
                  <GuardianEmail
                    studentId={s.id}
                    linkId={g.linkId}
                    email={g.email}
                    editable={can('students.write')}
                  />
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader title="Parcours" />
            <ol className="flex flex-col gap-3">
              {s.enrollments.map((e) => (
                <li key={e.id} className="flex items-start gap-3">
                  <span
                    className={cn(
                      'mt-1.5 size-2.5 shrink-0 rounded-full',
                      e.isCurrent ? 'bg-saffron' : 'bg-primary',
                    )}
                    aria-hidden
                  />
                  <div className="flex flex-col">
                    <strong className="text-sm">
                      {e.academicYear} · {e.class.name}
                    </strong>
                    <span className="text-[13px] text-muted">
                      {ENROLLMENT_BADGE[e.status].label}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </Card>

          <PhotoCard studentId={s.id} photo={s.photo} />

          <Card>
            <CardHeader title="Pièces du dossier" />
            <ul className="flex flex-col">
              {s.documents.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-col gap-1 border-t border-line py-1.5 text-sm first:border-t-0"
                >
                  <div className="flex min-h-11 items-center justify-between gap-2">
                    <span className="flex min-w-0 flex-col">
                      <span>{d.type}</span>
                      {d.file ? (
                        <span className="truncate text-[13px] text-muted">
                          {d.file.name} · {formatFileSize(d.file.size)}
                        </span>
                      ) : d.hasFile ? (
                        <span className="text-[13px] text-muted">Fichier déposé</span>
                      ) : null}
                    </span>
                    {can('students.write') ? (
                      <button
                        type="button"
                        onClick={() =>
                          toggleDoc.mutate({
                            docId: d.id,
                            status: d.status === 'RECEIVED' ? 'MISSING' : 'RECEIVED',
                          })
                        }
                        aria-label={`${d.type} : ${d.status === 'RECEIVED' ? 'reçu, marquer manquant' : 'manquant, marquer reçu'}`}
                        className="min-h-11 shrink-0"
                      >
                        <Badge tone={d.status === 'RECEIVED' ? 'success' : 'danger'}>
                          {d.status === 'RECEIVED' ? 'Reçu' : 'Manquant'}
                        </Badge>
                      </button>
                    ) : (
                      <Badge tone={d.status === 'RECEIVED' ? 'success' : 'danger'}>
                        {d.status === 'RECEIVED' ? 'Reçu' : 'Manquant'}
                      </Badge>
                    )}
                  </div>
                  {can('students.documents') ? (
                    <div className="flex flex-wrap gap-2 pb-1">
                      {d.file ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          aria-label={`Voir le fichier : ${d.type}`}
                          onClick={() =>
                            openFile(`/students/${id}/documents/${d.id}/file`).catch((e) =>
                              toast(e instanceof Error ? e.message : 'Erreur', 'error'),
                            )
                          }
                        >
                          <Eye className="size-4" aria-hidden />
                          Voir
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`${d.file ? 'Remplacer' : 'Déposer'} le fichier : ${d.type}`}
                        onClick={() => setUploadDoc(d)}
                      >
                        <Upload className="size-4" aria-hidden />
                        {d.file ? 'Remplacer' : 'Déposer le fichier'}
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader title="Bulletins publiés" />
            {s.reportCards.length === 0 ? (
              <p className="text-sm text-muted">Aucun bulletin publié pour l’instant.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {s.reportCards.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="flex min-h-12 w-full items-center gap-3 text-left text-sm"
                      onClick={() =>
                        openPdf(`/report-cards/${r.id}/pdf`).catch((e) =>
                          toast(e instanceof Error ? e.message : 'Erreur', 'error'),
                        )
                      }
                    >
                      <FileText className="size-4 text-primary" aria-hidden />
                      <span className="flex-1">
                        Moyenne{' '}
                        <strong className="tabular">{formatGrade(r.generalAverageCenti)}</strong> ·
                        rang {r.rank ?? '—'}/{r.classSize} · v{r.version}
                      </span>
                      <span className="text-xs text-muted">{formatShortDate(r.publishedAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : null}

      {tab === 'payments' ? (
        account.isPending ? (
          <LoadingBlock />
        ) : account.isError ? (
          <ErrorBlock error={account.error} />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Échéancier" />
              <ul className="flex flex-col">
                {account.data.lines.map((l) => (
                  <li
                    key={l.id}
                    className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0"
                  >
                    <div className="flex flex-1 flex-col">
                      <strong className="text-sm">{l.label}</strong>
                      <span
                        className={cn(
                          'text-xs',
                          l.overdue ? 'font-semibold text-danger' : 'text-muted',
                        )}
                      >
                        {l.overdue ? 'Échue le ' : 'Échéance '}
                        {formatShortDate(l.dueDate)}
                      </span>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className="text-sm font-semibold tabular">
                        {formatFcfa(l.outstanding || l.due)}
                      </span>
                      <Badge tone={LINE_BADGE[l.status].tone}>{LINE_BADGE[l.status].label}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
            <Card>
              <CardHeader title="Paiements" />
              {account.data.payments.length === 0 ? (
                <p className="text-sm text-muted">Aucun paiement enregistré.</p>
              ) : (
                <ul className="flex flex-col">
                  {account.data.payments.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0"
                    >
                      <div className="flex flex-1 flex-col">
                        <strong className={cn('text-sm tabular', p.reversed && 'line-through')}>
                          {formatFcfa(p.amount)}
                        </strong>
                        <span className="text-xs text-muted">
                          {p.methodLabel} · {formatDateTime(p.confirmedAt ?? p.createdAt)}
                        </span>
                      </div>
                      {p.reversed ? (
                        <Badge tone="danger">Annulé</Badge>
                      ) : p.status === 'SUCCESS' ? (
                        <Badge tone="success">Payé</Badge>
                      ) : p.status === 'PENDING' ? (
                        <Badge tone="info">En attente</Badge>
                      ) : (
                        <Badge>Échec</Badge>
                      )}
                      {p.receipt ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            openPdf(`/finance/payments/${p.id}/receipt.pdf`).catch(() =>
                              toast('Reçu indisponible', 'error'),
                            )
                          }
                        >
                          {p.receipt.number}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )
      ) : null}

      {tab === 'attendance' ? (
        <Card>
          <CardHeader title="Absences et retards" />
          {s.attendance.recent.length === 0 ? (
            <p className="text-sm text-muted">Aucune absence ni retard cette année.</p>
          ) : (
            <ul className="flex flex-col">
              {s.attendance.recent.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center gap-3 border-t border-line py-2.5 text-sm first:border-t-0"
                >
                  <span className="flex-1">
                    {formatShortDate(r.date)} · {r.startTime}–{r.endTime}
                  </span>
                  <Badge tone={r.status === 'ABSENT' ? 'danger' : 'warn'}>
                    {r.status === 'ABSENT' ? (s.gender === 'F' ? 'Absente' : 'Absent') : 'Retard'}
                  </Badge>
                  {r.justification === 'ACCEPTED' ? (
                    <Badge tone="info">{r.status === 'ABSENT' ? 'Justifiée' : 'Justifié'}</Badge>
                  ) : r.justification === 'PENDING' ? (
                    <Badge>Justificatif en attente</Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
    </>
  );
}

/** Adresse e-mail facultative du parent, modifiable par le secrétariat. */
function GuardianEmail({
  studentId,
  linkId,
  email,
  editable,
}: {
  studentId: string;
  linkId: string;
  email: string | null;
  editable: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const save = useMutation({
    mutationFn: (value: string | null) =>
      api(`/students/${studentId}/guardians/${linkId}/contact`, {
        method: 'PATCH',
        body: { email: value },
      }),
    onSuccess: () => {
      toast('Adresse e-mail enregistrée');
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ['student', studentId] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  if (editing)
    return (
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          const value = String(new FormData(e.currentTarget).get('email') ?? '').trim();
          save.mutate(value || null);
        }}
      >
        <InputField
          label="Adresse e-mail du parent"
          name="email"
          type="email"
          defaultValue={email ?? ''}
          optional
          containerClassName="flex-1"
        />
        <Button type="submit" size="sm" loading={save.isPending}>
          Enregistrer
        </Button>
      </form>
    );
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      {email ? (
        <a href={`mailto:${email}`} className="text-primary [overflow-wrap:anywhere]">
          {email}
        </a>
      ) : (
        <span className="text-muted">Aucune adresse e-mail</span>
      )}
      {editable ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="min-h-11 font-semibold text-primary"
        >
          {email ? 'Modifier l’e-mail' : 'Ajouter un e-mail'}
        </button>
      ) : null}
    </div>
  );
}
