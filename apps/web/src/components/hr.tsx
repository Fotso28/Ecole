import { CONTRACT_TYPE_LABELS, formatFcfa } from '@ecole/shared';
import { Badge } from '@/components/ui/badge';
import type { ContractView } from '@/lib/hr';

export function contractSummary(c: ContractView | null): string {
  if (!c) return 'Aucun contrat en cours';
  const pay =
    c.type === 'HOURLY'
      ? `${formatFcfa(c.hourlyRate ?? 0)} de l’heure`
      : `${formatFcfa(c.baseSalary ?? 0)} par mois`;
  return `${CONTRACT_TYPE_LABELS[c.type]} · ${pay}`;
}

export function ContractBadge({ contract }: { contract: ContractView | null }) {
  if (!contract) return <Badge tone="neutral">Sans contrat</Badge>;
  if (contract.endingSoon)
    return (
      <Badge tone={contract.daysLeft !== null && contract.daysLeft < 0 ? 'danger' : 'warn'}>
        {contract.daysLeft !== null && contract.daysLeft < 0
          ? 'CDD échu'
          : `Fin dans ${contract.daysLeft} j`}
      </Badge>
    );
  return <Badge tone="success">{contract.type === 'HOURLY' ? 'Vacataire' : contract.type}</Badge>;
}
