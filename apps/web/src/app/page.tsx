import Link from 'next/link';
import { FormattedDate } from '@/components/date';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { getHomepage, getManifest } from '@/lib/api';
import { portalRequest } from '@/lib/request';
import { safeImageUrl } from '@/lib/theme';

/** Page d'accueil publique, à la marque de l'université servie par le domaine. */
export default async function HomePage() {
  const { host } = await portalRequest();
  const manifest = (await getManifest(host))!;
  const home = await getHomepage(host);
  const heroImage = safeImageUrl(home.hero.imageUrl);

  return (
    <>
      <SiteHeader manifest={manifest} />
      <main>
        <section
          className="hero"
          style={heroImage ? { backgroundImage: `linear-gradient(rgba(0,0,0,.45), rgba(0,0,0,.45)), url("${heroImage}")` } : undefined}
        >
          <div className="container">
            <h1>{home.hero.title ?? manifest.name}</h1>
            <p className="lead">{home.hero.subtitle ?? 'Votre université, en ligne : cours, notes, paiements et annonces.'}</p>
            <div className="actions">
              <Link href="/connexion" className="button button-light">
                Accéder à mon espace
              </Link>
              <Link href="#programmes" className="button button-outline">
                Découvrir les programmes
              </Link>
            </div>
          </div>
        </section>

        <section id="actualites" className="container section">
          <h2>Actualités et annonces</h2>
          {home.announcements.length === 0 ? (
            <p className="muted">Aucune annonce publiée pour le moment.</p>
          ) : (
            <ul className="cards">
              {home.announcements.map((a) => (
                <li key={a.id} className="card">
                  <p className="card-meta">
                    <FormattedDate iso={a.publishedAt} locale={manifest.locale} />
                  </p>
                  <h3>{a.title}</h3>
                  <p className="clamp">{a.body}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section id="programmes" className="section alt">
          <div className="container">
            <h2>Facultés et programmes</h2>
            {home.faculties.length === 0 ? (
              <p className="muted">Les facultés seront bientôt présentées ici.</p>
            ) : (
              <ul className="chips">
                {home.faculties.map((f) => (
                  <li key={f.code} className="chip">
                    {f.name}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>
      <SiteFooter manifest={manifest} />
    </>
  );
}
