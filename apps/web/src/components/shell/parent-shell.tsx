'use client';

import { useQuery } from '@tanstack/react-query';
import {
  BookOpen,
  CalendarDays,
  CalendarRange,
  FileText,
  Home,
  LogOut,
  MessagesSquare,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useParentUnread } from '@/lib/communication';
import { cn } from '@/lib/utils';

export interface Child {
  id: string;
  firstName: string;
  lastName: string;
  matricule: string;
  school: { id: string; name: string; city: string };
  className: string | null;
  balance: number;
  overdue: number;
  nextDue: { lineId: string; label: string; dueDate: string; amount: number } | null;
}

interface ChildrenValue {
  children: Child[];
  selected: Child | null;
  select: (id: string) => void;
}

const ChildrenContext = createContext<ChildrenValue>({
  children: [],
  selected: null,
  select: () => undefined,
});
export const useChildren = () => useContext(ChildrenContext);

const NAV = [
  { href: '/portail', label: 'Accueil', icon: Home },
  { href: '/portail/notes', label: 'Notes', icon: FileText },
  { href: '/portail/absences', label: 'Absences', icon: CalendarDays },
  { href: '/portail/devoirs', label: 'Devoirs', icon: BookOpen },
  { href: '/portail/paiement', label: 'Payer', icon: Wallet },
  { href: '/portail/messages', label: 'Messages', icon: MessagesSquare },
  { href: '/portail/calendrier', label: 'Agenda', icon: CalendarRange },
];

export function ParentShell({ children }: { children: ReactNode }) {
  const { status, me, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const unread = useParentUnread().data?.count ?? 0;

  useEffect(() => {
    if (status === 'anonymous') router.replace('/parent/connexion');
    if (status === 'authenticated' && me?.kind === 'staff') router.replace('/');
  }, [status, me, router]);

  const list = useQuery({
    queryKey: ['portal-children'],
    queryFn: () => api<Child[]>('/portal/children'),
    enabled: status === 'authenticated' && me?.kind === 'parent',
  });

  useEffect(() => {
    if (!list.data?.length || selectedId) return;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('ecole.child');
    } catch {
      // Stockage indisponible.
    }
    setSelectedId(list.data.some((c) => c.id === saved) ? saved : (list.data[0]?.id ?? null));
  }, [list.data, selectedId]);

  if (status !== 'authenticated' || me?.kind !== 'parent') {
    return (
      <div className="flex min-h-dvh items-center justify-center" role="status">
        <span className="font-display text-2xl font-bold text-primary">Ecole</span>
      </div>
    );
  }

  const value: ChildrenValue = {
    children: list.data ?? [],
    selected: list.data?.find((c) => c.id === selectedId) ?? null,
    select: (id) => {
      setSelectedId(id);
      try {
        localStorage.setItem('ecole.child', id);
      } catch {
        // Préférence non mémorisée.
      }
    },
  };

  return (
    <ChildrenContext.Provider value={value}>
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-paper sm:border-x sm:border-line">
        <header className="flex items-center justify-between gap-3 px-4 pt-5 pb-2">
          <div className="flex flex-col">
            <h1 className="font-display text-2xl font-bold">Bonjour {me.user.firstName}</h1>
            <span className="text-sm text-muted">Espace parents</span>
          </div>
          <button
            type="button"
            aria-label="Se déconnecter"
            onClick={async () => {
              await logout();
              router.replace('/parent/connexion');
            }}
            className="flex size-12 items-center justify-center rounded-[14px] border border-line-strong bg-white"
          >
            <LogOut className="size-5" aria-hidden />
          </button>
        </header>
        <main className="flex flex-1 flex-col gap-4 px-4 pt-2 pb-28">{children}</main>
        <nav
          aria-label="Navigation"
          className="fixed inset-x-0 bottom-0 z-30 mx-auto grid w-full max-w-md grid-cols-7 border-t border-line bg-white px-1 pt-1 pb-safe"
        >
          {NAV.map((item) => {
            const active =
              item.href === '/portail' ? pathname === '/portail' : pathname.startsWith(item.href);
            const badge = item.href === '/portail/messages' && unread > 0;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px]',
                  active ? 'font-bold text-primary' : 'font-semibold text-muted',
                )}
              >
                <span className="relative">
                  <item.icon className="size-[22px]" aria-hidden />
                  {badge ? (
                    <span
                      aria-hidden
                      className="absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white"
                    >
                      {unread}
                    </span>
                  ) : null}
                </span>
                {item.label}
                {badge ? (
                  <span className="sr-only">{`(${unread} ${unread > 1 ? 'non lus' : 'non lu'})`}</span>
                ) : null}
              </Link>
            );
          })}
        </nav>
      </div>
    </ChildrenContext.Provider>
  );
}

/** Sélecteur d'enfant (frères et sœurs, éventuellement dans plusieurs écoles). */
export function ChildSwitcher() {
  const { children, selected, select } = useChildren();
  if (children.length <= 1) return null;
  return (
    <div role="group" aria-label="Choisir un enfant" className="grid grid-cols-2 gap-2">
      {children.map((c) => {
        const on = c.id === selected?.id;
        return (
          <button
            key={c.id}
            type="button"
            aria-pressed={on}
            onClick={() => select(c.id)}
            className={cn(
              'flex min-h-15 items-center gap-2.5 rounded-[14px] bg-white p-2.5 text-left',
              on ? 'border-2 border-primary' : 'border border-line',
            )}
          >
            <span
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                on ? 'bg-primary text-white' : 'bg-primary-soft text-primary',
              )}
            >
              {c.firstName[0]}
              {c.lastName[0]}
            </span>
            <span className="flex min-w-0 flex-col">
              <strong className="truncate text-sm">{c.firstName}</strong>
              <span className="truncate text-xs text-muted">
                {c.className ?? '—'} · {c.school.name}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
