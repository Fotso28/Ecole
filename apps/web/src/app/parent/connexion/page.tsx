'use client';

import { normalizeCameroonPhone, formatCameroonPhone } from '@ecole/shared';
import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

const T = {
  fr: {
    title: 'Suivez la scolarité de vos enfants',
    lead: 'Notes, absences, paiements : tout depuis votre téléphone. Pas de mot de passe à retenir.',
    phone: 'Votre numéro de téléphone',
    hint: 'Le numéro donné à l’école lors de l’inscription.',
    invalid: 'Numéro camerounais à 9 chiffres attendu.',
    send: 'Recevoir un code par SMS',
    change: 'Changer de numéro',
    codeTitle: 'Entrez le code reçu',
    codeLead: 'Si ce numéro est connu de l’école, un code à 6 chiffres vient d’être envoyé au',
    codeLabel: 'Code à 6 chiffres',
    codeHint:
      'Le code reste valable 15 minutes. Si vous avez reçu plusieurs SMS, le dernier code fonctionne.',
    login: 'Se connecter',
    resend: 'Renvoyer le code',
    resendIn: (s: number) => `Renvoyer le code dans 0:${String(s).padStart(2, '0')}`,
    staff: 'Personnel de l’école ?',
    staffLink: 'Connexion par e-mail',
    langName: 'Français',
    errors: {
      code: 'Code incorrect ou expiré.',
      tooMany: 'Trop de demandes. Réessayez dans quelques minutes.',
      invalid: 'Vérifiez le numéro ou le code saisi.',
      server: 'Service momentanément indisponible. Réessayez plus tard.',
      network: 'Erreur réseau : vérifiez votre connexion puis réessayez.',
    },
  },
  en: {
    title: 'Follow your children’s schooling',
    lead: 'Grades, absences, payments: all from your phone. No password to remember.',
    phone: 'Your phone number',
    hint: 'The number you gave the school at enrolment.',
    invalid: 'A 9-digit Cameroon number is expected.',
    send: 'Get a code by SMS',
    change: 'Change number',
    codeTitle: 'Enter the code you received',
    codeLead: 'If this number is known to the school, a 6-digit code has been sent to',
    codeLabel: '6-digit code',
    codeHint:
      'The code is valid for 15 minutes. If you received several SMS, the latest code works.',
    login: 'Sign in',
    resend: 'Resend code',
    resendIn: (s: number) => `Resend code in 0:${String(s).padStart(2, '0')}`,
    staff: 'School staff?',
    staffLink: 'Sign in with e-mail',
    langName: 'English',
    errors: {
      code: 'Incorrect or expired code.',
      tooMany: 'Too many attempts. Please try again in a few minutes.',
      invalid: 'Please check the number or the code you entered.',
      server: 'The service is temporarily unavailable. Please try again later.',
      network: 'Network error: check your connection and try again.',
    },
  },
} as const;

type Lang = keyof typeof T;

/**
 * Message d'erreur dans la langue choisie : en français, le message précis de l'API ; en anglais,
 * une traduction selon le type d'erreur (code refusé, trop de demandes, réseau…).
 */
function errorMessage(e: unknown, lang: Lang): string {
  const t = T[lang].errors;
  if (!(e instanceof ApiError)) return t.network;
  if (lang === 'fr' && e.message) return e.message;
  if (e.status === 401) return t.code;
  if (e.status === 429) return t.tooMany;
  if (e.status >= 500) return t.server;
  return t.invalid;
}

export default function ParentLoginPage() {
  const { status, me, requestOtp, verifyOtp } = useAuth();
  const router = useRouter();
  const [lang, setLang] = useState<Lang>('fr');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const t = T[lang];

  useEffect(() => {
    try {
      const saved = localStorage.getItem('ecole.lang');
      if (saved === 'en' || saved === 'fr') setLang(saved);
    } catch {
      // Stockage indisponible : français par défaut.
    }
  }, []);
  // Langue du document (lecteurs d'écran) : suit le choix, revient au français en quittant la page.
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  useEffect(
    () => () => {
      document.documentElement.lang = 'fr';
    },
    [],
  );
  useEffect(() => {
    if (status === 'authenticated' && me?.kind === 'parent') router.replace('/portail');
  }, [status, me, router]);
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const chooseLang = (l: Lang) => {
    setLang(l);
    setError(null);
    try {
      localStorage.setItem('ecole.lang', l);
    } catch {
      // Préférence non mémorisée.
    }
  };

  const normalized = normalizeCameroonPhone(phone);

  const send = async () => {
    if (!normalized) {
      setError(t.invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await requestOtp(normalized);
      setStep('code');
      setCooldown(45);
    } catch (e) {
      setError(errorMessage(e, lang));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!normalized) return;
    setBusy(true);
    setError(null);
    try {
      await verifyOtp(normalized, code);
    } catch (e) {
      setError(errorMessage(e, lang));
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-7 px-6 pt-10 pb-8">
      <div className="flex items-center justify-between">
        <span className="flex size-11 items-center justify-center rounded-[12px] bg-primary font-display text-xl font-bold text-white">
          É
        </span>
        <div
          role="group"
          aria-label={lang === 'fr' ? 'Langue' : 'Language'}
          className="flex gap-0.5 rounded-full bg-neutral-soft p-1"
        >
          {(['fr', 'en'] as const).map((l) => (
            <button
              key={l}
              type="button"
              lang={l}
              aria-label={T[l].langName}
              aria-pressed={lang === l}
              onClick={() => chooseLang(l)}
              className={cn(
                'h-10 min-w-12 rounded-full text-sm font-bold uppercase',
                lang === l ? 'bg-white shadow-sm' : 'text-muted',
              )}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {step === 'phone' ? (
        <form
          className="flex flex-1 flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="flex flex-col gap-2">
            <h1 className="font-display text-[32px] leading-[1.1] font-bold">{t.title}</h1>
            <p className="text-base text-muted">{t.lead}</p>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="phone" className="text-sm font-semibold">
              {t.phone}
            </label>
            <div
              className={cn(
                'flex h-14 items-center overflow-hidden rounded-[14px] border-2 bg-white',
                error ? 'border-danger' : 'border-primary',
              )}
            >
              <span className="flex h-full items-center border-r border-line bg-paper px-3.5 text-[17px] font-semibold">
                +237
              </span>
              <input
                id="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="6 77 12 34 56"
                aria-invalid={!!error || undefined}
                aria-describedby="phone-hint"
                className="h-full min-w-0 flex-1 px-3.5 text-[19px] font-semibold tracking-wide tabular outline-none"
              />
            </div>
            <span
              id="phone-hint"
              className={cn('text-sm', error ? 'font-medium text-danger' : 'text-muted')}
              role={error ? 'alert' : undefined}
            >
              {error ?? t.hint}
            </span>
          </div>
          <Button type="submit" size="lg" block loading={busy}>
            {t.send}
          </Button>
          <p className="mt-auto text-center text-sm text-muted">
            {t.staff}{' '}
            <Link href="/connexion" className="font-semibold text-primary underline">
              {t.staffLink}
            </Link>
          </p>
        </form>
      ) : (
        <form
          className="flex flex-1 flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
        >
          <button
            type="button"
            onClick={() => {
              setStep('phone');
              setCode('');
              setError(null);
            }}
            className="-ml-2 flex h-11 items-center gap-1 self-start rounded-[10px] px-2 text-[15px] font-semibold text-primary"
          >
            <ChevronLeft className="size-5" aria-hidden />
            {t.change}
          </button>
          <div className="flex flex-col gap-2">
            <h1 className="font-display text-[30px] leading-[1.1] font-bold">{t.codeTitle}</h1>
            <p className="text-base text-muted">
              {t.codeLead}{' '}
              <strong className="text-ink">
                +237 {normalized ? formatCameroonPhone(normalized) : phone}
              </strong>
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="code" className="text-sm font-semibold">
              {t.codeLabel}
            </label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              aria-invalid={!!error || undefined}
              aria-describedby="code-hint code-error"
              className={cn(
                'h-16 rounded-[14px] border-2 bg-white text-center text-[30px] font-bold tracking-[0.5em] tabular outline-none',
                error ? 'border-danger' : 'border-primary',
              )}
            />
            <span id="code-hint" className="text-sm text-muted">
              {t.codeHint}
            </span>
            {error ? (
              <span id="code-error" role="alert" className="text-sm font-medium text-danger">
                {error}
              </span>
            ) : null}
          </div>
          <Button type="submit" size="lg" block loading={busy} disabled={code.length !== 6}>
            {t.login}
          </Button>
          <Button variant="ghost" block disabled={cooldown > 0 || busy} onClick={() => void send()}>
            {cooldown > 0 ? t.resendIn(cooldown) : t.resend}
          </Button>
        </form>
      )}
    </main>
  );
}
