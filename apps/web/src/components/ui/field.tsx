import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/utils';

// 16 px sur téléphone : évite le zoom automatique d'iOS au focus.
export const controlClass =
  'w-full rounded-[10px] border border-line-strong bg-white px-3 text-base text-ink placeholder:text-[#6b7190] lg:text-sm aria-[invalid=true]:border-2 aria-[invalid=true]:border-danger disabled:bg-paper disabled:text-muted';

interface FieldShellProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  className?: string;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

export function FieldShell({ label, hint, error, optional, className, children }: FieldShellProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-semibold text-ink lg:text-[13px]">
        {label}
        {optional ? <span className="font-medium text-muted"> (facultatif)</span> : null}
      </label>
      {children({ id, describedBy, invalid: !!error })}
      {hint && !error ? (
        <span id={hintId} className="text-[13px] text-muted [overflow-wrap:anywhere]">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span
          id={errorId}
          className="text-[13px] font-medium text-danger [overflow-wrap:anywhere]"
          role="alert"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}

type InputFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  containerClassName?: string;
};

export const InputField = forwardRef<HTMLInputElement, InputFieldProps>(function InputField(
  { label, hint, error, optional, containerClassName, className, ...props },
  ref,
) {
  return (
    <FieldShell
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      className={containerClassName}
    >
      {({ id, describedBy, invalid }) => (
        <input
          ref={ref}
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={cn(controlClass, 'h-12 lg:h-10', className)}
          {...props}
        />
      )}
    </FieldShell>
  );
});

type SelectFieldProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  containerClassName?: string;
};

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, hint, error, optional, containerClassName, className, children, ...props },
  ref,
) {
  return (
    <FieldShell
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      className={containerClassName}
    >
      {({ id, describedBy, invalid }) => (
        <select
          ref={ref}
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={cn(controlClass, 'h-12 lg:h-10', className)}
          {...props}
        >
          {children}
        </select>
      )}
    </FieldShell>
  );
});

type TextareaFieldProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  containerClassName?: string;
};

export const TextareaField = forwardRef<HTMLTextAreaElement, TextareaFieldProps>(
  function TextareaField(
    { label, hint, error, optional, containerClassName, className, ...props },
    ref,
  ) {
    return (
      <FieldShell
        label={label}
        hint={hint}
        error={error}
        optional={optional}
        className={containerClassName}
      >
        {({ id, describedBy, invalid }) => (
          <textarea
            ref={ref}
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            className={cn(controlClass, 'min-h-24 py-2', className)}
            {...props}
          />
        )}
      </FieldShell>
    );
  },
);

export function Checkbox({
  label,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label
      className={cn(
        'flex min-h-11 items-start gap-3 text-[15px] leading-snug lg:text-sm',
        className,
      )}
    >
      <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-primary" {...props} />
      <span>{label}</span>
    </label>
  );
}
