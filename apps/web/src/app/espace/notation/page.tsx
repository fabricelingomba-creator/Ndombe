import type { Metadata } from 'next';
import Link from 'next/link';
import { AccessDenied, SpaceShell } from '@/components/space-shell';
import { StatusBadge } from '@/components/status-badge';
import { getManifest, getTeaching } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { portalRequest } from '@/lib/request';

export const metadata: Metadata = { title: 'Notation' };

/** Cours attribués au professeur, avec l'avancement de chaque feuille de notes. */
export default async function GradingPage() {
  const { host } = await portalRequest();
  const manifest = (await getManifest(host))!;
  const { me, accessToken } = await requireUser(host, '/espace/notation');
  if (!me.permissions.includes('grades:enter')) {
    return (
      <SpaceShell manifest={manifest} title="Notation">
        <AccessDenied />
      </SpaceShell>
    );
  }
  const offerings = await getTeaching(host, accessToken);

  return (
    <SpaceShell manifest={manifest} title="Notation">
      {offerings.length === 0 ? (
        <p className="muted">Aucun cours ne vous est attribué pour le moment.</p>
      ) : (
        <ul className="cards single">
          {offerings.map((o) => (
            <li key={o.id} className="card row-card">
              <div>
                <p className="card-meta">
                  {o.termCode} · section {o.section}
                </p>
                <h2 className="h3">
                  <Link href={`/espace/notation/${o.id}`}>
                    {o.courseCode} {o.courseTitle}
                  </Link>
                </h2>
                <p className="small muted">
                  {o.gradedCount}/{o.enrolledCount} notes saisies
                </p>
                {o.gradesStatus === 'returned' && o.returnReason && (
                  <p className="small">
                    <strong>Motif du renvoi :</strong> {o.returnReason}
                  </p>
                )}
              </div>
              <StatusBadge status={o.gradesStatus} />
            </li>
          ))}
        </ul>
      )}
    </SpaceShell>
  );
}
