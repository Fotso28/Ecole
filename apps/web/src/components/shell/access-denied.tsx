import { ShieldX } from 'lucide-react';
import { ButtonLink } from '@/components/ui/button';
import type { RouteAccess } from '@/lib/nav';

/**
 * Page « Accès refusé » d'un lien direct vers une page non autorisée : aucune commande de la page
 * n'est affichée et aucune donnée n'est demandée.
 */
export function AccessDenied({
  access,
  home,
}: {
  access: Extract<RouteAccess, { allowed: false }>;
  home: string;
}) {
  const page = access.item.label;
  return (
    <section
      aria-labelledby="acces-refuse"
      className="mx-auto mt-6 flex w-full max-w-lg flex-col items-center gap-4 rounded-[14px] border border-line bg-white p-6 text-center"
    >
      <span className="flex size-14 items-center justify-center rounded-full bg-danger-soft text-danger">
        <ShieldX className="size-7" aria-hidden />
      </span>
      <h1 id="acces-refuse" className="font-display text-2xl font-bold">
        {access.reason === 'module' ? 'Module non activé' : 'Accès refusé'}
      </h1>
      <p className="text-sm text-muted">
        {access.reason === 'module'
          ? `La page « ${page} » fait partie d’un module qui n’est pas activé pour cet établissement.`
          : access.reason === 'platform'
            ? `La page « ${page} » est réservée à l’administration de la plateforme.`
            : `Vous n’avez pas le droit d’ouvrir la page « ${page} ». Si vous en avez besoin, demandez à la direction de vous accorder ce droit.`}
      </p>
      <ButtonLink href={home}>Retour à l’accueil</ButtonLink>
    </section>
  );
}
