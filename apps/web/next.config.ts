import path from 'node:path';
import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  // Image Docker autonome ; `next start` reste utilisable en local et pour les tests.
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  poweredByHeader: false,
  devIndicators: false,
  transpilePackages: ['@ecole/shared'],
  // Monorepo : inclure les paquets de l'espace de travail dans la sortie autonome.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  // En développement, /api est relayé vers l'API ; en production, Nginx s'en charge.
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_URL ?? 'http://localhost:4000'}/:path*`,
      },
    ];
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Le service worker doit être revérifié à chaque visite pour se mettre à jour.
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    ];
  },
};

export default nextConfig;
