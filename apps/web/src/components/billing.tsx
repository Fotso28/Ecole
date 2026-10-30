import { SUBSCRIPTION_STATE_LABELS, type SubscriptionInvoiceState } from '@ecole/shared';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, ErrorBlock } from '@/components/ui/card';
import { ApiError } from '@/lib/api';
import { STATE_BADGE } from '@/lib/billing';

export function StateBadge({ state }: { state: SubscriptionInvoiceState }) {
  return <Badge tone={STATE_BADGE[state].tone}>{SUBSCRIPTION_STATE_LABELS[state]}</Badge>;
}

/** Message dédié quand la double authentification du super-administrateur manque. */
export function PlatformError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (error instanceof ApiError && error.code === 'MFA_SETUP_REQUIRED')
    return (
      <Card role="alert">
        <CardHeader
          title="Double authentification requise"
          subtitle="La facturation de la plateforme exige la double authentification."
        />
        <Link href="/compte" className="font-semibold text-primary underline">
          Activer la double authentification
        </Link>
      </Card>
    );
  return <ErrorBlock error={error} onRetry={onRetry} />;
}
