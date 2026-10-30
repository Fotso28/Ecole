'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema } from '@ecole/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { InputField } from '@/components/ui/field';
import { ApiError } from '@/lib/api';
import { homeFor, useAuth } from '@/lib/auth';

type LoginForm = z.input<typeof loginSchema>;

function LoginContent() {
  const { status, me, teacherOnly, loginStaff, verifyMfa } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(
    params.get('expiree') ? 'Votre session a expiré. Reconnectez-vous.' : null,
  );
  const [busy, setBusy] = useState(false);
  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  useEffect(() => {
    if (status === 'authenticated' && me) {
      const next = params.get('suite');
      router.replace(
        next && next.startsWith('/') && !next.startsWith('//') && me.kind === 'staff'
          ? next
          : homeFor(me, teacherOnly),
      );
    }
  }, [status, me, teacherOnly, router, params]);

  const submit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const res = await loginStaff(values.email, values.password);
      if (res.mfaToken) setMfaToken(res.mfaToken);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Connexion impossible.');
    }
  });

  const submitMfa = async () => {
    if (!mfaToken) return;
    setBusy(true);
    setError(null);
    try {
      await verifyMfa(mfaToken, code);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Code incorrect.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh flex-col bg-paper lg:flex-row">
      <section className="flex flex-col justify-between gap-6 bg-night px-6 pt-10 pb-8 text-white lg:w-[44%] lg:p-12">
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-[12px] bg-primary font-display text-xl font-bold">
            É
          </span>
          <span className="font-display text-xl font-bold">Ecole</span>
        </div>
        <div className="flex flex-col gap-3">
          <h1 className="font-display text-[30px] leading-tight font-bold lg:text-[44px]">
            L’école, tenue au propre, même sur une connexion lente.
          </h1>
          <p className="text-[15px] text-night-text lg:text-base">
            Élèves, appel, notes, bulletins, scolarité et parents, dans un seul outil.
          </p>
        </div>
      </section>
      <section className="flex flex-1 items-start justify-center px-5 py-8 lg:items-center">
        <div className="flex w-full max-w-sm flex-col gap-6">
          {!mfaToken ? (
            <form onSubmit={submit} noValidate className="flex flex-col gap-4">
              <h2 className="font-display text-2xl font-bold">Connexion du personnel</h2>
              {error ? (
                <p
                  role="alert"
                  className="rounded-[10px] bg-danger-soft px-3 py-2.5 text-sm text-danger"
                >
                  {error}
                </p>
              ) : null}
              <InputField
                label="Adresse e-mail"
                type="email"
                autoComplete="username"
                inputMode="email"
                error={form.formState.errors.email?.message}
                {...form.register('email')}
              />
              <InputField
                label="Mot de passe"
                type="password"
                autoComplete="current-password"
                error={form.formState.errors.password?.message}
                {...form.register('password')}
              />
              <Button type="submit" size="lg" block loading={form.formState.isSubmitting}>
                Se connecter
              </Button>
            </form>
          ) : (
            <div className="flex flex-col gap-4">
              <h2 className="font-display text-2xl font-bold">Double authentification</h2>
              <p className="text-sm text-muted">
                Saisissez le code à 6 chiffres affiché par votre application d’authentification.
              </p>
              {error ? (
                <p
                  role="alert"
                  className="rounded-[10px] bg-danger-soft px-3 py-2.5 text-sm text-danger"
                >
                  {error}
                </p>
              ) : null}
              <InputField
                label="Code de vérification"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="text-center text-2xl tracking-[0.4em]"
              />
              <Button
                size="lg"
                block
                loading={busy}
                disabled={code.length !== 6}
                onClick={submitMfa}
              >
                Valider
              </Button>
            </div>
          )}
          <p className="text-center text-sm text-muted">
            Vous êtes parent d’élève ?{' '}
            <Link href="/parent/connexion" className="font-semibold text-primary underline">
              Connexion par SMS
            </Link>
          </p>
        </div>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}
