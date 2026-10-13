import type { Metadata } from 'next';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { FormattedDate } from '@/components/date';
import { AccessDenied, SpaceShell } from '@/components/space-shell';
import { getManifest, getMyGrades, getMyTranscripts } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { formatScore, PASSING_SCORE } from '@/lib/grades';
import { portalRequest } from '@/lib/request';
import type { Transcript } from '@/lib/types';
import { requestTranscript } from '../actions';

export const metadata: Metadata = { title: 'Mes notes' };

/** Notes publiées, par période, avec la moyenne pondérée par les crédits. */
export default async function MyGradesPage() {
  const { host } = await portalRequest();
  const manifest = (await getManifest(host))!;
  const { me, accessToken } = await requireUser(host, '/espace/notes');
  if (!me.permissions.includes('self:grades:read')) {
    return (
      <SpaceShell manifest={manifest} title="Notes et relevés">
        <AccessDenied />
      </SpaceShell>
    );
  }
  const canDownload = me.permissions.includes('self:transcripts:download');
  const [terms, transcripts] = await Promise.all([
    getMyGrades(host, accessToken),
    canDownload ? getMyTranscripts(host, accessToken) : Promise.resolve([]),
  ]);

  return (
    <SpaceShell manifest={manifest} title="Notes et relevés">
      {terms.length === 0 && <p className="muted">Aucune note publiée pour le moment.</p>}
      {terms.map((t) => (
        <section key={t.termCode} className="card term" aria-labelledby={`term-${t.termCode}`}>
          <div className="term-head">
            <h2 id={`term-${t.termCode}`}>{t.termName}</h2>
            <dl className="stats">
              <div>
                <dt>Moyenne</dt>
                <dd>{t.average === null ? '—' : `${formatScore(t.average)}/20`}</dd>
              </div>
              <div>
                <dt>Crédits acquis</dt>
                <dd>
                  {t.creditsEarned}/{t.creditsAttempted}
                </dd>
              </div>
            </dl>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Cours</th>
                  <th scope="col" className="num">Crédits</th>
                  <th scope="col" className="num">Note /20</th>
                  <th scope="col">Résultat</th>
                </tr>
              </thead>
              <tbody>
                {t.grades.map((g) => (
                  <tr key={g.courseCode}>
                    <td>
                      <strong>{g.courseCode}</strong> {g.courseTitle}
                    </td>
                    <td className="num">{g.credits}</td>
                    <td className="num">{formatScore(g.score)}</td>
                    <td>{g.score >= PASSING_SCORE ? 'Validé' : <span className="fail">Non validé</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      {canDownload && <OfficialTranscripts transcripts={transcripts} hasGrades={terms.length > 0} locale={manifest.locale} />}
    </SpaceShell>
  );
}

const TRANSCRIPT_LABELS: Record<Transcript['status'], string> = {
  requested: 'En attente de validation',
  validated: 'Émis',
  rejected: 'Refusé',
};

/** Relevés officiels : demande au secrétariat, puis téléchargement du PDF signé. */
function OfficialTranscripts({ transcripts, hasGrades, locale }: { transcripts: Transcript[]; hasGrades: boolean; locale: string }) {
  const pending = transcripts.some((t) => t.status === 'requested');
  return (
    <section className="queue" aria-labelledby="releves">
      <h2 id="releves">Relevés officiels</h2>
      <p className="small muted">
        Le relevé officiel est validé par le secrétariat académique. Il porte un code que tout destinataire peut vérifier
        sur la page <a href="/verifier">Vérifier un relevé</a>.
      </p>
      {pending && <p className="notice">Votre demande est en attente de validation par le secrétariat académique.</p>}
      {hasGrades && !pending && (
        <ActionForm action={requestTranscript}>
          <SubmitButton>Demander un relevé officiel</SubmitButton>
        </ActionForm>
      )}
      {transcripts.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Demandé le</th>
                <th scope="col">État</th>
                <th scope="col">Document</th>
              </tr>
            </thead>
            <tbody>
              {transcripts.map((t) => (
                <tr key={t.id}>
                  <td>
                    <FormattedDate iso={t.requestedAt} locale={locale} />
                  </td>
                  <td>
                    {TRANSCRIPT_LABELS[t.status]}
                    {t.rejectReason && <span className="small muted"> · {t.rejectReason}</span>}
                  </td>
                  <td>
                    {t.status === 'validated' ? (
                      <a href={`/espace/releves/${t.id}/pdf`}>Télécharger le PDF ({t.verificationCode})</a>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
