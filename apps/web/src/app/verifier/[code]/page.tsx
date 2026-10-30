import { CheckCircle2, ShieldAlert, XCircle } from 'lucide-react';
import type { Metadata } from 'next';

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
    };

async function verify(code: string): Promise<Result | null> {
  const base = process.env.API_URL ?? 'http://localhost:4000';
  try {
    const res = await fetch(`${base}/verify/${encodeURIComponent(code)}`, { cache: 'no-store' });
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

export default async function VerifyPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
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
          <p className="text-sm">
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
            <h1 className="font-display text-xl font-bold">
              {result.valid
                ? result.type === 'report-card'
                  ? 'Bulletin authentique'
                  : 'Reçu authentique'
                : result.type === 'report-card'
                  ? `Bulletin remplacé par la version ${result.latestVersion ?? '—'}`
                  : 'Reçu annulé'}
            </h1>
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
                <dt className="text-muted">Version</dt>
                <dd className="text-right font-semibold">
                  {result.version} · publiée le {fr(result.publishedAt)}
                </dd>
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
    </main>
  );
}
