import Link from 'next/link';
import type { Manifest } from '@/lib/types';
import { safeImageUrl } from '@/lib/theme';

export function SiteHeader({ manifest, right }: { manifest: Manifest; right?: React.ReactNode }) {
  const logo = safeImageUrl(manifest.branding?.logoUrl);
  return (
    <header className="site-header">
      <div className="container header-row">
        <Link href="/" className="brand">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element -- logo hébergé par l'université, taille fixe
            <img src={logo} alt="" width={40} height={40} />
          ) : (
            <span className="brand-mark" aria-hidden="true">
              {manifest.name.charAt(0)}
            </span>
          )}
          <span>{manifest.name}</span>
        </Link>
        <nav aria-label="Navigation principale" className="header-nav">
          {right ?? (
            <>
              <Link href="/#programmes">Programmes</Link>
              <Link href="/#actualites">Actualités</Link>
              <Link href="/connexion" className="button">
                Se connecter
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter({ manifest }: { manifest: Manifest }) {
  return (
    <footer className="site-footer">
      <div className="container">
        © {new Date().getFullYear()} {manifest.name} · <Link href="/verifier">Vérifier un relevé</Link> · Portail propulsé par
        Elongo
      </div>
    </footer>
  );
}
