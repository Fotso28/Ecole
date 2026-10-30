'use client';

import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { InputField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatFcfa } from '@/lib/format';

export interface CreditNoteTarget {
  /** Route de l'avoir, par exemple `/transport/subscriptions/:id/credit`. */
  url: string;
  /** Ce qui est crédité, repris dans le titre (« abonnement de Awa Bello »). */
  label: string;
}

/**
 * Avoir sur la facture d'un abonnement ou d'une vente, saisi par le gestionnaire du module :
 * limité à la ligne concernée et à son reste dû.
 */
export function CreditNoteSheet({
  target,
  onClose,
  onDone,
}: {
  target: CreditNoteTarget | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    setAmount('');
    setReason('');
  }, [target]);
  const save = useMutation({
    mutationFn: () =>
      api<{ credited: number }>(target!.url, {
        method: 'POST',
        body: { amount: Number(amount), reason },
      }),
    onSuccess: (r) => {
      toast(`Avoir de ${formatFcfa(r.credited)} enregistré sur la facture`);
      onDone();
      onClose();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  return (
    <Sheet
      open={!!target}
      onClose={onClose}
      title={target ? `Avoir sur ${target.label}` : 'Avoir'}
      footer={
        <Button
          block
          onClick={() => save.mutate()}
          loading={save.isPending}
          disabled={!(Number(amount) > 0) || reason.trim().length < 5}
        >
          Enregistrer l’avoir
        </Button>
      }
    >
      <div className="grid gap-4">
        <InputField
          label="Montant de l’avoir (FCFA)"
          type="number"
          inputMode="numeric"
          min={1}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          hint="Au plus le reste dû sur cette ligne de facture"
        />
        <InputField
          label="Motif"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="5 caractères au moins"
        />
      </div>
    </Sheet>
  );
}
