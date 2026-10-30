'use client';

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ADMIN_DOCUMENT_LABELS, ADMIN_DOCUMENT_TYPES, type AdminDocumentType } from '@ecole/shared';
import { Ban, Copy, FilePlus2, Printer, Search, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { controlClass, TextareaField } from '@/components/ui/field';
import { LoadMore } from '@/components/ui/load-more';
import { Sheet } from '@/components/ui/sheet';
import { StudentPicker, type PickedStudent } from '@/components/ui/student-picker';
import { useToast } from '@/components/ui/toast';
import { api, openPdf } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatShortDate } from '@/lib/format';
import type { Paged } from '@/lib/types';
import { cn } from '@/lib/utils';

interface IssuedDocument {
  id: string;
  type: AdminDocumentType;
  label: string;
  number: string;
  status: 'ISSUED' | 'CANCELLED';
  verificationCode: string;
  student: { id: string; firstName: string; lastName: string; matricule: string };
  class: string;
  year: string;
  duplicateOf: string | null;
  issuedAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  issuedBy?: string | null;
  cancelledBy?: string | null;
}

const TYPE_HINTS: Record<AdminDocumentType, string> = {
  SCHOOL_CERTIFICATE: 'Atteste que l’élève suit les cours cette année.',
  ENROLLMENT_ATTESTATION: 'Confirme l’inscription et la classe pour l’année.',
  STUDENT_CARD: 'Format carte bancaire, avec emplacement pour la photo.',
};

function StatusBadge({ doc }: { doc: IssuedDocument }) {
  return (
    <span className="flex flex-wrap gap-1">
      {doc.status === 'CANCELLED' ? (
        <Badge tone="danger">Annulé</Badge>
      ) : (
        <Badge tone="success">Valide</Badge>
      )}
      {doc.duplicateOf ? <Badge tone="info">Duplicata</Badge> : null}
    </span>
  );
}

function IssueSheet({
  open,
  onClose,
  initialStudent,
}: {
  open: boolean;
  onClose: () => void;
  initialStudent: PickedStudent | null;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [student, setStudent] = useState<PickedStudent | null>(initialStudent);
  const [type, setType] = useState<AdminDocumentType>('SCHOOL_CERTIFICATE');
  const [issued, setIssued] = useState<IssuedDocument | null>(null);
  useEffect(() => {
    if (open) {
      setStudent(initialStudent);
      setIssued(null);
    }
  }, [open, initialStudent]);
  const issue = useMutation({
    mutationFn: () =>
      api<IssuedDocument>('/documents', { method: 'POST', body: { studentId: student?.id, type } }),
    onSuccess: (doc) => {
      setIssued(doc);
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      toast(`${doc.label} n° ${doc.number} délivré`);
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const print = (doc: IssuedDocument) =>
    openPdf(`/documents/${doc.id}/pdf`).catch((e: unknown) =>
      toast(e instanceof Error ? e.message : 'Erreur', 'error'),
    );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Délivrer un document"
      footer={
        issued ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button block onClick={() => print(issued)}>
              <Printer className="size-4" aria-hidden />
              Imprimer le PDF
            </Button>
            <Button block variant="secondary" onClick={onClose}>
              Terminer
            </Button>
          </div>
        ) : (
          <Button
            block
            onClick={() => issue.mutate()}
            loading={issue.isPending}
            disabled={!student}
          >
            Délivrer le document
          </Button>
        )
      }
    >
      {issued ? (
        <div
          className="flex flex-col gap-2 rounded-[12px] bg-primary-soft p-4 text-sm"
          role="status"
        >
          <strong className="text-base text-primary">
            {issued.label} n° {issued.number}
          </strong>
          <span>
            {issued.student.lastName} {issued.student.firstName} · {issued.class} · {issued.year}
          </span>
          <span className="text-muted">
            Code de vérification{' '}
            <span className="font-semibold tabular">{issued.verificationCode}</span>
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <StudentPicker value={student} onChange={setStudent} />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-semibold lg:text-[13px]">Document</legend>
            {ADMIN_DOCUMENT_TYPES.map((t) => (
              <label
                key={t}
                className={cn(
                  'flex min-h-14 cursor-pointer items-start gap-3 rounded-[12px] border p-3',
                  type === t ? 'border-2 border-primary bg-primary-soft' : 'border-line-strong',
                )}
              >
                <input
                  type="radio"
                  name="document-type"
                  value={t}
                  checked={type === t}
                  onChange={() => setType(t)}
                  className="mt-1 size-4 accent-primary"
                />
                <span className="flex flex-col">
                  <span className="font-semibold">{ADMIN_DOCUMENT_LABELS[t]}</span>
                  <span className="text-[13px] text-muted">{TYPE_HINTS[t]}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="text-[13px] text-muted">
            Le document est rempli depuis la fiche de l’élève pour l’année en cours, reçoit le
            numéro suivant du registre et un code de vérification.
          </p>
        </div>
      )}
    </Sheet>
  );
}

function CancelSheet({ doc, onClose }: { doc: IssuedDocument | null; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  useEffect(() => setReason(''), [doc]);
  const cancel = useMutation({
    mutationFn: () =>
      api<IssuedDocument>(`/documents/${doc?.id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: (d) => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      toast(`Document n° ${d.number} annulé`);
      onClose();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  return (
    <Sheet
      open={!!doc}
      onClose={onClose}
      title="Annuler le document"
      footer={
        <Button
          block
          variant="danger"
          onClick={() => cancel.mutate()}
          loading={cancel.isPending}
          disabled={reason.trim().length < 5}
        >
          Confirmer l’annulation
        </Button>
      }
    >
      {doc ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm">
            {doc.label} n° <strong className="tabular">{doc.number}</strong> de{' '}
            {doc.student.lastName} {doc.student.firstName}. Le numéro reste au registre et la
            vérification publique affichera le document comme annulé. Cette action est définitive.
          </p>
          <TextareaField
            label="Motif de l’annulation"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            hint="5 caractères minimum. Le motif reste interne."
            maxLength={300}
          />
        </div>
      ) : null}
    </Sheet>
  );
}

function DocumentsContent() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [issuing, setIssuing] = useState(false);
  const [cancelling, setCancelling] = useState<IssuedDocument | null>(null);
  const preselected = params.get('eleve');
  const student = useQuery({
    queryKey: ['student', preselected],
    queryFn: () =>
      api<{
        id: string;
        firstName: string;
        lastName: string;
        matricule: string;
        enrollments: { isCurrent: boolean; class: { name: string } }[];
      }>(`/students/${preselected}`),
    enabled: !!preselected,
  });
  // Arrivée depuis une fiche élève (?eleve=…) : la fenêtre s'ouvre une seule fois.
  const [autoOpened, setAutoOpened] = useState(false);
  useEffect(() => {
    if (student.data && !autoOpened && can('documents.issue')) {
      setAutoOpened(true);
      setIssuing(true);
    }
  }, [student.data, autoOpened, can]);
  useEffect(() => {
    const t = setTimeout(() => {
      setTerm(search.trim());
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const query = new URLSearchParams({ pageSize: '30' });
  if (term) query.set('search', term);
  if (type) query.set('type', type);
  if (status) query.set('status', status);
  const q = useInfiniteQuery({
    queryKey: ['documents', query.toString()],
    queryFn: ({ pageParam }) =>
      api<Paged<IssuedDocument>>(`/documents?${query.toString()}&page=${pageParam}`),
    initialPageParam: 1,
    getNextPageParam: (last) =>
      last.page * last.pageSize < last.total ? last.page + 1 : undefined,
    placeholderData: keepPreviousData,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const duplicate = useMutation({
    mutationFn: (doc: IssuedDocument) =>
      api<IssuedDocument>(`/documents/${doc.id}/duplicate`, { method: 'POST' }),
    onSuccess: (d) => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      toast(`Duplicata n° ${d.number} délivré`);
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const print = (doc: IssuedDocument) =>
    openPdf(`/documents/${doc.id}/pdf`).catch((e: unknown) =>
      toast(e instanceof Error ? e.message : 'Erreur', 'error'),
    );
  const initialStudent: PickedStudent | null = student.data
    ? {
        id: student.data.id,
        firstName: student.data.firstName,
        lastName: student.data.lastName,
        matricule: student.data.matricule,
        className: student.data.enrollments.find((e) => e.isCurrent)?.class.name ?? null,
      }
    : null;

  const actions = (doc: IssuedDocument) => (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" onClick={() => print(doc)}>
        <Printer className="size-4" aria-hidden />
        PDF<span className="sr-only"> du n° {doc.number}</span>
      </Button>
      {doc.status === 'ISSUED' && can('documents.issue') ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => duplicate.mutate(doc)}
          loading={duplicate.isPending && duplicate.variables?.id === doc.id}
        >
          <Copy className="size-4" aria-hidden />
          Duplicata<span className="sr-only"> du n° {doc.number}</span>
        </Button>
      ) : null}
      {doc.status === 'ISSUED' && can('documents.cancel') ? (
        <Button size="sm" variant="danger" onClick={() => setCancelling(doc)}>
          <Ban className="size-4" aria-hidden />
          Annuler<span className="sr-only"> le n° {doc.number}</span>
        </Button>
      ) : null}
    </div>
  );

  return (
    <>
      <PageHeader
        title="Documents administratifs"
        subtitle="Certificats de scolarité, attestations d’inscription et cartes d’élève, numérotés et vérifiables par QR code."
        actions={
          <>
            {can('documents.configure') ? (
              <ButtonLink href="/documents/modeles" variant="secondary">
                <Settings2 className="size-4" aria-hidden />
                Modèles
              </ButtonLink>
            ) : null}
            {can('documents.issue') ? (
              <Button onClick={() => setIssuing(true)}>
                <FilePlus2 className="size-4" aria-hidden />
                Délivrer un document
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-[1fr_14rem_12rem]">
        <label className="col-span-2 flex h-12 items-center gap-2 rounded-[10px] border border-line-strong bg-white px-3 lg:col-span-1 lg:h-10">
          <Search className="size-4 text-muted" aria-hidden />
          <span className="sr-only">Rechercher dans le registre</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Numéro, nom ou matricule"
            className="h-full min-w-0 flex-1 bg-transparent text-base outline-none lg:text-sm"
          />
        </label>
        <label className="flex flex-col">
          <span className="sr-only">Type de document</span>
          <select
            className={cn(controlClass, 'h-12 lg:h-10')}
            value={type}
            onChange={(e) => {
              setType(e.target.value);
            }}
          >
            <option value="">Tous les documents</option>
            {ADMIN_DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {ADMIN_DOCUMENT_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="sr-only">Statut</span>
          <select
            className={cn(controlClass, 'h-12 lg:h-10')}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
            }}
          >
            <option value="">Tous les statuts</option>
            <option value="ISSUED">Valides</option>
            <option value="CANCELLED">Annulés</option>
          </select>
        </label>
      </div>

      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="Aucun document au registre">
          {can('documents.issue')
            ? 'Délivrez un premier document : il apparaîtra ici avec son numéro.'
            : 'Les documents délivrés apparaîtront ici.'}
        </EmptyState>
      ) : (
        <>
          <ul className="flex flex-col gap-2 md:hidden" aria-label="Registre des documents">
            {items.map((doc) => (
              <li
                key={doc.id}
                className={cn(
                  'flex flex-col gap-2 rounded-[14px] border border-line bg-white p-3',
                  doc.status === 'CANCELLED' && 'bg-paper',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col">
                    <strong className="tabular">{doc.number}</strong>
                    <span className="text-[13px] text-muted">{doc.label}</span>
                  </div>
                  <StatusBadge doc={doc} />
                </div>
                <div className="text-sm">
                  <Link
                    href={`/eleves/${doc.student.id}`}
                    className="font-semibold hover:underline"
                  >
                    {doc.student.lastName} {doc.student.firstName}
                  </Link>
                  <span className="text-muted">
                    {' '}
                    · {doc.class} · {formatShortDate(doc.issuedAt)}
                  </span>
                </div>
                {doc.cancelReason ? (
                  <p className="text-[13px] text-danger">Motif : {doc.cancelReason}</p>
                ) : null}
                {actions(doc)}
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto rounded-[14px] border border-line bg-white md:block">
            <table className="w-full min-w-[860px] text-sm">
              <caption className="sr-only">Registre des documents délivrés</caption>
              <thead className="bg-paper text-left text-xs tracking-[0.06em] text-muted uppercase">
                <tr>
                  <th className="px-4 py-3 font-semibold">Numéro</th>
                  <th className="px-3 py-3 font-semibold">Élève</th>
                  <th className="px-3 py-3 font-semibold">Délivré le</th>
                  <th className="px-3 py-3 font-semibold">Statut</th>
                  <th className="px-4 py-3 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((doc) => (
                  <tr key={doc.id} className="border-t border-line align-top">
                    <td className="px-4 py-2.5">
                      <div className="flex flex-col">
                        <strong className="tabular">{doc.number}</strong>
                        <span className="text-xs text-muted">{doc.label}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-col">
                        <Link
                          href={`/eleves/${doc.student.id}`}
                          className="font-semibold hover:underline"
                        >
                          {doc.student.lastName} {doc.student.firstName}
                        </Link>
                        <span className="text-xs text-muted tabular">
                          {doc.class} · {doc.student.matricule}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-col">
                        <span>{formatDateTime(doc.issuedAt)}</span>
                        {doc.issuedBy ? (
                          <span className="text-xs text-muted">{doc.issuedBy}</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge doc={doc} />
                      {doc.cancelReason ? (
                        <p className="mt-1 max-w-56 text-xs text-danger">
                          Motif : {doc.cancelReason}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5">{actions(doc)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <LoadMore
            shown={items.length}
            total={q.data?.pages[0]?.total}
            hasMore={!!q.hasNextPage}
            loading={q.isFetchingNextPage}
            onMore={() => void q.fetchNextPage()}
            noun="documents"
          />
        </>
      )}
      <IssueSheet
        open={issuing}
        onClose={() => setIssuing(false)}
        initialStudent={initialStudent}
      />
      <CancelSheet doc={cancelling} onClose={() => setCancelling(null)} />
    </>
  );
}

export default function DocumentsPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <DocumentsContent />
    </Suspense>
  );
}
