'use client';

import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { api } from '@/lib/api';
import { initials } from '@/lib/format';
import type { Paged, StudentListItem } from '@/lib/types';

export interface PickedStudent {
  id: string;
  firstName: string;
  lastName: string;
  matricule: string;
  className: string | null;
}

/** Recherche d'un élève par nom ou matricule, résultats sélectionnables (zones de 44 px au moins). */
export function StudentPicker({
  value,
  onChange,
  label = 'Élève',
}: {
  value: PickedStudent | null;
  onChange: (student: PickedStudent | null) => void;
  label?: string;
}) {
  const id = useId();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const q = useQuery({
    queryKey: ['student-picker', term],
    queryFn: () =>
      api<Paged<StudentListItem>>(`/students?pageSize=8&search=${encodeURIComponent(term)}`),
    enabled: term.length >= 2,
  });

  if (value)
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-semibold lg:text-[13px]">{label}</span>
        <div className="flex items-center gap-3 rounded-[12px] border-2 border-primary bg-primary-soft p-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white text-sm font-bold text-primary">
            {initials(`${value.lastName} ${value.firstName}`)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <strong className="truncate">
              {value.lastName} {value.firstName}
            </strong>
            <span className="text-[13px] text-muted tabular">
              {value.className ?? 'Non inscrit'} · {value.matricule}
            </span>
          </span>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="min-h-11 rounded-[10px] px-3 text-sm font-semibold text-primary hover:bg-white"
          >
            Changer
          </button>
        </div>
      </div>
    );

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold lg:text-[13px]">
        {label}
      </label>
      <div className="flex h-12 items-center gap-2 rounded-[10px] border border-line-strong bg-white px-3 lg:h-10">
        <Search className="size-4 text-muted" aria-hidden />
        <input
          id={id}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Nom ou matricule (2 lettres minimum)"
          className="h-full min-w-0 flex-1 bg-transparent text-base outline-none lg:text-sm"
          autoComplete="off"
        />
      </div>
      {term.length >= 2 ? (
        <ul
          aria-label="Résultats de la recherche"
          aria-live="polite"
          className="flex flex-col gap-1"
        >
          {q.isPending ? (
            <li className="px-1 py-2 text-sm text-muted">Recherche…</li>
          ) : q.data?.items.length === 0 ? (
            <li className="px-1 py-2 text-sm text-muted">Aucun élève trouvé.</li>
          ) : (
            q.data?.items.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => {
                    // Recherche vidée : « Changer » ou une nouvelle saisie repart de zéro.
                    setSearch('');
                    setTerm('');
                    onChange({
                      id: s.id,
                      firstName: s.firstName,
                      lastName: s.lastName,
                      matricule: s.matricule,
                      className: s.class?.name ?? null,
                    });
                  }}
                  className="flex min-h-12 w-full items-center gap-3 rounded-[10px] border border-line px-3 text-left hover:bg-paper"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-semibold">
                      {s.lastName} {s.firstName}
                    </span>
                    <span className="text-[13px] text-muted tabular">
                      {s.class?.name ?? 'Non inscrit'} · {s.matricule}
                    </span>
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
