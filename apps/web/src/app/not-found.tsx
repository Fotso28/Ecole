import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="font-display text-3xl font-bold">Page introuvable</h1>
      <p className="text-muted">Cette adresse ne correspond à aucune page.</p>
      <Link href="/" className="font-semibold text-primary underline">
        Revenir à l’accueil
      </Link>
    </main>
  );
}
