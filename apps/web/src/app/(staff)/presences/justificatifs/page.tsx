'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatFileSize } from '@ecole/shared';
import { Paperclip, Plus } from 'lucide-react';
import { useState } from 'react';
import { StudentPicker, type PickedStudent } from '@/components/students/student-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { TextareaField } from '@/components/ui/field';
import { FilePicker } from '@/components/ui/file-picker';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, openFile, uploadFile } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatShortDate } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Justification {
  id: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  reason: string;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  attachment: { id: string; name: string; mimeType: string; size: number } | null;
  hasAttachment: boolean;
  student: { id: string; firstName: string; lastName: string; matricule: string } | null;
  records: {
    id: string;
    date: string;
    startTime: string;
    endTime: string;
    status: 'ABSENT' | 'LATE';
  }[];
}

interface StudentRecord {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: 'PRESENT' | 'ABSENT' | 'LATE';
  justification: { id: string; status: string } | null;
}

const TABS = [
  ['PENDING', 'À traiter'],
  ['ACCEPTED', 'Acceptés'],
  ['REJECTED', 'Refusés'],
] as const;

export default function JustificationsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Justification['status']>('PENDING');
  const [rejecting, setRejecting] = useState<Justification | null>(null);
  const [note, setNote] = useState('');
  const [entering, setEntering] = useState(false);
  const q = useQuery({
    queryKey: ['justifications', status],
    queryFn: () => api<Justification[]>(`/attendance/justifications?status=${status}`),
  });
  const review = useMutation({
    mutationFn: ({
      id,
      decision,
      note,
    }: {
      id: string;
      decision: 'ACCEPTED' | 'REJECTED';
      note?: string;
    }) => api(`/attendance/justifications/${id}`, { method: 'PATCH', body: { decision, note } }),
    onSuccess: (_d, v) => {
      toast(
        v.decision === 'ACCEPTED' ? 'Absence justifiée' : 'Justificatif refusé, parent prévenu',
      );
      setRejecting(null);
      setNote('');
      void queryClient.invalidateQueries({ queryKey: ['justifications'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const justify = can('attendance.justify');

  return (
    <>
      <PageHeader
        title="Justificatifs d’absence"
        subtitle="Déposés par les parents depuis le portail ou saisis par la vie scolaire."
        actions={
          justify ? (
            <Button onClick={() => setEntering(true)}>
              <Plus className="size-4" aria-hidden />
              Saisir un justificatif
            </Button>
          ) : null
        }
      />
      <div role="tablist" className="flex gap-2">
        {TABS.map(([value, label]) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={status === value}
            onClick={() => setStatus(value)}
            className={cn(
              'min-h-11 rounded-full border px-4 text-sm font-semibold lg:min-h-9',
              status === value
                ? 'border-primary bg-primary text-white'
                : 'border-line-strong bg-white',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState title="Aucun justificatif" />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {q.data.map((j) => (
            <li key={j.id}>
              <Card className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <strong>
                      {j.student?.lastName} {j.student?.firstName}
                    </strong>
                    <p className="text-xs text-muted">Déposé le {formatDateTime(j.createdAt)}</p>
                  </div>
                  <Badge
                    tone={
                      j.status === 'PENDING'
                        ? 'warn'
                        : j.status === 'ACCEPTED'
                          ? 'success'
                          : 'danger'
                    }
                  >
                    {j.status === 'PENDING'
                      ? 'À traiter'
                      : j.status === 'ACCEPTED'
                        ? 'Accepté'
                        : 'Refusé'}
                  </Badge>
                </div>
                <p className="rounded-[10px] bg-paper p-3 text-sm">« {j.reason} »</p>
                <ul className="flex flex-col gap-1 text-sm" aria-label="Absences concernées">
                  {j.records.map((r) => (
                    <li key={r.id}>
                      {r.status === 'ABSENT' ? 'Absence' : 'Retard'} du {formatShortDate(r.date)},{' '}
                      {r.startTime}–{r.endTime}
                    </li>
                  ))}
                </ul>
                {j.status === 'REJECTED' && j.reviewNote ? (
                  <p className="text-sm">
                    <span className="font-semibold">Motif du refus :</span> {j.reviewNote}
                  </p>
                ) : null}
                {j.hasAttachment ? (
                  j.attachment ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="self-start"
                      aria-label={`Voir la pièce jointe de ${j.student?.firstName ?? 'l’élève'} (${formatFileSize(j.attachment.size)})`}
                      onClick={() =>
                        openFile(`/attendance/justifications/${j.id}/attachment`).catch((e) =>
                          toast(e instanceof Error ? e.message : 'Erreur', 'error'),
                        )
                      }
                    >
                      <Paperclip className="size-4" aria-hidden />
                      Voir la pièce jointe · {formatFileSize(j.attachment.size)}
                    </Button>
                  ) : (
                    <p className="flex items-center gap-1.5 text-sm text-muted">
                      <Paperclip className="size-4" aria-hidden />
                      Pièce jointe fournie
                    </p>
                  )
                ) : null}
                {j.status === 'PENDING' && justify ? (
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setNote('');
                        setRejecting(j);
                      }}
                      disabled={review.isPending}
                    >
                      Refuser
                    </Button>
                    <Button
                      onClick={() => review.mutate({ id: j.id, decision: 'ACCEPTED' })}
                      loading={review.isPending && review.variables?.id === j.id}
                    >
                      Accepter
                    </Button>
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Sheet
        open={!!rejecting}
        onClose={() => setRejecting(null)}
        title="Refuser le justificatif"
        footer={
          <Button
            block
            size="lg"
            variant="danger"
            disabled={note.trim().length < 3}
            loading={review.isPending}
            onClick={() =>
              rejecting &&
              review.mutate({ id: rejecting.id, decision: 'REJECTED', note: note.trim() })
            }
          >
            Refuser et prévenir le parent
          </Button>
        }
      >
        {rejecting ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              {rejecting.student?.lastName} {rejecting.student?.firstName} · « {rejecting.reason} »
            </p>
            <TextareaField
              label="Motif du refus"
              hint="Communiqué au parent par SMS. Les absences restent à justifier."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
              placeholder="Ex. certificat médical illisible, merci d’en apporter l’original"
            />
          </div>
        ) : null}
      </Sheet>
      {justify ? (
        <EnterJustification
          open={entering}
          onClose={() => setEntering(false)}
          onSaved={() => {
            setEntering(false);
            setStatus('PENDING');
            void queryClient.invalidateQueries({ queryKey: ['justifications'] });
          }}
        />
      ) : null}
    </>
  );
}

/** Justificatif apporté à l'école (certificat papier…), saisi par la vie scolaire. */
function EnterJustification({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [student, setStudent] = useState<PickedStudent[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const studentId = student[0]?.id;
  const records = useQuery({
    queryKey: ['attendance-student', studentId],
    queryFn: () => api<StudentRecord[]>(`/attendance/students/${studentId}`),
    enabled: open && !!studentId,
  });
  const toJustify = (records.data ?? []).filter((r) => r.status !== 'PRESENT' && !r.justification);
  const reset = () => {
    setStudent([]);
    setChosen(new Set());
    setReason('');
    setFile(null);
  };
  const save = useMutation({
    mutationFn: async () => {
      const j = await api<{ id: string }>('/attendance/justifications', {
        method: 'POST',
        body: { studentId, recordIds: [...chosen], reason: reason.trim() },
      });
      if (!file) return { attached: true };
      try {
        await uploadFile(`/attendance/justifications/${j.id}/attachment`, file);
        return { attached: true };
      } catch {
        return { attached: false };
      }
    },
    onSuccess: ({ attached }) => {
      if (attached) toast('Justificatif enregistré : il reste à l’accepter ou le refuser');
      else toast('Justificatif enregistré, mais la pièce jointe n’est pas passée', 'error');
      reset();
      onSaved();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  return (
    <Sheet
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Saisir un justificatif"
      footer={
        <Button
          block
          size="lg"
          disabled={!studentId || chosen.size === 0 || reason.trim().length < 3}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          Enregistrer le justificatif
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          Pour un certificat ou un mot apporté à l’école par la famille.
        </p>
        <StudentPicker
          value={student}
          onChange={(next) => {
            setStudent(next);
            setChosen(new Set());
          }}
        />
        {studentId ? (
          records.isPending ? (
            <LoadingBlock />
          ) : records.isError ? (
            <ErrorBlock error={records.error} onRetry={() => records.refetch()} />
          ) : toJustify.length === 0 ? (
            <p className="text-sm text-muted" role="status">
              Aucune absence ni aucun retard à justifier pour cet élève.
            </p>
          ) : (
            <fieldset className="flex flex-col">
              <legend className="mb-1 text-sm font-semibold">Absences concernées</legend>
              {toJustify.map((r) => (
                <label
                  key={r.id}
                  className="flex min-h-12 items-center gap-3 border-t border-line text-sm first-of-type:border-t-0"
                >
                  <input
                    type="checkbox"
                    className="size-5 accent-primary"
                    checked={chosen.has(r.id)}
                    onChange={() =>
                      setChosen((s) => {
                        const n = new Set(s);
                        if (n.has(r.id)) n.delete(r.id);
                        else n.add(r.id);
                        return n;
                      })
                    }
                  />
                  <span className="flex-1">
                    {r.status === 'ABSENT' ? 'Absence' : 'Retard'} du {formatShortDate(r.date)},{' '}
                    {r.startTime}–{r.endTime}
                  </span>
                </label>
              ))}
            </fieldset>
          )
        ) : null}
        <TextareaField
          label="Motif"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          placeholder="Ex. certificat médical du Dr Abena"
        />
        <FilePicker
          label="Pièce jointe (facultatif) : photo du certificat"
          value={file}
          onChange={setFile}
        />
      </div>
    </Sheet>
  );
}
