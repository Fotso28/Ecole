'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { FilePicker } from '@/components/ui/file-picker';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, uploadFile, type FileLink } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, initials } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface PhotoState {
  consent: boolean;
  consentAt: string | null;
  consentBy: string | null;
  hasPhoto: boolean;
}

/** Photo d'identité (lien signé de courte durée), ou initiales sans photo ni consentement. */
export function StudentAvatar({
  studentId,
  name,
  hasPhoto,
  className,
}: {
  studentId: string;
  name: string;
  hasPhoto: boolean;
  className?: string;
}) {
  const link = useQuery({
    queryKey: ['student-photo', studentId],
    queryFn: () => api<FileLink>(`/students/${studentId}/photo`),
    enabled: hasPhoto,
    // Le lien expire après quelques minutes : il est redemandé avant.
    staleTime: 120_000,
    refetchInterval: 240_000,
  });
  const box = cn(
    'flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-[18px] bg-primary-soft font-display text-2xl font-bold text-primary lg:size-20',
    className,
  );
  if (hasPhoto && link.data)
    return <img src={link.data.url} alt={`Photo de ${name}`} className={cn(box, 'object-cover')} />;
  return (
    <span className={box} aria-hidden>
      {initials(name)}
    </span>
  );
}

/**
 * Consentement à la photo (date, auteur, journalisé par l'API) et dépôt de la photo, possible
 * seulement avec le consentement. Le retrait du consentement supprime la photo.
 */
export function PhotoCard({ studentId, photo }: { studentId: string; photo: PhotoState }) {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const editable = can('students.write');
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['student', studentId] });
    void queryClient.invalidateQueries({ queryKey: ['student-photo', studentId] });
  };
  const onError = (e: unknown) => toast(e instanceof Error ? e.message : 'Erreur', 'error');

  const consent = useMutation({
    mutationFn: (value: boolean) =>
      api(`/students/${studentId}/photo-consent`, { method: 'PUT', body: { consent: value } }),
    onSuccess: (_, value) => {
      setWithdrawOpen(false);
      toast(value ? 'Consentement à la photo enregistré' : 'Consentement retiré, photo supprimée');
      refresh();
    },
    onError,
  });
  const upload = useMutation({
    mutationFn: () => uploadFile(`/students/${studentId}/photo`, file!),
    onSuccess: () => {
      setFile(null);
      setUploadOpen(false);
      toast('Photo enregistrée');
      refresh();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => api(`/students/${studentId}/photo`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Photo supprimée');
      refresh();
    },
    onError,
  });

  return (
    <Card>
      <CardHeader title="Photo d’identité" />
      <div className="flex flex-col gap-3 text-sm">
        <p className="flex items-start gap-2">
          {photo.consent ? (
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          ) : (
            <ShieldOff className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          )}
          <span>
            {photo.consent ? 'Consentement des parents donné' : 'Pas de consentement à la photo'}
            {photo.consentAt ? (
              <span className="block text-[13px] text-muted">
                {photo.consent ? 'Enregistré' : 'Retiré'} le {formatDateTime(photo.consentAt)}
                {photo.consentBy ? ` par ${photo.consentBy}` : ''}
              </span>
            ) : null}
          </span>
        </p>
        {photo.consent ? (
          <p className="text-[13px] text-muted">
            {photo.hasPhoto ? 'Photo déposée, chiffrée.' : 'Aucune photo déposée.'}
          </p>
        ) : null}
        {editable ? (
          <div className="flex flex-wrap gap-2">
            {photo.consent ? (
              <>
                <Button size="sm" onClick={() => setUploadOpen(true)}>
                  <Camera className="size-4" aria-hidden />
                  {photo.hasPhoto ? 'Remplacer la photo' : 'Déposer la photo'}
                </Button>
                {photo.hasPhoto ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    <Trash2 className="size-4" aria-hidden />
                    Supprimer la photo
                  </Button>
                ) : null}
                <Button size="sm" variant="danger" onClick={() => setWithdrawOpen(true)}>
                  Retirer le consentement
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                loading={consent.isPending}
                onClick={() => consent.mutate(true)}
              >
                <ShieldCheck className="size-4" aria-hidden />
                Enregistrer le consentement
              </Button>
            )}
          </div>
        ) : null}
      </div>

      <Sheet
        open={uploadOpen}
        onClose={() => {
          setFile(null);
          setUploadOpen(false);
        }}
        title="Photo d’identité"
        footer={
          <Button
            block
            size="lg"
            disabled={!file}
            loading={upload.isPending}
            onClick={() => upload.mutate()}
          >
            Enregistrer la photo
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            Photo de face, JPEG ou PNG. Elle est chiffrée et n’apparaît que sur la fiche et la carte
            d’élève.
          </p>
          <FilePicker label="Photo de l’élève" value={file} onChange={setFile} />
        </div>
      </Sheet>

      <Sheet
        open={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
        title="Retirer le consentement ?"
        footer={
          <Button
            block
            size="lg"
            variant="danger"
            loading={consent.isPending}
            onClick={() => consent.mutate(false)}
          >
            Retirer et supprimer la photo
          </Button>
        }
      >
        <p className="text-sm">
          La photo est supprimée : elle n’apparaît plus sur la fiche ni sur les cartes d’élève. Le
          retrait est daté et journalisé.
        </p>
      </Sheet>
    </Card>
  );
}
