'use client';

import { ROLE_LABELS } from '@ecole/shared';
import { useMutation } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, PageHeader } from '@/components/ui/card';
import { InputField } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function AccountPage() {
  const { me, reload } = useAuth();
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const start = useMutation({
    mutationFn: () =>
      api<{ secret: string; otpauthUrl: string }>('/auth/mfa/setup', { method: 'POST' }),
    onSuccess: setSetup,
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const enable = useMutation({
    mutationFn: () => api('/auth/mfa/enable', { method: 'POST', body: { code } }),
    onSuccess: async () => {
      setSetup(null);
      toast('Double authentification activée');
      await reload();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  if (!me) return null;
  return (
    <>
      <PageHeader title="Mon compte" />
      <Card>
        <CardHeader
          title={`${me.user.firstName} ${me.user.lastName}`}
          subtitle={me.user.email ?? undefined}
        />
        <p className="text-sm text-muted">{me.roles.map((r) => ROLE_LABELS[r]).join(' · ')}</p>
      </Card>
      <Card className="flex flex-col gap-4">
        <CardHeader
          title="Double authentification"
          subtitle="Un code à 6 chiffres de votre téléphone est demandé à chaque connexion."
        />
        {me.user.mfaEnabled ? (
          <p className="flex items-center gap-2 text-sm font-semibold text-primary">
            <ShieldCheck className="size-5" aria-hidden />
            Activée
          </p>
        ) : setup ? (
          <div className="flex flex-col gap-4">
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
              <li>
                Installez une application d’authentification (Google Authenticator, Microsoft
                Authenticator…).
              </li>
              <li>
                Sur ce téléphone,{' '}
                <a href={setup.otpauthUrl} className="font-semibold text-primary underline">
                  ouvrez le lien de configuration
                </a>
                , ou saisissez la clé :{' '}
                <code className="rounded bg-paper px-1.5 py-0.5 font-mono text-[13px] break-all">
                  {setup.secret}
                </code>
              </li>
              <li>Recopiez le code affiché.</li>
            </ol>
            <InputField
              label="Code à 6 chiffres"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="text-center text-xl tracking-[0.3em]"
            />
            <Button
              onClick={() => enable.mutate()}
              loading={enable.isPending}
              disabled={code.length !== 6}
            >
              Activer
            </Button>
          </div>
        ) : (
          <Button onClick={() => start.mutate()} loading={start.isPending} className="self-start">
            Configurer
          </Button>
        )}
      </Card>
    </>
  );
}
