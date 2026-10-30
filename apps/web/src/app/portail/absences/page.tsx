'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, ErrorBlock, LoadingBlock } from '@/components/ui/card';
import { TextareaField } from '@/components/ui/field';
import { FilePicker } from '@/components/ui/file-picker';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { ChildSwitcher, useChildren } from '@/components/shell/parent-shell';
import { api, uploadFile } from '@/lib/api';
import { formatWeekday } from '@/lib/format';
import { useChildOverview } from '@/lib/portal';

export default function PortalAbsences() {
  const { selected } = useChildren();
  const toast = useToast();
  const queryClient = useQueryClient();
  const q = useChildOverview(selected?.id);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [attachTo, setAttachTo] = useState<string | null>(null);
  const [later, setLater] = useState<File | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['portal-child', selected?.id] });
  const justify = useMutation({
    mutationFn: async () => {
      const j = await api<{ id: string }>('/portal/justifications', {
        method: 'POST',
        body: { studentId: selected?.id, recordIds: [...chosen], reason },
      });
      if (!file) return { attached: true };
      try {
        await uploadFile(`/portal/justifications/${j.id}/attachment`, file);
        return { attached: true };
      } catch {
        return { attached: false };
      }
    },
    onSuccess: ({ attached }) => {
      if (attached) toast('Justificatif envoyé à la vie scolaire');
      else
        toast(
          'Justificatif envoyé, mais la pièce jointe n’est pas passée : ajoutez-la depuis l’historique',
          'error',
        );
      setChosen(new Set());
      setReason('');
      setFile(null);
      void refresh();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const attach = useMutation({
    mutationFn: () => uploadFile(`/portal/justifications/${attachTo}/attachment`, later!),
    onSuccess: () => {
      toast('Pièce jointe envoyée');
      setAttachTo(null);
      setLater(null);
      void refresh();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  if (!selected || q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorBlock error={q.error} />;
  const toJustify = q.data.absences.filter((a) => !a.justification);
  return (
    <>
      <ChildSwitcher />
      {toJustify.length > 0 ? (
        <Card className="flex flex-col gap-3">
          <CardHeader
            title="À justifier"
            subtitle="Cochez les absences concernées puis indiquez le motif."
          />
          <ul className="flex flex-col">
            {toJustify.map((a) => (
              <li key={a.id} className="border-t border-line first:border-t-0">
                <label className="flex min-h-14 items-center gap-3">
                  <input
                    type="checkbox"
                    className="size-5 accent-primary"
                    checked={chosen.has(a.id)}
                    onChange={() =>
                      setChosen((s) => {
                        const n = new Set(s);
                        if (n.has(a.id)) n.delete(a.id);
                        else n.add(a.id);
                        return n;
                      })
                    }
                  />
                  <span className="flex flex-1 flex-col">
                    <strong className="text-[15px]">
                      {formatWeekday(a.date).replace(/^./, (c) => c.toUpperCase())}
                    </strong>
                    <span className="text-[13px] text-muted">
                      {a.startTime}–{a.endTime}
                    </span>
                  </span>
                  <Badge tone={a.status === 'ABSENT' ? 'danger' : 'warn'}>
                    {a.status === 'ABSENT' ? 'Absence' : 'Retard'}
                  </Badge>
                </label>
              </li>
            ))}
          </ul>
          <TextareaField
            label="Motif"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ex. consultation médicale"
          />
          <FilePicker
            label="Pièce jointe (facultatif) : certificat médical, convocation…"
            value={file}
            onChange={setFile}
          />
          <Button
            size="lg"
            onClick={() => justify.mutate()}
            loading={justify.isPending}
            disabled={chosen.size === 0 || reason.trim().length < 3}
          >
            Envoyer le justificatif
          </Button>
        </Card>
      ) : null}
      <Card>
        <CardHeader title="Historique" />
        {q.data.absences.length === 0 ? (
          <p className="text-sm text-muted">Aucune absence ni retard.</p>
        ) : (
          <ul className="flex flex-col">
            {q.data.absences.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line py-2.5 text-sm first:border-t-0"
              >
                <span className="flex-1">
                  {formatWeekday(a.date)} · {a.startTime}–{a.endTime}
                </span>
                <Badge tone={a.status === 'ABSENT' ? 'danger' : 'warn'}>
                  {a.status === 'ABSENT' ? 'Absence' : 'Retard'}
                </Badge>
                {a.justification === 'ACCEPTED' ? (
                  <Badge tone="info">Justifiée</Badge>
                ) : a.justification === 'PENDING' ? (
                  <Badge>En examen</Badge>
                ) : null}
                {a.justification === 'PENDING' && a.justificationId && !a.hasAttachment ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="basis-full justify-start"
                    onClick={() => setAttachTo(a.justificationId)}
                  >
                    Ajouter une pièce jointe
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Sheet
        open={!!attachTo}
        onClose={() => {
          setAttachTo(null);
          setLater(null);
        }}
        title="Ajouter une pièce jointe"
        footer={
          <Button
            block
            size="lg"
            disabled={!later}
            loading={attach.isPending}
            onClick={() => attach.mutate()}
          >
            Envoyer la pièce jointe
          </Button>
        }
      >
        {attachTo ? (
          <FilePicker label="Certificat médical, convocation…" value={later} onChange={setLater} />
        ) : null}
      </Sheet>
    </>
  );
}
