import {
  ADMIN_DOCUMENT_FEMININE,
  normalizeVerificationCode,
  type AdminDocumentType,
} from '@ecole/shared';
import { CheckCircle2, ShieldAlert, XCircle } from 'lucide-react';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { forwardedFor } from '@/lib/client-ip';
import { VerifyCodeForm } from '../code-form';

export const metadata: Metadata = { title: 'Vérification d’un document' };
export const dynamic = 'force-dynamic';

type Result =
  | {
      type: 'report-card';
      valid: boolean;
      status: string;
      school: string;
      student: string;
      class: string;
      term: string;
      year: string;
      version: number;
      latestVersion: number | null;
      generalAverage: string | null;
      annualAverage: string | null;
      yearEndDecision: string | null;
      publishedAt: string | null;
    }
  | {
      type: 'receipt';
      valid: boolean;
      status: string;
      school: string;
      student: string;
      number: string;
      amount: string;
      issuedAt: string;
    }
  | {
      type: 'document';
      documentType: AdminDocumentType;
      label: string;
      valid: boolean;
      status: 'ISSUED' | 'CANCELLED';
      school: string;
      student: string;
      class: string;
      year: string;
      number: string;
      duplicateOf: string | null;
      issuedAt: string;
      cancelledAt: string | null;
    };

function heading(result: Result): string {
  if (result.type === 'document')
    return result.valid
      ? `${result.label} authentique`
      : `${result.label} ${ADMIN_DOCUMENT_FEMININE[result.documentType] ? 'annulée' : 'annulé'}`;
  if (result.valid)
    return result.type === 'report-card' ? 'Bulletin authentique' : 'Reçu authentique';
  return result.type === 'report-card'
    ? `Bulletin remplacé par la version ${result.latestVersion ?? '—'}`
    : 'Reçu annulé';
}

async function verify(code: string): Promise<Result | null> {
  const base = process.env.API_URL ?? 'http://localhost:4000';
  try {
    // Limite de débit par visiteur, et non une seule pour tous les visiteurs du site.
    const res = await fetch(`${base}/verify/${encodeURIComponent(code)}`, {
      cache: 'no-store',
      headers: forwardedFor((await headers()).get('x-real-ip')),
    });
    if (!res.ok) return null;
    return (await res.json()) as Result;
  } catch {
    return null;
  }
}

const fr = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Africa/Douala',
      }).format(new Date(iso))
    : '—';

/** Code de l'adresse, décodé (« %20 » → espace). */
function decoded(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default async function VerifyPage({ params }: { params: Promise<{ code: string }> }) {
  const typed = decoded((await params).code);
  // Minuscules, espaces et tirets acceptés : redirection vers l'adresse du code normalisé.
  const code = normalizeVerificationCode(typed);
  if (!code) redirect('/verifier');
  if (code !== typed) redirect(`/verifier/${encodeURIComponent(code)}`);
  const result = await verify(code);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-5 py-10">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-[12px] bg-primary font-display font-bold text-white">
          É
        </span>
        <span className="font-display text-lg font-bold">Vérification d’un document</span>
      </div>
      {!result ? (
        <section className="flex flex-col items-center gap-3 rounded-[16px] bg-danger-soft p-6 text-center">
          <ShieldAlert className="size-12 text-danger" aria-hidden />
          <h1 className="font-display text-2xl font-bold">Code inconnu</h1>
          <p className="text-sm [overflow-wrap:anywhere]">
            Aucun document ne correspond au code {code}. Ce document n’a pas été émis par un
            établissement utilisant Ecole, ou le code a été mal recopié.
          </p>
        </section>
      ) : (
        <section
          className={`flex flex-col gap-4 rounded-[16px] p-6 ${result.valid ? 'bg-primary-soft' : 'bg-warn-soft'}`}
        >
          <div className="flex items-center gap-3">
            {result.valid ? (
              <CheckCircle2 className="size-10 text-primary" aria-hidden />
            ) : (
              <XCircle className="size-10 text-warn" aria-hidden />
            )}
            <h1 className="font-display text-xl font-bold">{heading(result)}</h1>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">Établissement</dt>
            <dd className="text-right font-semibold">{result.school}</dd>
            <dt className="text-muted">Élève</dt>
            <dd className="text-right font-semibold">{result.student}</dd>
            {result.type === 'report-card' ? (
              <>
                <dt className="text-muted">Classe</dt>
                <dd className="text-right font-semibold">{result.class}</dd>
                <dt className="text-muted">Période</dt>
                <dd className="text-right font-semibold">
                  {result.term} {result.year}
                </dd>
                <dt className="text-muted">Moyenne générale</dt>
                <dd className="text-right font-semibold tabular">
                  {result.generalAverage ?? '—'} / 20
                </dd>
                {result.annualAverage ? (
                  <>
                    <dt className="text-muted">Moyenne annuelle</dt>
                    <dd className="text-right font-semibold tabular">
                      {result.annualAverage} / 20
                    </dd>
                  </>
                ) : null}
                {result.yearEndDecision ? (
                  <>
                    <dt className="text-muted">Décision de fin d’année</dt>
                    <dd className="text-right font-semibold">{result.yearEndDecision}</dd>
                  </>
                ) : null}
                <dt className="text-muted">Version</dt>
                <dd className="text-right font-semibold">
                  {result.version} · publiée le {fr(result.publishedAt)}
                </dd>
              </>
            ) : result.type === 'document' ? (
              <>
                <dt className="text-muted">Classe</dt>
                <dd className="text-right font-semibold">
                  {result.class} · {result.year}
                </dd>
                <dt className="text-muted">Numéro</dt>
                <dd className="text-right font-semibold tabular">{result.number}</dd>
                {result.duplicateOf ? (
                  <>
                    <dt className="text-muted">Duplicata de</dt>
                    <dd className="text-right font-semibold tabular">{result.duplicateOf}</dd>
                  </>
                ) : null}
                <dt className="text-muted">Délivré le</dt>
                <dd className="text-right font-semibold">{fr(result.issuedAt)}</dd>
                {result.cancelledAt ? (
                  <>
                    <dt className="text-muted">Annulé le</dt>
                    <dd className="text-right font-semibold">{fr(result.cancelledAt)}</dd>
                  </>
                ) : null}
              </>
            ) : (
              <>
                <dt className="text-muted">Reçu</dt>
                <dd className="text-right font-semibold tabular">{result.number}</dd>
                <dt className="text-muted">Montant</dt>
                <dd className="text-right font-semibold tabular">{result.amount}</dd>
                <dt className="text-muted">Émis le</dt>
                <dd className="text-right font-semibold">{fr(result.issuedAt)}</dd>
              </>
            )}
          </dl>
        </section>
      )}
      <section className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-bold">Vérifier un autre document</h2>
        <VerifyCodeForm />
      </section>
    </main>
  );
}
