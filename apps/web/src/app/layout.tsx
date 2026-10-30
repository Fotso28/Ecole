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
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
