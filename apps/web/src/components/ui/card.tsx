import Link from 'next/link';
import type { HTMLAttributes, ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn('rounded-[14px] border border-line bg-white p-4 lg:p-5', className)}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  action,
  subtitle,
}: {
  title: ReactNode;
  action?: ReactNode;
  subtitle?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-bold lg:text-[17px]">{title}</h2>
        {subtitle ? <p className="text-[13px] text-muted">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-[26px] leading-tight font-bold tracking-tight lg:text-3xl">
          {title}
        </h1>
        {subtitle ? <p className="text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'danger' | 'default';
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[14px] border border-line bg-white p-4">
      <span className="text-[13px] font-semibold text-muted">{label}</span>
      <strong
        className={cn(
          'font-display text-[26px] leading-none tabular lg:text-3xl',
          tone === 'danger' && 'text-danger',
        )}
      >
        {value}
      </strong>
      {hint ? <span className="text-[13px] text-muted">{hint}</span> : null}
    </div>
  );
}

export function EmptyState({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-[14px] border border-dashed border-line-strong bg-white px-6 py-10 text-center">
      <strong className="text-[15px]">{title}</strong>
      {children ? <div className="text-sm text-muted">{children}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn('animate-pulse rounded-[10px] bg-neutral-soft', className)} aria-hidden />
  );
}

export function LoadingBlock({ label = 'Chargement…' }: { label?: string }) {
  return (
    <div className="flex flex-col gap-3" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-20" />
      <Skeleton className="h-20" />
      <Skeleton className="h-20" />
    </div>
  );
}

export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Une erreur est survenue.';
  // École sans année scolaire en cours : orienter vers le guide de démarrage, pas une erreur.
  if (error instanceof ApiError && error.code === 'NO_CURRENT_YEAR')
    return (
      <div role="status" className="flex flex-col gap-3 rounded-[14px] bg-info-soft p-4 text-sm">
        <strong>Aucune année scolaire en cours</strong>
        <span>Créez l’année scolaire pour commencer à utiliser cette page.</span>
        <Link
          href="/tableau-de-bord"
          className="inline-flex min-h-11 items-center self-start font-semibold text-primary underline"
        >
          Ouvrir le guide de démarrage
        </Link>
      </div>
    );
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-[14px] bg-danger-soft p-4 text-sm">
      <strong className="text-danger">Impossible d’afficher cette page</strong>
      <span>{message}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="self-start font-semibold text-primary underline"
        >
          Réessayer
        </button>
      ) : null}
    </div>
  );
}
