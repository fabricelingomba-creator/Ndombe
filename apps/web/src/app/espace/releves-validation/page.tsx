import type { Metadata } from 'next';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { FormattedDate } from '@/components/date';
import { AccessDenied, SpaceShell } from '@/components/space-shell';
import { getManifest, getTranscriptQueue } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { portalRequest } from '@/lib/request';
import { decideTranscript } from '../actions';

export const metadata: Metadata = { title: 'Relevés officiels' };

/** Demandes de relevés à traiter, et derniers relevés émis. */
export default async function TranscriptReviewPage() {
  const { host } = await portalRequest();
  const manifest = (await getManifest(host))!;
  const { me, accessToken } = await requireUser(host, '/espace/releves-validation');
  const universityWide = me.grants.some((g) => g.permission === 'transcripts:validate' && g.scope.type === 'university');
  if (!universityWide) {
    return (
      <SpaceShell manifest={manifest} title="Relevés officiels">
        <AccessDenied />
      </SpaceShell>
    );
  }
  const [requested, validated] = await Promise.all([
    getTranscriptQueue(host, accessToken, 'requested'),
    getTranscriptQueue(host, accessToken, 'validated'),
  ]);

  return (
    <SpaceShell manifest={manifest} title="Relevés officiels">
      <p className="muted">
        Valider un relevé fige les notes publiées à cet instant dans un PDF signé par son empreinte. Une correction
        ultérieure demandera un nouveau relevé.
      </p>
      <section className="queue">
        <h2>
          À traiter <span className="count">{requested.length}</span>
        </h2>
        {requested.length === 0 ? (
          <p className="muted">Aucune demande en attente.</p>
        ) : (
          <ul className="cards single">
            {requested.map((t) => (
              <li key={t.id} className="card">
                <p className="card-meta">
                  Demandé le <FormattedDate iso={t.requestedAt} locale={manifest.locale} />
                </p>
                <h3>{t.studentName}</h3>
                <p className="small muted">{t.studentEmail}</p>
                <div className="review-actions">
                  <ActionForm action={decideTranscript.bind(null, t.id, 'validate')}>
                    <SubmitButton>Valider et émettre</SubmitButton>
                  </ActionForm>
                  <ActionForm action={decideTranscript.bind(null, t.id, 'reject')} className="return-form">
                    <label htmlFor={`reason-${t.id}`}>Motif du refus</label>
                    <textarea id={`reason-${t.id}`} name="reason" rows={2} maxLength={2000} required minLength={3} />
                    <SubmitButton variant="outline">Refuser</SubmitButton>
                  </ActionForm>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="queue">
        <h2>Derniers relevés émis</h2>
        {validated.length === 0 ? (
          <p className="muted">Aucun relevé émis pour le moment.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Étudiant</th>
                  <th scope="col">Émis le</th>
                  <th scope="col">Code</th>
                </tr>
              </thead>
              <tbody>
                {validated.map((t) => (
                  <tr key={t.id}>
                    <td>{t.studentName}</td>
                    <td>{t.decidedAt && <FormattedDate iso={t.decidedAt} locale={manifest.locale} />}</td>
                    <td>
                      <a href={`/espace/releves-validation/${t.id}/pdf`}>{t.verificationCode}</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </SpaceShell>
  );
}
