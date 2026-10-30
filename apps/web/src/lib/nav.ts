import type { Module, Permission, StaffRole } from '@ecole/shared';
import {
  BookOpen,
  CalendarDays,
  ClipboardCheck,
  FileText,
  CalendarRange,
  LayoutGrid,
  Megaphone,
  MessagesSquare,
  PenLine,
  Receipt,
  Settings,
  ShieldCheck,
  Sun,
  TriangleAlert,
  UserPlus,
  Users,
  UsersRound,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { Me } from './types';

export interface NavItem {
  href: string;
  label: string;
  /** Libellé court pour le menu inférieur du téléphone. */
  short?: string;
  icon: LucideIcon;
  permission?: Permission;
  module?: Module;
  teacherOnly?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    label: '',
    items: [
      {
        href: '/tableau-de-bord',
        label: 'Tableau de bord',
        short: 'Accueil',
        icon: LayoutGrid,
        permission: 'dashboard.read',
      },
    ],
  },
  {
    label: 'Vie scolaire',
    items: [
      {
        href: '/eleves',
        label: 'Élèves',
        icon: Users,
        permission: 'students.read',
        module: 'students',
      },
      {
        href: '/eleves/nouveau',
        label: 'Nouvelle inscription',
        short: 'Inscrire',
        icon: UserPlus,
        permission: 'students.write',
        module: 'students',
      },
      {
        href: '/presences',
        label: 'Appel',
        icon: ClipboardCheck,
        permission: 'attendance.write',
        module: 'attendance',
      },
      {
        href: '/presences/justificatifs',
        label: 'Justificatifs',
        icon: ShieldCheck,
        permission: 'attendance.justify',
        module: 'attendance',
      },
      {
        href: '/messages',
        label: 'Messages',
        icon: MessagesSquare,
        permission: 'messaging.use',
        module: 'communication',
      },
    ],
  },
  {
    label: 'Pédagogie',
    items: [
      { href: '/enseignant', label: 'Ma journée', short: 'Journée', icon: Sun, teacherOnly: true },
      {
        href: '/notes',
        label: 'Notes',
        icon: PenLine,
        permission: 'grades.write',
        module: 'grades',
      },
      {
        href: '/bulletins',
        label: 'Bulletins',
        icon: FileText,
        permission: 'reportcards.read',
        module: 'grades',
      },
      {
        href: '/emploi-du-temps',
        label: 'Emploi du temps',
        short: 'Emploi',
        icon: CalendarDays,
        permission: 'academic.read',
        module: 'timetable',
      },
    ],
  },
  {
    label: 'Finances',
    items: [
      {
        href: '/caisse',
        label: 'Caisse',
        icon: Wallet,
        permission: 'finance.payments.create',
        module: 'finance',
      },
      {
        href: '/impayes',
        label: 'Impayés',
        icon: TriangleAlert,
        permission: 'finance.read',
        module: 'finance',
      },
      {
        href: '/caisse/journal',
        label: 'Journal des paiements',
        short: 'Journal',
        icon: Receipt,
        permission: 'finance.read',
        module: 'finance',
      },
    ],
  },
  {
    label: 'École',
    items: [
      {
        href: '/annonces',
        label: 'Annonces',
        icon: Megaphone,
        permission: 'communication.write',
        module: 'communication',
      },
      {
        href: '/calendrier',
        label: 'Calendrier',
        icon: CalendarRange,
        permission: 'academic.read',
        module: 'communication',
      },
      { href: '/personnel', label: 'Personnel', icon: UsersRound, permission: 'staff.read' },
      {
        href: '/structure',
        label: 'Structure académique',
        short: 'Structure',
        icon: BookOpen,
        permission: 'academic.write',
      },
      { href: '/parametres', label: 'Paramètres', icon: Settings, permission: 'settings.write' },
    ],
  },
];

/** Destinations du menu inférieur (téléphone), par rôle principal. */
const PRIMARY: Record<StaffRole, string[]> = {
  DIRECTOR: ['/tableau-de-bord', '/eleves', '/caisse', '/bulletins'],
  CENSOR: ['/tableau-de-bord', '/notes', '/bulletins', '/eleves'],
  SUPERVISOR: ['/tableau-de-bord', '/presences', '/presences/justificatifs', '/eleves'],
  SECRETARY: ['/tableau-de-bord', '/eleves', '/eleves/nouveau', '/annonces'],
  ACCOUNTANT: ['/tableau-de-bord', '/caisse', '/impayes', '/caisse/journal'],
  TEACHER: ['/enseignant', '/presences', '/notes', '/eleves'],
  NURSE: ['/eleves'],
};
const ROLE_ORDER: StaffRole[] = [
  'DIRECTOR',
  'CENSOR',
  'ACCOUNTANT',
  'SECRETARY',
  'SUPERVISOR',
  'TEACHER',
  'NURSE',
];

export function visibleNav(me: Me | null): NavGroup[] {
  if (!me) return [];
  const perms = new Set(me.permissions);
  const modules = new Set(me.activeSchool?.modules ?? []);
  return NAV.map((g) => ({
    ...g,
    items: g.items.filter(
      (i) =>
        (!i.permission || perms.has(i.permission)) &&
        (!i.module || modules.has(i.module)) &&
        (!i.teacherOnly || me.roles.includes('TEACHER')),
    ),
  })).filter((g) => g.items.length > 0);
}

export function primaryNav(me: Me | null): NavItem[] {
  const items = visibleNav(me).flatMap((g) => g.items);
  const role = ROLE_ORDER.find((r) => me?.roles.includes(r));
  const wanted = role ? PRIMARY[role] : [];
  return wanted
    .map((href) => items.find((i) => i.href === href))
    .filter((i): i is NavItem => !!i)
    .slice(0, 4);
}

/** Élément actif : le plus long préfixe correspondant à l'URL courante. */
export function activeHref(pathname: string, items: NavItem[]): string | undefined {
  return items
    .filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

/**
 * Chemin interne sûr pour la redirection après connexion, sinon null. Le chemin est résolu comme
 * le ferait le navigateur : « /\site.com » ou une tabulation après « / » mènent hors du site.
 */
export function safeNextPath(next: string | null): string | null {
  if (!next?.startsWith('/')) return null;
  const base = 'https://ecole.invalid';
  try {
    const url = new URL(next, base);
    return url.origin === base ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch {
    return null;
  }
}
