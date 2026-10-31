import { normalizeVerificationCode } from '@ecole/shared';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { VerifyCodeForm } from './code-form';

export const metadata: Metadata = { title: 'Vérification d’un document' };
export const dynamic = 'force-dynamic';

/** Page publique de saisie du code imprimé sur un bulletin, un reçu ou un document officiel. */
export default async function VerifyHomePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const { code } = await searchParams;
  const typed = normalizeVerificationCode(Array.isArray(code) ? (code[0] ?? '') : (code ?? ''));
  if (typed) redirect(`/verifier/${encodeURIComponent(typed)}`);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-5 py-10">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="flex size-10 items-center justify-center rounded-[12px] bg-primary font-display font-bold text-white"
        >
          É
        </span>
        <span className="font-display text-lg font-bold">Vérification d’un document</span>
      </div>
      <section className="flex flex-col gap-4 rounded-[16px] border border-line bg-white p-5">
        <h1 className="font-display text-2xl font-bold">Vérifier l’authenticité</h1>
        <p className="text-sm text-muted">
          Bulletin, reçu, certificat de scolarité, attestation ou carte d’élève : saisissez le code
          imprimé sur le document, ou scannez son QR code.
        </p>
        <VerifyCodeForm />
      </section>
    </main>
  );
}
