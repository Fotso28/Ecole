'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  STOCK_CATEGORIES,
  STOCK_CATEGORY_LABELS,
  type StockCategory,
  type StockMovementType,
} from '@ecole/shared';
import { Plus, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { CreditNoteSheet, type CreditNoteTarget } from '@/components/credit-note-sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorBlock, LoadingBlock, PageHeader, Stat } from '@/components/ui/card';
import { InputField, SelectField } from '@/components/ui/field';
import { PillTabs } from '@/components/ui/pill-tabs';
import { Sheet } from '@/components/ui/sheet';
import { StudentPicker, type PickedStudent } from '@/components/ui/student-picker';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatFcfa } from '@/lib/format';
import type { Paged } from '@/lib/types';

interface Item {
  id: string;
  name: string;
  category: StockCategory;
  sizes: { size: string; onHand: number; low: boolean }[];
  unitPrice: number;
  alertThreshold: number;
  onHand: number;
  averageCost: number;
  value: number;
  low: boolean;
}
interface Movement {
  id: string;
  item: { id: string; name: string };
  size: string;
  type: StockMovementType;
  typeLabel: string;
  quantity: number;
  unitCost: number | null;
  supplier: string | null;
  reason: string | null;
  student: { id: string; name: string } | null;
  invoiced: boolean;
  reversible: boolean;
  createdAt: string;
}

type Tab = 'items' | 'movements' | 'inventory';
const TABS = [
  ['items', 'Articles'],
  ['movements', 'Mouvements'],
  ['inventory', 'Inventaire'],
] as const;
type Operation = 'purchase' | 'sale' | 'allocation';
const OPERATION_TITLES: Record<Operation, string> = {
  purchase: 'Entrée de stock (achat)',
  sale: 'Vente à un élève',
  allocation: 'Dotation interne',
};

const sizeText = (size: string) => (size ? `taille ${size}` : 'taille unique');

function onError(toast: ReturnType<typeof useToast>) {
  return (e: unknown) => toast(e instanceof Error ? e.message : 'Erreur', 'error');
}

function ItemSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const empty = {
    name: '',
    category: 'SUPPLY' as StockCategory,
    sizes: '',
    unitPrice: '',
    alertThreshold: '',
  };
  const [form, setForm] = useState(empty);
  const save = useMutation({
    mutationFn: () =>
      api('/stock/items', {
        method: 'POST',
        body: {
          name: form.name,
          category: form.category,
          sizes: form.sizes
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          unitPrice: Number(form.unitPrice || 0),
          alertThreshold: Number(form.alertThreshold || 0),
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stock'] });
      toast('Article créé');
      setForm(empty);
      onClose();
    },
    onError: onError(toast),
  });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Nouvel article"
      footer={
        <Button block onClick={() => save.mutate()} loading={save.isPending} disabled={!form.name}>
          Créer l’article
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <InputField
          label="Désignation"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          containerClassName="sm:col-span-2"
        />
        <SelectField
          label="Catégorie"
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value as StockCategory })}
        >
          {STOCK_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {STOCK_CATEGORY_LABELS[c]}
            </option>
          ))}
        </SelectField>
        <InputField
          label="Tailles"
          value={form.sizes}
          onChange={(e) => setForm({ ...form, sizes: e.target.value })}
          hint="Séparées par des virgules, par exemple S, M, L"
          optional
        />
        <InputField
          label="Prix de vente (FCFA)"
          type="number"
          inputMode="numeric"
          min={0}
          value={form.unitPrice}
          onChange={(e) => setForm({ ...form, unitPrice: e.target.value })}
        />
        <InputField
          label="Seuil d’alerte"
          type="number"
          inputMode="numeric"
          min={0}
          value={form.alertThreshold}
          onChange={(e) => setForm({ ...form, alertThreshold: e.target.value })}
          optional
        />
      </div>
    </Sheet>
  );
}

function OperationSheet({
  operation,
  items,
  onClose,
}: {
  operation: Operation | null;
  items: Item[];
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [itemId, setItemId] = useState('');
  const [size, setSize] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitCost, setUnitCost] = useState('');
  const [supplier, setSupplier] = useState('');
  const [reason, setReason] = useState('');
  const [student, setStudent] = useState<PickedStudent | null>(null);
  // Clé d'idempotence d'une vente : un nouvel envoi (réseau lent) ne facture pas deux fois.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const item = items.find((i) => i.id === itemId);
  const sizes = item?.sizes ?? [];
  const reset = () => {
    setQuantity('1');
    setUnitCost('');
    setSupplier('');
    setReason('');
    setStudent(null);
    setRequestId(crypto.randomUUID());
  };
  const save = useMutation({
    mutationFn: () => {
      const base = { itemId, size, quantity: Number(quantity) };
      if (operation === 'purchase')
        return api('/stock/purchases', {
          method: 'POST',
          body: { ...base, unitCost: Number(unitCost || 0), supplier },
        });
      if (operation === 'sale')
        return api('/stock/sales', {
          method: 'POST',
          body: { ...base, studentId: student?.id, requestId },
        });
      return api('/stock/allocations', { method: 'POST', body: { ...base, reason } });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stock'] });
      toast(
        operation === 'sale'
          ? 'Vente enregistrée et ajoutée à l’échéancier de l’élève'
          : 'Mouvement enregistré',
      );
      reset();
      onClose();
    },
    onError: onError(toast),
  });
  const ready =
    !!itemId &&
    Number(quantity) > 0 &&
    (operation === 'purchase'
      ? supplier.trim().length > 0
      : operation === 'sale'
        ? !!student
        : reason.trim().length >= 3);
  return (
    <Sheet
      open={!!operation}
      onClose={onClose}
      title={operation ? OPERATION_TITLES[operation] : ''}
      footer={
        <Button block onClick={() => save.mutate()} loading={save.isPending} disabled={!ready}>
          {operation === 'sale' && item
            ? `Vendre (${formatFcfa(item.unitPrice * Math.max(0, Number(quantity) || 0))})`
            : 'Enregistrer'}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <SelectField
          label="Article"
          value={itemId}
          onChange={(e) => {
            setItemId(e.target.value);
            setSize(items.find((i) => i.id === e.target.value)?.sizes[0]?.size ?? '');
          }}
        >
          <option value="">Choisir un article</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </SelectField>
        <div className="grid gap-4 sm:grid-cols-2">
          {sizes.length > 1 || (sizes[0] && sizes[0].size) ? (
            <SelectField label="Taille" value={size} onChange={(e) => setSize(e.target.value)}>
              {sizes.map((s) => (
                <option key={s.size} value={s.size}>
                  {s.size} · {s.onHand} en stock
                </option>
              ))}
            </SelectField>
          ) : null}
          <InputField
            label="Quantité"
            type="number"
            inputMode="numeric"
            min={1}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </div>
        {operation === 'purchase' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <InputField
              label="Coût unitaire (FCFA)"
              type="number"
              inputMode="numeric"
              min={0}
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
            />
            <InputField
              label="Fournisseur"
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
            />
          </div>
        ) : operation === 'sale' ? (
          <StudentPicker value={student} onChange={setStudent} />
        ) : (
          <InputField
            label="Motif"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Équipe de football, salle des professeurs…"
          />
        )}
      </div>
    </Sheet>
  );
}

function ItemsTab({ items }: { items: Item[] }) {
  if (items.length === 0)
    return <EmptyState title="Aucun article">Créez un premier article.</EmptyState>;
  return (
    <ul className="grid gap-3 md:grid-cols-2" aria-label="Articles">
      {items.map((i) => (
        <li key={i.id}>
          <Card className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 flex-col">
                <strong className="[overflow-wrap:anywhere]">{i.name}</strong>
                <span className="text-[13px] text-muted">
                  {STOCK_CATEGORY_LABELS[i.category]} · {formatFcfa(i.unitPrice)} l’unité
                </span>
              </div>
              {i.low ? <Badge tone="warn">Stock bas</Badge> : null}
            </div>
            <ul className="flex flex-wrap gap-2 text-sm">
              {i.sizes.map((s) => (
                <li
                  key={s.size}
                  className={`rounded-[10px] border px-2.5 py-1 tabular ${s.low ? 'border-warn bg-warn-soft' : 'border-line'}`}
                >
                  {s.size || 'Stock'} : <strong>{s.onHand}</strong>
                </li>
              ))}
            </ul>
            <span className="text-[13px] text-muted">
              Valeur : {formatFcfa(i.value)} (coût moyen {formatFcfa(i.averageCost)})
            </span>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function MovementsTab({ canWrite }: { canWrite: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [creditFor, setCreditFor] = useState<CreditNoteTarget | null>(null);
  const q = useQuery({
    queryKey: ['stock', 'movements', page],
    queryFn: () => api<Paged<Movement>>(`/stock/movements?page=${page}&pageSize=30`),
    placeholderData: keepPreviousData,
  });
  const reverse = useMutation({
    mutationFn: (id: string) =>
      api<{ invoiced: boolean; credited: number; carriedOver: number; notCredited: number }>(
        `/stock/movements/${id}/reverse`,
        {
          method: 'POST',
          body: { reason: 'Correction de saisie' },
        },
      ),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['stock'] });
      if (!r.invoiced) return toast('Mouvement corrigé par un mouvement inverse');
      // Ce qui restait dû est annulé ; ce qui était payé est reporté sur la scolarité de l'élève ;
      // s'il n'y a plus rien à payer, la caisse rend l'argent.
      const parts = [
        r.credited > 0 ? `${formatFcfa(r.credited)} annulés sur la facture` : null,
        r.carriedOver > 0
          ? `${formatFcfa(r.carriedOver)} déjà payés reportés sur les prochaines échéances`
          : null,
        r.notCredited > 0 ? `${formatFcfa(r.notCredited)} à rendre en espèces` : null,
      ].filter(Boolean);
      toast(`Vente annulée : ${parts.join(' ; ') || 'rien à reprendre sur la facture'}`);
    },
    onError: onError(toast),
  });
  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => q.refetch()} />;
  if (q.data.items.length === 0) return <EmptyState title="Aucun mouvement" />;
  const pages = Math.max(1, Math.ceil(q.data.total / q.data.pageSize));
  return (
    <>
      <ul className="flex flex-col gap-2" aria-label="Mouvements de stock">
        {q.data.items.map((m) => (
          <li
            key={m.id}
            className="flex flex-col gap-2 rounded-[14px] border border-line bg-white p-3 md:flex-row md:items-center md:justify-between"
          >
            <div className="flex min-w-0 flex-col">
              <strong className="[overflow-wrap:anywhere]">
                {m.item.name} · {sizeText(m.size)}
              </strong>
              <span className="text-[13px] text-muted">
                {m.typeLabel}
                {m.supplier ? ` · ${m.supplier}` : ''}
                {m.student ? ` · ${m.student.name}` : ''}
                {m.reason ? ` · ${m.reason}` : ''} · {formatDateTime(m.createdAt)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <strong className={`tabular ${m.quantity < 0 ? 'text-danger' : 'text-primary'}`}>
                {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
              </strong>
              {m.invoiced ? <Badge tone="info">Facturé</Badge> : null}
              {canWrite && m.reversible ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => reverse.mutate(m.id)}
                  aria-label={`Corriger le mouvement ${m.typeLabel} de ${m.item.name}`}
                >
                  Corriger
                </Button>
              ) : null}
              {canWrite && m.type === 'SALE' && m.invoiced ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setCreditFor({
                      url: `/stock/movements/${m.id}/credit`,
                      label: `la vente ${m.item.name}${m.student ? ` à ${m.student.name}` : ''}`,
                    })
                  }
                  aria-label={`Avoir sur la vente ${m.item.name}`}
                >
                  Avoir
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <CreditNoteSheet
        target={creditFor}
        onClose={() => setCreditFor(null)}
        onDone={() => void qc.invalidateQueries({ queryKey: ['stock'] })}
      />
      {pages > 1 ? (
        <div className="flex justify-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            Précédent
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
          >
            Suivant
          </Button>
        </div>
      ) : null}
    </>
  );
}

function InventoryTab({ items, canCount }: { items: Item[]; canCount: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const rows = items.flatMap((i) =>
    i.sizes.map((s) => ({ key: `${i.id}|${s.size}`, itemId: i.id, name: i.name, ...s })),
  );
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () =>
      api<{ gaps: unknown[] }>('/stock/inventories', {
        method: 'POST',
        body: {
          lines: rows.map((r) => ({
            itemId: r.itemId,
            size: r.size,
            counted: counted[r.key] === undefined ? r.onHand : Number(counted[r.key] || 0),
            reason: reasons[r.key] || null,
          })),
        },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['stock'] });
      toast(
        r.gaps.length
          ? `Inventaire enregistré : ${r.gaps.length} écart(s) ajusté(s)`
          : 'Inventaire conforme',
      );
      setCounted({});
      setReasons({});
    },
    onError: (e) => {
      toast(
        e instanceof ApiError && e.fieldErrors.length
          ? 'Justifiez chaque écart avant d’enregistrer'
          : e instanceof Error
            ? e.message
            : 'Erreur',
        'error',
      );
    },
  });
  if (!canCount)
    return <EmptyState title="Inventaire réservé à la comptabilité et à la direction" />;
  if (rows.length === 0) return <EmptyState title="Aucun article à compter" />;
  return (
    <Card className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Saisissez les quantités comptées. Chaque écart doit être justifié ; il devient un mouvement
        d’ajustement.
      </p>
      <ul className="flex flex-col gap-3" aria-label="Comptage">
        {rows.map((r) => {
          const value = counted[r.key] ?? String(r.onHand);
          const gap = Number(value || 0) - r.onHand;
          return (
            <li key={r.key} className="grid gap-2 border-t border-line pt-3 sm:grid-cols-3">
              <div className="flex flex-col">
                <strong>{r.name}</strong>
                <span className="text-[13px] text-muted">
                  {sizeText(r.size)} · attendu {r.onHand}
                </span>
              </div>
              <InputField
                label={`Compté : ${r.name} ${sizeText(r.size)}`}
                type="number"
                inputMode="numeric"
                min={0}
                value={value}
                onChange={(e) => setCounted({ ...counted, [r.key]: e.target.value })}
              />
              {gap !== 0 ? (
                <InputField
                  label={`Justification de l’écart (${gap > 0 ? '+' : ''}${gap})`}
                  value={reasons[r.key] ?? ''}
                  onChange={(e) => setReasons({ ...reasons, [r.key]: e.target.value })}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      <Button onClick={() => save.mutate()} loading={save.isPending} className="self-start">
        Enregistrer l’inventaire
      </Button>
    </Card>
  );
}

export default function StockPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('items');
  const [sheet, setSheet] = useState<'item' | Operation | null>(null);
  const q = useQuery({ queryKey: ['stock', 'items'], queryFn: () => api<Item[]>('/stock/items') });
  const items = q.data ?? [];
  const low = items.filter((i) => i.low);
  const canWrite = can('stock.write');
  return (
    <>
      <PageHeader
        title="Stock et uniformes"
        subtitle="Fournitures et uniformes : achats, ventes facturées par la scolarité, dotations et inventaires."
        actions={
          canWrite ? (
            <>
              <Button onClick={() => setSheet('sale')}>Vendre à un élève</Button>
              <Button variant="secondary" onClick={() => setSheet('purchase')}>
                Entrée de stock
              </Button>
              <Button variant="secondary" onClick={() => setSheet('allocation')}>
                Dotation interne
              </Button>
              <Button variant="secondary" onClick={() => setSheet('item')}>
                <Plus className="size-4" aria-hidden />
                Nouvel article
              </Button>
            </>
          ) : undefined
        }
      />
      {q.data ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <Stat label="Articles" value={items.length} />
          <Stat
            label="Valeur du stock"
            value={formatFcfa(items.reduce((s, i) => s + i.value, 0))}
          />
          <Stat label="Sous le seuil" value={low.length} tone={low.length ? 'danger' : 'default'} />
        </div>
      ) : null}
      {low.length > 0 ? (
        <section
          className="flex gap-3 rounded-[14px] bg-warn-soft p-4"
          aria-label="Alertes de stock"
        >
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
          <p className="text-sm">
            Stock bas :{' '}
            {low
              .map(
                (i) =>
                  `${i.name} (${i.sizes
                    .filter((s) => s.low)
                    .map((s) => s.size || 'stock')
                    .join(', ')})`,
              )
              .join(' ; ')}
          </p>
        </section>
      ) : null}
      <PillTabs label="Rubriques du stock" tabs={TABS} value={tab} onChange={setTab} />
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : tab === 'items' ? (
        <ItemsTab items={items} />
      ) : tab === 'movements' ? (
        <MovementsTab canWrite={canWrite} />
      ) : (
        <InventoryTab items={items} canCount={can('stock.inventory')} />
      )}
      <ItemSheet open={sheet === 'item'} onClose={() => setSheet(null)} />
      <OperationSheet
        operation={sheet === 'item' ? null : sheet}
        items={items}
        onClose={() => setSheet(null)}
      />
    </>
  );
}
