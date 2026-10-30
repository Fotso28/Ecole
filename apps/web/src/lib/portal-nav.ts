import {
  BookOpen,
  CalendarDays,
  CalendarRange,
  FileText,
  Home,
  MessagesSquare,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

export interface PortalNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const PORTAL_MESSAGES = '/portail/messages';

/** Onglets du portail des parents : les quatre premiers restent dans la barre du bas. */
export const PORTAL_NAV: PortalNavItem[] = [
  { href: '/portail', label: 'Accueil', icon: Home },
  { href: '/portail/notes', label: 'Notes', icon: FileText },
  { href: '/portail/paiement', label: 'Payer', icon: Wallet },
  { href: PORTAL_MESSAGES, label: 'Messages', icon: MessagesSquare },
  { href: '/portail/absences', label: 'Absences', icon: CalendarDays },
  { href: '/portail/devoirs', label: 'Devoirs', icon: BookOpen },
  { href: '/portail/calendrier', label: 'Agenda', icon: CalendarRange },
];

/** Nombre d'onglets visibles avant « Plus » : cinq cibles tiennent sur un écran de 360 px. */
export const PORTAL_PRIMARY_COUNT = 4;

export function isPortalActive(href: string, pathname: string): boolean {
  return href === '/portail'
    ? pathname === '/portail'
    : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Répartit les onglets entre la barre du bas et le menu « Plus ». Le badge des messages non lus va
 * sur l'onglet Messages, ou sur « Plus » quand Messages s'y trouve.
 */
export function splitPortalNav(
  items: PortalNavItem[],
  pathname: string,
  unread: number,
  count = PORTAL_PRIMARY_COUNT,
) {
  const all = items.length <= count + 1 ? items : null;
  const primary = all ?? items.slice(0, count);
  const more = all ? [] : items.slice(count);
  return {
    primary,
    more,
    moreActive: more.some((i) => isPortalActive(i.href, pathname)),
    moreBadge: unread > 0 && more.some((i) => i.href === PORTAL_MESSAGES),
  };
}
