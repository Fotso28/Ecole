'use client';

import { LogOut, Menu, Search, ShieldAlert, UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ROLE_LABELS } from '@ecole/shared';
import { OfflineBanner } from '@/components/offline-banner';
import { Sheet } from '@/components/ui/sheet';
import { homeFor, useAuth } from '@/lib/auth';
import { useStaffUnread } from '@/lib/communication';
import { activeHref, primaryNav, visibleNav } from '@/lib/nav';
import { cn } from '@/lib/utils';

function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center" role="status" aria-live="polite">
      <span className="font-display text-2xl font-bold text-primary">Ecole</span>
      <span className="sr-only">Chargement de votre espace…</span>
    </div>
  );
}

const ADMIN_ROLES = ['DIRECTOR', 'CENSOR', 'SECRETARY', 'ACCOUNTANT'];

export function StaffShell({ children }: { children: ReactNode }) {
  const { status, me, logout, switchSchool, teacherOnly } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (status === 'anonymous') router.replace(`/connexion?suite=${encodeURIComponent(pathname)}`);
    if (status === 'authenticated' && me?.kind === 'parent') router.replace('/portail');
  }, [status, me, router, pathname]);

  useEffect(() => setMenuOpen(false), [pathname]);

  const unread = useStaffUnread().data?.count ?? 0;
  const groups = useMemo(() => visibleNav(me), [me]);
  const primary = useMemo(() => primaryNav(me), [me]);
  const allItems = groups.flatMap((g) => g.items);
  const menuBadge = unread > 0 && !primary.some((i) => i.href === '/messages');
  const active = activeHref(pathname, allItems);

  if (status !== 'authenticated' || !me || me.kind !== 'staff') return <Splash />;

  const mfaMissing =
    !!me.activeSchool?.mfaRequired &&
    !me.user.mfaEnabled &&
    me.roles.some((r) => ADMIN_ROLES.includes(r));
  const name = `${me.user.firstName} ${me.user.lastName}`;
  const roleLabel = me.roles.map((r) => ROLE_LABELS[r]).join(' · ');

  const onSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get('q');
    router.push(`/eleves?q=${encodeURIComponent(String(q ?? ''))}`);
  };

  const navList = (dense = false) => (
    <nav aria-label="Navigation principale" className="flex flex-col gap-4">
      {groups.map((g) => (
        <div key={g.label || 'principal'} className="flex flex-col gap-0.5">
          {g.label ? (
            <span className="px-2.5 pb-1 text-[11px] font-semibold tracking-[0.08em] text-night-text uppercase">
              {g.label}
            </span>
          ) : null}
          {g.items.map((item) => {
            const isActive = item.href === active;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-[9px] px-2.5 text-[15px] lg:text-sm',
                  dense ? 'min-h-11 lg:min-h-9' : 'min-h-12',
                  isActive
                    ? 'bg-night-3 font-semibold text-white'
                    : 'font-medium text-[#d3dfd8] hover:bg-night-2',
                )}
              >
                <item.icon
                  className={cn(
                    'size-[18px] shrink-0',
                    isActive ? 'text-saffron' : 'text-night-text',
                  )}
                  aria-hidden
                />
                {item.label}
                {item.href === '/messages' && unread > 0 ? (
                  <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-saffron px-1.5 text-xs font-bold text-ink">
                    {unread}
                    <span className="sr-only"> {unread > 1 ? 'non lus' : 'non lu'}</span>
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );

  const schoolBlock = (
    <div className="flex items-center gap-2.5 rounded-[12px] border border-night-line bg-night-2 p-2.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-saffron font-display text-sm font-bold text-ink">
        {(me.activeSchool?.name ?? 'É')
          .split(' ')
          .map((w) => w[0])
          .slice(0, 2)
          .join('')}
      </span>
      <span className="flex min-w-0 flex-col">
        <strong className="truncate text-sm text-white">{me.activeSchool?.name}</strong>
        <span className="truncate text-xs text-night-text">{me.activeSchool?.city}</span>
      </span>
    </div>
  );

  const account = (
    <div className="flex flex-col gap-3 border-t border-night-line pt-3">
      <div className="flex items-center gap-2.5 px-1">
        <span className="flex size-8 items-center justify-center rounded-full bg-primary-soft text-xs font-bold text-primary">
          {me.user.firstName[0]}
          {me.user.lastName[0]}
        </span>
        <span className="flex min-w-0 flex-col">
          <strong className="truncate text-[13px] text-white">{name}</strong>
          <span className="truncate text-xs text-night-text">{roleLabel}</span>
        </span>
      </div>
      {me.schools.length > 1 ? (
        <label className="flex flex-col gap-1 px-1 text-xs text-night-text">
          Établissement
          <select
            className="h-11 rounded-[9px] border border-night-line bg-night-2 px-2 text-sm text-white"
            value={me.activeSchool?.id}
            onChange={async (e) => {
              await switchSchool(e.target.value);
              router.push('/');
            }}
          >
            {me.schools.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="flex gap-2">
        <Link
          href="/compte"
          className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-[9px] border border-night-line text-sm font-semibold text-white hover:bg-night-2"
        >
          <UserRound className="size-4" aria-hidden />
          Mon compte
        </Link>
        <button
          type="button"
          onClick={async () => {
            await logout();
            router.replace('/connexion');
          }}
          className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-[9px] border border-night-line text-sm font-semibold text-white hover:bg-night-2"
        >
          <LogOut className="size-4" aria-hidden />
          Quitter
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh lg:flex">
      <a
        href="#contenu"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-white focus:p-2"
      >
        Aller au contenu
      </a>
      <aside className="hidden bg-night lg:flex lg:w-64 lg:shrink-0 lg:flex-col lg:gap-5 lg:px-3 lg:py-4">
        {schoolBlock}
        <div className="flex-1 overflow-y-auto">{navList(true)}</div>
        {account}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-white px-4 py-2.5 lg:px-8">
          <Link
            href={homeFor(me, teacherOnly)}
            className="flex min-w-0 items-center gap-2 lg:hidden"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-primary font-display font-bold text-white">
              É
            </span>
            <span className="truncate text-[15px] font-bold">{me.activeSchool?.name}</span>
          </Link>
          <form onSubmit={onSearch} role="search" className="hidden max-w-lg flex-1 lg:flex">
            <label className="flex h-10 w-full items-center gap-2 rounded-[10px] border border-line-strong bg-paper px-3">
              <Search className="size-4 text-muted" aria-hidden />
              <span className="sr-only">Rechercher un élève</span>
              <input
                name="q"
                type="search"
                placeholder="Rechercher un élève, un matricule, le téléphone d’un parent…"
                className="h-full flex-1 bg-transparent text-sm outline-none"
              />
            </label>
          </form>
          {me.activeSchool?.currentYear ? (
            <span className="ml-auto shrink-0 rounded-[10px] border border-line-strong px-2.5 py-1.5 text-[13px] font-semibold lg:px-3 lg:py-2 lg:text-sm">
              {me.activeSchool.currentYear.name}
            </span>
          ) : null}
        </header>

        <OfflineBanner className="lg:px-8" />

        {mfaMissing ? (
          <div
            className="flex flex-wrap items-center gap-3 bg-warn-soft px-4 py-3 text-sm lg:px-8"
            role="alert"
          >
            <ShieldAlert className="size-5 text-warn" aria-hidden />
            <span className="flex-1">
              La double authentification est obligatoire pour votre rôle dans cet établissement.
            </span>
            <Link href="/compte" className="font-semibold text-primary underline">
              L’activer maintenant
            </Link>
          </div>
        ) : null}

        <main id="contenu" className="flex-1 px-4 pt-4 pb-28 lg:px-8 lg:pt-6 lg:pb-12">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">{children}</div>
        </main>
      </div>

      <nav
        aria-label="Navigation rapide"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-white px-1 pt-1 pb-safe lg:hidden"
      >
        {primary.map((item) => {
          const isActive = item.href === active;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-[10px] text-[11px]',
                isActive ? 'font-bold text-primary' : 'font-semibold text-muted',
              )}
            >
              <item.icon className="size-[22px]" aria-hidden />
              {item.short ?? item.label}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          className="flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-[10px] text-[11px] font-semibold text-muted"
          aria-haspopup="dialog"
        >
          <span className="relative">
            <Menu className="size-[22px]" aria-hidden />
            {menuBadge ? (
              <span
                aria-hidden
                className="absolute -top-1 -right-1.5 size-2.5 rounded-full bg-danger"
              />
            ) : null}
          </span>
          Menu
          {menuBadge ? <span className="sr-only">(messages non lus)</span> : null}
        </button>
      </nav>

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title="Menu" variant="side">
        <div className="flex flex-col gap-5">
          {schoolBlock}
          {navList()}
          {account}
        </div>
      </Sheet>
    </div>
  );
}
