import type { Metadata } from 'next';
import Link from 'next/link';
import { FormattedDate } from '@/components/date';
import { AccessDenied, SpaceShell } from '@/components/space-shell';
import { getManifest, getReviewQueue } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { portalRequest } from '@/lib/request';
import type { ReviewItem } from '@/lib/types';

export const metadata: Metadata = { title: 'Validation des notes' };

/** File du secrétariat académique : feuilles à approuver, puis à publier. */
export default async function GradeReviewPage() {
  const { host } = await portalRequest();
  const manifest = (await getManifest(host))!;
  const { me, accessToken } = await requireUser(host, '/espace/validation-notes');
  const canApprove = me.permissions.includes('grades:approve');
  const canPublish = me.permissions.includes('grades:publish');
  if (!canApprove && !canPublish) {
    return (
      <SpaceShell manifest={manifest} title="Validation des notes">
        <AccessDenied />
      </SpaceShell>
    );
  }
  const [submitted, approved] = await Promise.all([
    canApprove ? getReviewQueue(host, accessToken, 'submitted') : Promise.resolve(null),
    canPublish ? getReviewQueue(host, accessToken, 'approved') : Promise.resolve(null),
  ]);

  return (
    <SpaceShell manifest={manifest} title="Validation des notes">
      {submitted && <Queue title="À approuver" empty="Aucune feuille en attente d'approbation." items={submitted} locale={manifest.locale} />}
      {approved && <Queue title="À publier" empty="Aucune feuille approuvée en attente de publication." items={approved} locale={manifest.locale} />}
    </SpaceShell>
  );
}

function Queue({ title, empty, items, locale }: { title: string; empty: string; items: ReviewItem[]; locale: string }) {
  return (
    <section className="queue">
      <h2>
        {title} <span className="count">{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="cards single">
          {items.map((i) => (
            <li key={i.id} className="card">
              <p className="card-meta">
                {i.departmentName} · {i.termCode} · section {i.section} · {i.enrolledCount} étudiants
              </p>
              <h3>
                <Link href={`/espace/validation-notes/${i.id}`}>
                  {i.courseCode} {i.courseTitle}
                </Link>
              </h3>
              {i.submittedAt && (
                <p className="small muted">
                  Soumise par {i.submittedBy ?? '—'} le <FormattedDate iso={i.submittedAt} locale={locale} />
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
