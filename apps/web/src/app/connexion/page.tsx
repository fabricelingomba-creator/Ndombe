import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { getManifest } from '@/lib/api';
import { portalRequest } from '@/lib/request';
import { safeReturnTo } from '@/lib/return-to';

export const metadata: Metadata = { title: 'Connexion' };

const PROFILES = [
  { key: 'etudiant', title: 'Étudiants', text: 'Cours, devoirs, notes, relevés et paiements.' },
  { key: 'enseignant', title: 'Enseignants', text: 'Supports de cours, listes de classe, présences et notation.' },
  { key: 'administration', title: 'Administration', text: 'Rectorat, secrétariats généraux et services.' },
];

const ERRORS: Record<string, string> = {
  session: 'La connexion a expiré ou a été interrompue. Veuillez recommencer.',
  refus: 'La connexion a été annulée.',
  jeton: 'La connexion n’a pas pu être finalisée. Veuillez réessayer.',
  compte: 'Votre compte n’est pas encore activé dans cette université. Contactez son secrétariat.',
  universite: 'Université introuvable.',
};

/**
 * Trois points d'entrée, un seul realm : chaque profil passe par la même page de
 * connexion Keycloak, aux couleurs de l'université. Les droits viennent du compte.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const { host } = await portalRequest();
  const manifest = (await getManifest(host))!;
  const returnTo = safeReturnTo(params.returnTo);
  const error = params.erreur ? ERRORS[params.erreur] : null;

  return (
    <>
      <SiteHeader manifest={manifest} right={<span />} />
      <main className="container section narrow">
        <h1>Se connecter</h1>
        {error && (
          <p role="alert" className="alert">
            {error}
          </p>
        )}
        <ul className="profiles">
          {PROFILES.map((p) => (
            <li key={p.key}>
              <a className="profile" href={`/auth/login?profil=${p.key}&returnTo=${encodeURIComponent(returnTo)}`}>
                <strong>{p.title}</strong>
                <span>{p.text}</span>
              </a>
            </li>
          ))}
        </ul>
        <p className="muted small">
          Première connexion ? Utilisez le lien reçu par e-mail de votre université pour définir votre mot de passe.
        </p>
      </main>
      <SiteFooter manifest={manifest} />
    </>
  );
}
