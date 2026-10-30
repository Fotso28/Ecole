import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold',
  {
    variants: {
      tone: {
        success: 'bg-primary-soft text-primary',
        warn: 'bg-warn-soft text-warn',
        danger: 'bg-danger-soft text-danger',
        info: 'bg-info-soft text-info',
        neutral: 'bg-neutral-soft text-muted',
        night: 'bg-night text-white',
        saffron: 'bg-saffron text-ink',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export function Badge({
  tone,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export const ENROLLMENT_BADGE = {
  ENROLLED: { tone: 'success', label: 'Inscrit' },
  REPEATING: { tone: 'warn', label: 'Redoublant' },
  TRANSFERRED: { tone: 'info', label: 'Transféré' },
  LEFT: { tone: 'neutral', label: 'Sorti' },
} as const;

export const LINE_BADGE = {
  PAID: { tone: 'success', label: 'Payé' },
  PARTIAL: { tone: 'warn', label: 'Partiel' },
  UNPAID: { tone: 'neutral', label: 'À venir' },
} as const;
