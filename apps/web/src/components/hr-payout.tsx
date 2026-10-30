'use client';

import { formatFcfa, PAYMENT_METHODS, STAFF_PAYOUT_METHOD_LABELS } from '@ecole/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { InputField, SelectField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { formatDate, todayIso } from '@/lib/format';
import type { PayoutView } from '@/lib/hr';

/** Enregistrement d'un versement (salaires ou avance) : date, mode et référence. */
export function PayoutSheet({
  open,
  onClose,
  title,
  path,
  amount,
  debitAccount,
  success,
  intro,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  path: string;
  amount: number;
  debitAccount: string;
  success: string;
  intro: string;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const pay = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(path, { method: 'POST', body }),
    onSuccess: () => {
      toast(success);
      setErrors({});
      void queryClient.invalidateQueries({ queryKey: ['hr'] });
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fieldErrors.length)
        setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.path, f.message])));
      toast(e instanceof Error ? e.message : 'Erreur', 'error');
    },
  });
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          pay.mutate({
            date: fd.get('date'),
            method: fd.get('method'),
            reference: fd.get('reference') || undefined,
          });
        }}
      >
        <p className="text-sm">
          {intro} Montant : <strong className="tabular">{formatFcfa(amount)}</strong>.
        </p>
        <InputField
          label="Date du versement"
          name="date"
          type="date"
          required
          defaultValue={todayIso()}
          max={todayIso()}
          error={errors.date}
        />
        <SelectField label="Mode de versement" name="method" defaultValue="BANK" required>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {STAFF_PAYOUT_METHOD_LABELS[m]}
            </option>
          ))}
        </SelectField>
        <InputField
          label="Référence (virement, bordereau, transaction)"
          name="reference"
          maxLength={60}
          error={errors.reference}
        />
        <p className="text-[13px] text-muted">
          Le versement est définitif et journalisé. Si la comptabilité est activée, l’écriture est
          passée aussitôt : compte {debitAccount} au débit, caisse, banque ou Mobile Money au
          crédit. Il doit être enregistré par une autre personne que celle qui a validé, sauf si
          personne d’autre n’en a le droit.
        </p>
        <Button type="submit" loading={pay.isPending}>
          Enregistrer le versement
        </Button>
      </form>
    </Sheet>
  );
}

/** Résumé d'un versement enregistré. */
export function payoutSummary(p: PayoutView): string {
  return [
    `Versée le ${formatDate(p.date)}`,
    STAFF_PAYOUT_METHOD_LABELS[p.method],
    p.reference ? `réf. ${p.reference}` : null,
    p.paidBy ? `par ${p.paidBy}` : null,
    p.entry ? `écriture ${p.entry}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
