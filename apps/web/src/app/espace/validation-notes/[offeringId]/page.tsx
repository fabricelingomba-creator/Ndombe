import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { SheetSummary } from '@/components/sheet-summary';
import { SpaceShell } from '@/components/space-shell';
import { getGradeSheet, getManifest } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { formatScore, PASSING_SCORE } from '@/lib/grades';
import { portalRequest } from '@/lib/request';
import { reviewGrades } from '../../actions';

export const metadata: Metadata = { title: 'Validation des notes' };

/** Examen d'une feuille soumise : approuver, renvoyer avec un motif, ou publier. */
export default async function GradeReviewDetailPage({ params }: { params: Promise<{ offeringId: string }> }) {
  const { offeringId } = await params;
  const { host } = await portalRequest();
  const manifest = (await getManifest(host))!;
  const { me, accessToken } = await requireUser(host, `/espace/validation-notes/${offeringId}`);
  const sheet = await getGradeSheet(host, accessToken, offeringId);
  if (!sheet) notFound();

  const scores = sheet.roster.map((r) => r.score).filter((s): s is number => s !== null);
  const average = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const passed = scores.filter((s) => s >= PASSING_SCORE).length;
  const canApprove = sheet.gradesStatus === 'submitted' && me.permissions.includes('grades:approve');
  const canPublish = sheet.gradesStatus === 'approved' && me.permissions.includes('grades:publish');

  return (
    <SpaceShell
      manifest={manifest}
      title={`${sheet.courseCode} ${sheet.courseTitle}`}
      back={{ href: '/espace/validation-notes', label: 'Validation des notes' }}
    >
      <SheetSummary sheet={sheet} />
      <dl className="stats">
        <div>
          <dt>Moyenne du cours</dt>
          <dd>{average === null ? '—' : `${formatScore(Math.round(average * 100) / 100)}/20`}</dd>
        </div>
        <div>
          <dt>Réussite</dt>
          <dd>
            {passed}/{sheet.roster.length}
          </dd>
        </div>
      </dl>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Étudiant</th>
              <th scope="col" className="num">
                Note /20
              </th>
            </tr>
          </thead>
          <tbody>
            {sheet.roster.map((r) => (
              <tr key={r.enrollmentId}>
                <td>
                  {r.fullName} <span className="small muted">· {r.email}</span>
                </td>
                <td className={`num${r.score !== null && r.score < PASSING_SCORE ? ' fail' : ''}`}>{formatScore(r.score)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canApprove && (
        <div className="review-actions">
          <ActionForm action={reviewGrades.bind(null, sheet.id, 'approve')}>
            <SubmitButton>Approuver les notes</SubmitButton>
          </ActionForm>
          <ActionForm action={reviewGrades.bind(null, sheet.id, 'return')} className="return-form">
            <label htmlFor="reason">Motif du renvoi au professeur</label>
            <textarea id="reason" name="reason" rows={3} maxLength={2000} required minLength={3} />
            <SubmitButton variant="outline">Renvoyer</SubmitButton>
          </ActionForm>
        </div>
      )}
      {canPublish && (
        <ActionForm action={reviewGrades.bind(null, sheet.id, 'publish')} className="review-actions">
          <p className="small muted">La publication rend les notes visibles aux étudiants. Elle est définitive.</p>
          <SubmitButton>Publier aux étudiants</SubmitButton>
        </ActionForm>
      )}
    </SpaceShell>
  );
}
