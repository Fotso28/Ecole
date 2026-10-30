import { cn } from '@/lib/utils';

/** Onglets en pastilles (zones de 44 px sur téléphone), repliés sur plusieurs lignes au besoin. */
export function PillTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: readonly (readonly [T, string])[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-2">
      {tabs.map(([v, text]) => (
        <button
          key={v}
          role="tab"
          type="button"
          aria-selected={value === v}
          onClick={() => onChange(v)}
          className={cn(
            'min-h-11 rounded-full border px-4 text-sm font-semibold lg:min-h-9',
            value === v ? 'border-primary bg-primary text-white' : 'border-line-strong bg-white',
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
