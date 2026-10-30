'use client';

import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** `side` : tiroir latéral (menu) ; par défaut, feuille en bas sur téléphone et fenêtre centrée sur grand écran. */
  variant?: 'dialog' | 'side';
}

/** Fenêtre modale native (<dialog>) : focus piégé et touche Échap gérés par le navigateur. */
export function Sheet({ open, onClose, title, children, footer, variant = 'dialog' }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-label={typeof title === 'string' ? title : undefined}
      className={cn(
        'm-0 max-h-[100dvh] max-w-none bg-white p-0 text-ink',
        variant === 'side'
          ? 'h-[100dvh] w-[86vw] max-w-[320px] bg-night text-night-ink'
          : 'mt-auto w-full rounded-t-[20px] sm:m-auto sm:w-[min(560px,calc(100vw-32px))] sm:rounded-[16px]',
      )}
    >
      <div
        className={cn(
          'flex max-h-[inherit] flex-col',
          variant === 'side' ? 'h-full' : 'max-h-[90dvh]',
        )}
      >
        <div
          className={cn(
            'flex items-center justify-between gap-3 px-4 py-3',
            variant === 'side' ? 'border-b border-night-line' : 'border-b border-line',
          )}
        >
          <h2 className="text-[17px] font-bold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="flex size-11 items-center justify-center rounded-[10px] hover:bg-black/5"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer ? <div className="border-t border-line p-4 pb-safe">{footer}</div> : null}
      </div>
    </dialog>
  );
}
