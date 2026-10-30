'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { latePenalty, type LibrarySettings } from '@ecole/shared';
import { BookOpen, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  Stat,
} from '@/components/ui/card';
import { Checkbox, InputField, SelectField } from '@/components/ui/field';
import { PillTabs } from '@/components/ui/pill-tabs';
import { Sheet } from '@/components/ui/sheet';
import { StudentPicker, type PickedStudent } from '@/components/ui/student-picker';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatFcfa, formatShortDate, plural } from '@/lib/format';
import type { Paged } from '@/lib/types';

interface Book {
  id: string;
  title: string;
  authors: string[];
  isbn: string | null;
  callNumber: string | null;
  copies: { id: string; code: string; status: 'AVAILABLE' | 'LOANED' | 'LOST' | 'WITHDRAWN' }[];
  available: number;
}
interface Loan {
  id: string;
  borrowerType: 'STUDENT' | 'STAFF';
  borrower: { id: string; name: string; detail: string | null };
  book: { id: string; title: string; authors: string[] };
  copy: { id: string; code: string };
  dueDate: string;
  renewals: number;
  returnedAt: string | null;
  lost: boolean;
  daysLate: number;
  overdue: boolean;
  penaltyAmount: number | null;
}
interface Stats {
  books: number;
  copies: number;
  active: number;
  overdue: number;
}

type Tab = 'active' | 'overdue' | 'history' | 'catalog' | 'settings';
const TABS = [
  ['active', 'Prêts en cours'],
  ['overdue', 'En retard'],
  ['history', 'Historique'],
  ['catalog', 'Catalogue'],
  ['settings', 'Réglages'],
] as const;

function useDebounced(value: string, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value.trim()), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function BookSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const empty = { title: '', authors: '', isbn: '', callNumber: '', copies: '1' };
  const [form, setForm] = useState(empty);
  const save = useMutation({
    mutationFn: () =>
      api<{ codes: string[] }>('/library/books', {
        method: 'POST',
        body: {
          title: form.title,
          authors: form.authors
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean),
          isbn: form.isbn,
          callNumber: form.callNumber || null,
          copies: Number(form.copies || 0),
        },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['library'] });
      toast(r.codes.length ? `Livre ajouté : exemplaires ${r.codes.join(', ')}` : 'Livre ajouté');
      setForm(empty);
      setErrors({});
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fieldErrors.length > 0)
        setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.path, f.message])));
      toast(e instanceof Error ? e.message : 'Erreur', 'error');
    },
  });
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Ajouter un livre"
      footer={
        <Button block onClick={() => save.mutate()} loading={save.isPending} disabled={!form.title}>
          Ajouter au catalogue
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <InputField
          label="Titre"
          value={form.title}
          onChange={set('title')}
          error={errors.title}
          containerClassName="sm:col-span-2"
        />
        <InputField
          label="Auteurs"
          value={form.authors}
          onChange={set('authors')}
          hint="Séparés par des virgules"
          optional
          containerClassName="sm:col-span-2"
        />
        <InputField
          label="ISBN"
          value={form.isbn}
          onChange={set('isbn')}
          error={errors.isbn}
          optional
        />
        <InputField label="Cote" value={form.callNumber} onChange={set('callNumber')} optional />
        <InputField
          label="Nombre d’exemplaires"
          type="number"
          inputMode="numeric"
          min={0}
          value={form.copies}
          onChange={set('copies')}
        />
      </div>
    </Sheet>
  );
}

function LoanSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const term = useDebounced(search);
  const [copyId, setCopyId] = useState('');
  const [type, setType] = useState<'STUDENT' | 'STAFF'>('STUDENT');
  const [student, setStudent] = useState<PickedStudent | null>(null);
  const [staffId, setStaffId] = useState('');
  const books = useQuery({
    queryKey: ['library', 'books', 'pick', term],
    queryFn: () => api<Paged<Book>>(`/library/books?pageSize=8&search=${encodeURIComponent(term)}`),
    enabled: open && term.length >= 2,
  });
  const staff = useQuery({
    queryKey: ['library', 'staff'],
    queryFn: () =>
      api<{ id: string; firstName: string; lastName: string }[]>('/library/readers/staff'),
    enabled: open && type === 'STAFF',
  });
  const available = (books.data?.items ?? []).flatMap((b) =>
    b.copies.filter((c) => c.status === 'AVAILABLE').map((c) => ({ ...c, title: b.title })),
  );
  const save = useMutation({
    mutationFn: () =>
      api<{ dueDate: string }>('/library/loans', {
        method: 'POST',
        body: {
          copyId,
          borrowerType: type,
          ...(type === 'STUDENT' ? { studentId: student?.id } : { staffUserId: staffId }),
        },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['library'] });
      toast(`Prêt enregistré, retour prévu le ${formatShortDate(r.dueDate)}`);
      setCopyId('');
      setSearch('');
      setStudent(null);
      onClose();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Nouveau prêt"
      footer={
        <Button
          block
          onClick={() => save.mutate()}
          loading={save.isPending}
          disabled={!copyId || (type === 'STUDENT' ? !student : !staffId)}
        >
          Enregistrer le prêt
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <InputField
          label="Livre"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Titre, ISBN ou code d’exemplaire"
        />
        {term.length >= 2 ? (
          <SelectField
            label="Exemplaire disponible"
            value={copyId}
            onChange={(e) => setCopyId(e.target.value)}
          >
            <option value="">
              {available.length ? 'Choisir un exemplaire' : 'Aucun exemplaire disponible'}
            </option>
            {available.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.title}
              </option>
            ))}
          </SelectField>
        ) : null}
        <SelectField
          label="Lecteur"
          value={type}
          onChange={(e) => setType(e.target.value as 'STUDENT' | 'STAFF')}
        >
          <option value="STUDENT">Élève</option>
          <option value="STAFF">Membre du personnel</option>
        </SelectField>
        {type === 'STUDENT' ? (
          <StudentPicker value={student} onChange={setStudent} />
        ) : (
          <SelectField
            label="Membre du personnel"
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
          >
            <option value="">Choisir</option>
            {staff.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.lastName} {u.firstName}
              </option>
            ))}
          </SelectField>
        )}
      </div>
    </Sheet>
  );
}

function ReturnSheet({
  loan,
  settings,
  onClose,
}: {
  loan: Loan | null;
  settings: LibrarySettings | undefined;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [waive, setWaive] = useState(false);
  const [lost, setLost] = useState(false);
  const penalty =
    loan && settings && loan.borrowerType === 'STUDENT'
      ? latePenalty(loan.daysLate, settings.lateFeePerDay, settings.lateFeeCap)
      : 0;
  const save = useMutation({
    mutationFn: () =>
      api<{ penalty: number }>(`/library/loans/${loan?.id}/return`, {
        method: 'POST',
        body: { waivePenalty: waive, lost },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['library'] });
      toast(
        r.penalty > 0
          ? `Retour enregistré ; pénalité de ${formatFcfa(r.penalty)} ajoutée à la scolarité`
          : 'Retour enregistré',
      );
      setWaive(false);
      setLost(false);
      onClose();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  return (
    <Sheet
      open={!!loan}
      onClose={onClose}
      title="Enregistrer le retour"
      footer={
        <Button block onClick={() => save.mutate()} loading={save.isPending}>
          Confirmer le retour
        </Button>
      }
    >
      {loan ? (
        <div className="flex flex-col gap-3 text-sm">
          <p>
            <strong>{loan.book.title}</strong> ({loan.copy.code}), emprunté par{' '}
            <strong>{loan.borrower.name}</strong>.
          </p>
          {loan.daysLate > 0 ? (
            <p className="rounded-[10px] bg-warn-soft p-3">
              {plural(loan.daysLate, 'jour', 'jours')} de retard
              {penalty > 0
                ? ` : pénalité de ${formatFcfa(penalty)} facturée par la scolarité.`
                : '.'}
            </p>
          ) : (
            <p className="text-muted">Rendu à temps.</p>
          )}
          {penalty > 0 ? (
            <Checkbox
              label="Ne pas facturer la pénalité"
              checked={waive}
              onChange={(e) => setWaive(e.target.checked)}
            />
          ) : null}
          <Checkbox
            label="Livre perdu ou rendu inutilisable"
            checked={lost}
            onChange={(e) => setLost(e.target.checked)}
          />
        </div>
      ) : null}
    </Sheet>
  );
}

function LoansTab({
  filter,
  canLend,
  settings,
}: {
  filter: 'active' | 'overdue' | 'history';
  canLend: boolean;
  settings: LibrarySettings | undefined;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [returning, setReturning] = useState<Loan | null>(null);
  useEffect(() => setPage(1), [filter]);
  const q = useQuery({
    queryKey: ['library', 'loans', filter, page],
    queryFn: () => api<Paged<Loan>>(`/library/loans?filter=${filter}&page=${page}`),
    placeholderData: keepPreviousData,
  });
  const renew = useMutation({
    mutationFn: (id: string) =>
      api<{ dueDate: string }>(`/library/loans/${id}/renew`, { method: 'POST' }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['library'] });
      toast(`Prêt prolongé jusqu’au ${formatShortDate(r.dueDate)}`);
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => q.refetch()} />;
  if (q.data.items.length === 0)
    return (
      <EmptyState title={filter === 'overdue' ? 'Aucun retard' : 'Aucun prêt'}>
        {filter === 'active' ? 'Enregistrez un prêt depuis le bouton en haut de page.' : null}
      </EmptyState>
    );
  const pages = Math.max(1, Math.ceil(q.data.total / q.data.pageSize));
  return (
    <>
      <ul className="flex flex-col gap-2" aria-label="Prêts">
        {q.data.items.map((l) => (
          <li
            key={l.id}
            className="flex flex-col gap-2 rounded-[14px] border border-line bg-white p-3 md:flex-row md:items-center md:justify-between"
          >
            <div className="flex min-w-0 flex-col">
              <strong className="truncate">{l.book.title}</strong>
              <span className="text-[13px] text-muted">
                {l.copy.code} · {l.borrower.name}
                {l.borrower.detail ? ` (${l.borrower.detail})` : ''}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {l.returnedAt ? (
                <Badge tone={l.lost ? 'danger' : 'neutral'}>
                  {l.lost ? 'Perdu' : `Rendu le ${formatShortDate(l.returnedAt)}`}
                </Badge>
              ) : l.overdue ? (
                <Badge tone="danger">{plural(l.daysLate, 'jour', 'jours')} de retard</Badge>
              ) : (
                <Badge tone="info">Retour le {formatShortDate(l.dueDate)}</Badge>
              )}
              {l.penaltyAmount ? <Badge tone="warn">{formatFcfa(l.penaltyAmount)}</Badge> : null}
              {canLend && !l.returnedAt ? (
                <>
                  {!l.overdue ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => renew.mutate(l.id)}
                      aria-label={`Prolonger le prêt de ${l.book.title}`}
                    >
                      Prolonger
                    </Button>
                  ) : null}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setReturning(l)}
                    aria-label={`Retour de ${l.book.title} (${l.copy.code})`}
                  >
                    Retour
                  </Button>
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {pages > 1 ? (
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="secondary"
            size="icon"
            aria-label="Page précédente"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <span className="text-sm tabular">
            {page} / {pages}
          </span>
          <Button
            variant="secondary"
            size="icon"
            aria-label="Page suivante"
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      ) : null}
      <ReturnSheet loan={returning} settings={settings} onClose={() => setReturning(null)} />
    </>
  );
}

function CatalogTab() {
  const [search, setSearch] = useState('');
  const term = useDebounced(search);
  const q = useQuery({
    queryKey: ['library', 'books', term],
    queryFn: () =>
      api<Paged<Book>>(`/library/books?pageSize=50&search=${encodeURIComponent(term)}`),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="flex flex-col gap-3">
      <InputField
        label="Rechercher"
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Titre, auteur, ISBN, cote ou code"
        containerClassName="sm:max-w-md"
      />
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyState title="Aucun livre trouvé" />
      ) : (
        <ul className="grid gap-2 md:grid-cols-2" aria-label="Catalogue">
          {q.data.items.map((b) => (
            <li key={b.id} className="flex gap-3 rounded-[14px] border border-line bg-white p-3">
              <BookOpen className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <strong className="[overflow-wrap:anywhere]">{b.title}</strong>
                <span className="text-[13px] text-muted">
                  {[b.authors.join(', '), b.callNumber, b.isbn].filter(Boolean).join(' · ')}
                </span>
                <span className="text-[13px]">
                  {b.available} disponible{b.available > 1 ? 's' : ''} sur {b.copies.length}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SettingsTab({ settings, manage }: { settings: LibrarySettings; manage: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState(settings);
  const save = useMutation({
    mutationFn: () => api('/library/settings', { method: 'PUT', body: form }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['library', 'settings'] });
      toast('Réglages enregistrés');
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const num = (k: keyof LibrarySettings) => ({
    value: String(form[k]),
    type: 'number',
    inputMode: 'numeric' as const,
    min: 0,
    disabled: !manage,
    onChange: (e: { target: { value: string } }) =>
      setForm({ ...form, [k]: Number(e.target.value || 0) }),
  });
  return (
    <Card>
      <CardHeader title="Règles de prêt" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <InputField label="Emprunts simultanés par lecteur" {...num('maxLoans')} />
        <InputField label="Durée d’un prêt (jours)" {...num('loanDays')} />
        <InputField label="Prolongations par prêt" {...num('maxRenewals')} />
        <InputField
          label="Pénalité par jour de retard (FCFA)"
          hint="0 pour ne pas facturer de pénalité"
          {...num('lateFeePerDay')}
        />
        <InputField
          label="Plafond de la pénalité (FCFA)"
          hint="0 pour aucun plafond"
          {...num('lateFeeCap')}
        />
      </div>
      <Checkbox
        className="mt-4"
        label="Rappeler les retards au parent par SMS"
        checked={form.reminderSms}
        disabled={!manage}
        onChange={(e) => setForm({ ...form, reminderSms: e.target.checked })}
      />
      {manage ? (
        <Button className="mt-4" onClick={() => save.mutate()} loading={save.isPending}>
          Enregistrer les réglages
        </Button>
      ) : null}
    </Card>
  );
}

export default function LibraryPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('active');
  const [sheet, setSheet] = useState<'book' | 'loan' | null>(null);
  const stats = useQuery({
    queryKey: ['library', 'stats'],
    queryFn: () => api<Stats>('/library/stats'),
  });
  const settings = useQuery({
    queryKey: ['library', 'settings'],
    queryFn: () => api<LibrarySettings>('/library/settings'),
  });
  return (
    <>
      <PageHeader
        title="Bibliothèque"
        subtitle="Catalogue, prêts aux élèves et au personnel, retards et pénalités."
        actions={
          <>
            {can('library.loans') ? (
              <Button onClick={() => setSheet('loan')}>
                <Plus className="size-4" aria-hidden />
                Nouveau prêt
              </Button>
            ) : null}
            {can('library.manage') ? (
              <Button variant="secondary" onClick={() => setSheet('book')}>
                Ajouter un livre
              </Button>
            ) : null}
          </>
        }
      />
      {stats.data ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Livres" value={stats.data.books} />
          <Stat label="Exemplaires" value={stats.data.copies} />
          <Stat label="Prêts en cours" value={stats.data.active} />
          <Stat
            label="En retard"
            value={stats.data.overdue}
            tone={stats.data.overdue > 0 ? 'danger' : 'default'}
          />
        </div>
      ) : null}
      <PillTabs label="Rubriques de la bibliothèque" tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'catalog' ? (
        <CatalogTab />
      ) : tab === 'settings' ? (
        settings.data ? (
          <SettingsTab settings={settings.data} manage={can('library.manage')} />
        ) : (
          <LoadingBlock />
        )
      ) : (
        <LoansTab filter={tab} canLend={can('library.loans')} settings={settings.data} />
      )}
      <BookSheet open={sheet === 'book'} onClose={() => setSheet(null)} />
      <LoanSheet open={sheet === 'loan'} onClose={() => setSheet(null)} />
    </>
  );
}
