import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { SheetSummary } from '@/components/sheet-summary';
import { SpaceShell } from '@/components/space-shell';
import { getGradeSheet, getManifest } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { formatScore } from '@/lib/grades';
import { portalRequest } from '@/lib/request';
import { saveGrades } from '../../actions';

export const metadata: Metadata = { title: 'Feuille de notes' };

/** Saisie des notes d'un cours, puis soumission au secrétariat académique. */
export default async function GradeEntryPage({ params }: { params: Promise<{ offeringId: string }> }) {
  const { offeringId } = await params;
  const { host } = await portalRequest();
  const manifest = (await getManifest(host))!;
  const { accessToken } = await requireUser(host, `/espace/notation/${offeringId}`);
  const sheet = await getGradeSheet(host, accessToken, offeringId);
  if (!sheet) notFound();

  const editable = sheet.gradesStatus === 'draft' || sheet.gradesStatus === 'returned';
  const back = { href: '/espace/notation', label: 'Notation' };
  const title = `${sheet.courseCode} ${sheet.courseTitle}`;

  if (sheet.roster.length === 0) {
    return (
      <SpaceShell manifest={manifest} title={title} back={back}>
        <SheetSummary sheet={sheet} />
        <p className="muted">Aucun étudiant inscrit à ce cours.</p>
      </SpaceShell>
    );
  }

  return (
    <SpaceShell manifest={manifest} title={title} back={back}>
      <SheetSummary sheet={sheet} />
      {!editable && <p className="notice">Cette feuille est verrouillée : les notes ne sont plus modifiables.</p>}
      <ActionForm action={saveGrades.bind(null, sheet.id)} className="sheet-form">
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
                    <label htmlFor={`score-${r.enrollmentId}`}>{r.fullName}</label>
                    <span className="small muted"> · {r.email}</span>
                  </td>
                  <td className="num">
                    {editable ? (
                      <input
                        id={`score-${r.enrollmentId}`}
                        name={`score:${r.enrollmentId}`}
                        className="score-input"
                        inputMode="decimal"
                        autoComplete="off"
                        pattern="\d{1,2}([.,]\d{1,2})?"
                        title="Note entre 0 et 20, deux décimales au plus"
                        defaultValue={r.score === null ? '' : formatScore(r.score)}
                      />
                    ) : (
                      formatScore(r.score)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {editable && (
          <div className="actions">
            <SubmitButton name="intent" value="save" variant="outline">
              Enregistrer le brouillon
            </SubmitButton>
            <SubmitButton name="intent" value="submit">
              Enregistrer et soumettre
            </SubmitButton>
          </div>
        )}
      </ActionForm>
    </SpaceShell>
  );
}
