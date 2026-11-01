import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: { default: 'Ecole', template: '%s · Ecole' },
  description:
    'Gestion scolaire : élèves, présences, notes, bulletins, scolarité et portail des parents.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Ecole',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0E2A20',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>
        {process.env.NEXT_PUBLIC_DEPLOY_STAGE === 'preprod' ? (
          <p
            role="note"
            className="bg-saffron px-4 py-1.5 text-center text-[13px] font-semibold text-ink"
          >
            Préproduction : données de démonstration, aucun SMS n’est envoyé.
          </p>
        ) : null}
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
