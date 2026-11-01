import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { forwardRef, type ButtonHTMLAttributes, type ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// Mobile d'abord : cibles de 48 px, ramenées à 40 px sur grand écran.
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] font-semibold transition-colors disabled:pointer-events-none disabled:opacity-100 disabled:bg-line disabled:text-muted disabled:border-transparent',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-white hover:bg-primary-hover',
        secondary: 'border border-line-strong bg-white text-ink hover:bg-paper',
        ghost: 'text-primary hover:bg-primary-soft',
        danger: 'border border-[#f0c7c2] bg-danger-soft text-danger hover:bg-[#f8dcd8]',
        saffron: 'bg-saffron text-ink hover:bg-[#f2c83a]',
      },
      size: {
        md: 'min-h-12 px-4 text-[15px] lg:min-h-10 lg:text-sm',
        sm: 'min-h-11 px-3 text-sm lg:min-h-9',
        lg: 'min-h-14 px-5 text-base',
        icon: 'size-12 lg:size-10',
      },
      block: { true: 'w-full' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

type Variants = VariantProps<typeof buttonVariants>;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, Variants {
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, block, loading, children, disabled, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size, block }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
});

export function ButtonLink({
  className,
  variant,
  size,
  block,
  ...props
}: ComponentProps<typeof Link> & Variants) {
  return <Link className={cn(buttonVariants({ variant, size, block }), className)} {...props} />;
}
