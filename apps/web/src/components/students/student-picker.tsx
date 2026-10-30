'use client';

import { useQuery } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { InputField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface PickedStudent {
  id: string;
  firstName: string;
  lastName: string;
  className: string | null;
}

interface StudentPage {
  items: {
    id: string;
    firstName: string;
    lastName: string;
    matricule: string;
    class: { name: string } | null;
  }[];
}

/** Recherche d'élèves par nom ou matricule (périmètre de l'utilisateur), sélection simple ou multiple. */
export function StudentPicker({
  value,
  onChange,
  multiple = false,
  label = 'Élève',
}: {
  value: PickedStudent[];
  onChange: (next: PickedStudent[]) => void;
  multiple?: boolean;
  label?: string;
}) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const results = useQuery({
    queryKey: ['student-picker', debounced],
    queryFn: () => api<StudentPage>(`/students?pageSize=8&search=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2,
  });
  const selected = new Set(value.map((s) => s.id));
  const toggle = (s: PickedStudent) => {
    if (selected.has(s.id)) onChange(value.filter((v) => v.id !== s.id));
    else onChange(multiple ? [...value, s] : [s]);
  };

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Élèves choisis">
          {value.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => toggle(s)}
                aria-label={`Retirer ${s.firstName} ${s.lastName}`}
                className="flex min-h-11 items-center gap-1.5 rounded-full bg-primary-soft px-3 text-sm font-semibold text-primary"
              >
                {s.firstName} {s.lastName}
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <InputField
        label={label}
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Nom, prénom ou matricule"
        hint="Saisissez au moins deux lettres."
        autoComplete="off"
      />
      {debounced.length >= 2 ? (
        results.data?.items.length === 0 ? (
          <p className="text-sm text-muted" role="status">
            Aucun élève trouvé.
          </p>
        ) : (
          <ul className="flex flex-col gap-1" aria-label="Résultats de la recherche">
            {results.data?.items.map((s) => {
              const picked: PickedStudent = {
                id: s.id,
                firstName: s.firstName,
                lastName: s.lastName,
                className: s.class?.name ?? null,
              };
              const on = selected.has(s.id);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      toggle(picked);
                      if (!multiple) setSearch('');
                    }}
                    className={cn(
                      'flex min-h-12 w-full items-center justify-between gap-2 rounded-[10px] border px-3 text-left text-sm',
                      on ? 'border-primary bg-primary-soft' : 'border-line bg-white hover:bg-paper',
                    )}
                  >
                    <span className="flex min-w-0 flex-col">
                      <strong className="truncate">
                        {s.lastName} {s.firstName}
                      </strong>
                      <span className="truncate text-xs text-muted">
                        {s.matricule}
                        {s.class ? ` · ${s.class.name}` : ''}
                      </span>
                    </span>
                    {on ? <Check className="size-4 shrink-0 text-primary" aria-hidden /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </div>
  );
}
