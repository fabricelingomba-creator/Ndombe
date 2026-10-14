import type { Metadata } from 'next';
import { FormattedDate } from '@/components/date';
import { SpaceHeaderActions } from '@/components/notification-bell';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { ApiError, getAnnouncements, getManifest } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { navFor } from '@/lib/navigation';
import { portalRequest } from '@/lib/request';

export const metadata: Metadata = { title: 'Mon espace' };

const ROLE_LABELS: Record<string, string> = {
  rector: 'Recteur',
  sg_academic: 'SG académique',
  sg_administration: 'SG administratif',
  sg_research: 'SG recherche',
  professor: 'Professeur',
  student: 'Étudiant',
};

/** Espace connecté : menus selon les permissions, annonces du campus. */
export default async function SpacePage() {
  const { host } = await portalRequest();
  const manifest = (await getManifest(host))!;
  const { me, accessToken } = await requireUser(host, '/espace');
  // Le fil d'annonces est secondaire : un refus ne doit pas empêcher d'afficher l'espace.
  const announcements = me.permissions.includes('announcements:read')
    ? await getAnnouncements(host, accessToken).catch((err) => {
        if (err instanceof ApiError && err.status === 403) return [];
        throw err;
      })
    : [];
  const sections = navFor(me.permissions, me.grants);

  return (
    <>
      <SiteHeader
        manifest={manifest}
        right={<SpaceHeaderActions />}
      />
      <main className="container section">
        <h1>Bonjour, {me.fullName}</h1>
        <p className="muted">{me.roles.map((r) => ROLE_LABELS[r] ?? r).join(' · ') || 'Aucun rôle attribué'}</p>

        <div className="space-grid">
          <nav aria-label="Mon espace" className="space-nav">
            {sections.length === 0 && <p className="muted">Aucun module disponible pour votre compte.</p>}
            {sections.map((s) => (
              <section key={s.key}>
                <h2>{s.label}</h2>
                <ul>
                  {s.items.map((item) => (
                    <li key={item.key}>
                      {item.upcoming ? (
                        <span className="nav-item disabled">
                          {item.label} <span className="badge">bientôt</span>
                        </span>
                      ) : (
                        <a className="nav-item" href={item.href}>
                          {item.label}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </nav>

          <section aria-labelledby="annonces">
            <h2 id="annonces">Annonces</h2>
            {announcements.length === 0 ? (
              <p className="muted">Aucune annonce.</p>
            ) : (
              <ul className="cards single">
                {announcements.map((a) => (
                  <li key={a.id} className="card">
                    <p className="card-meta">
                      <FormattedDate iso={a.publishedAt} locale={manifest.locale} />
                      {a.visibility === 'campus' && <span className="badge">Campus</span>}
                    </p>
                    <h3>{a.title}</h3>
                    <p>{a.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
      <SiteFooter manifest={manifest} />
    </>
  );
}
