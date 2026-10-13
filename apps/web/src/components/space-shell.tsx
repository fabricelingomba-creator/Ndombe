import Link from 'next/link';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import type { Manifest } from '@/lib/types';

/** Cadre commun des pages de l'espace connecté. */
export function SpaceShell({
  manifest,
  title,
  back = { href: '/espace', label: 'Mon espace' },
  children,
}: {
  manifest: Manifest;
  title: string;
  back?: { href: string; label: string } | null;
  children: React.ReactNode;
}) {
  return (
    <>
      <SiteHeader
        manifest={manifest}
        right={
          <form action="/auth/logout" method="post">
            <button type="submit" className="button button-outline-dark">
              Se déconnecter
            </button>
          </form>
        }
      />
      <main className="container section">
        {back && (
          <p className="small">
            <Link href={back.href}>← {back.label}</Link>
          </p>
        )}
        <h1>{title}</h1>
        {children}
      </main>
      <SiteFooter manifest={manifest} />
    </>
  );
}

export function AccessDenied() {
  return <p className="alert">Votre compte n&apos;a pas accès à cette page.</p>;
}
