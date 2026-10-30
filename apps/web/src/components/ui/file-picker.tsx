'use client';

import { FILE_ACCEPT, formatFileSize, MAX_FILE_BYTES } from '@ecole/shared';
import { Camera, FileText, Upload, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { prepareUpload } from '@/lib/files';
import { cn } from '@/lib/utils';

interface FilePickerProps {
  label: string;
  value: File | null;
  onChange: (file: File | null) => void;
  /** Propose la prise de photo directe (téléphone). */
  camera?: boolean;
  disabled?: boolean;
}

const pickClass =
  'relative flex min-h-12 flex-1 cursor-pointer items-center justify-center gap-2 rounded-[10px] border border-line-strong bg-white px-3 text-[15px] font-semibold text-ink hover:bg-paper focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary lg:min-h-10 lg:text-sm';

/**
 * Choix d'un fichier (PDF, JPEG, PNG) ou prise de photo au téléphone, avec aperçu. Le type réel et
 * la taille sont vérifiés avant l'envoi ; les photos lourdes sont réduites.
 */
export function FilePicker({ label, value, onChange, camera = true, disabled }: FilePickerProps) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!value || !value.type.startsWith('image/')) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(value);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [value]);

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await prepareUpload(file));
    } catch (err) {
      onChange(null);
      setError(err instanceof Error ? err.message : 'Fichier refusé');
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled || busy} aria-busy={busy}>
      <legend className="mb-1.5 text-sm font-semibold text-ink lg:text-[13px]">{label}</legend>
      {value ? (
        <div className="flex items-center gap-3 rounded-[10px] border border-line bg-paper p-2.5">
          {preview ? (
            <img src={preview} alt="" className="size-14 shrink-0 rounded-md object-cover" />
          ) : (
            <span className="flex size-14 shrink-0 items-center justify-center rounded-md bg-white">
              <FileText className="size-6 text-primary" aria-hidden />
            </span>
          )}
          <span className="flex min-w-0 flex-1 flex-col">
            <strong className="truncate text-sm">{value.name}</strong>
            <span className="text-[13px] text-muted">{formatFileSize(value.size)}</span>
          </span>
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label={`Retirer ${value.name}`}
            className="flex size-11 shrink-0 items-center justify-center rounded-[10px] hover:bg-black/5"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {camera ? (
            <label className={cn(pickClass, 'lg:hidden')}>
              <Camera className="size-5" aria-hidden />
              Prendre une photo
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                onChange={pick}
                aria-describedby={`${id}-hint`}
              />
            </label>
          ) : null}
          <label className={pickClass}>
            <Upload className="size-5" aria-hidden />
            Choisir un fichier
            <input
              type="file"
              accept={FILE_ACCEPT}
              className="sr-only"
              onChange={pick}
              aria-describedby={`${id}-hint`}
            />
          </label>
        </div>
      )}
      <span id={`${id}-hint`} className="text-[13px] text-muted">
        {busy
          ? 'Préparation du fichier…'
          : `PDF, JPEG ou PNG, ${formatFileSize(MAX_FILE_BYTES)} au maximum`}
      </span>
      {error ? (
        <span className="text-[13px] font-medium text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </fieldset>
  );
}
