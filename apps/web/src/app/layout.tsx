import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getManifest } from '@/lib/api';
import { portalRequest } from '@/lib/request';
import { brandStyle, safeImageUrl } from '@/lib/theme';
import './globals.css';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { host } = await portalRequest();
  const manifest = await getManifest(host);
  if (!manifest) return { title: 'Elongo' };
  const favicon = safeImageUrl(manifest.branding?.faviconUrl);
  return {
    title: { default: manifest.name, template: `%s · ${manifest.name}` },
    description: `Portail officiel de ${manifest.name}`,
    icons: favicon ? [{ url: favicon }] : undefined,
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { host } = await portalRequest();
  const manifest = await getManifest(host);

  if (!manifest) {
    return (
      <html lang="fr">
        <body>
          <main className="container narrow center">
            <h1>Université introuvable</h1>
            <p>
              Aucune université n&apos;est rattachée à l&apos;adresse <strong>{host}</strong>. Vérifiez le lien reçu de
              votre établissement.
            </p>
          </main>
        </body>
      </html>
    );
  }

  return (
    <html lang={manifest.locale}>
      <body style={brandStyle(manifest.branding)}>{children}</body>
    </html>
  );
}
