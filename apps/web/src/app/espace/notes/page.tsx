import type { Metadata } from 'next';
import { AccessDenied, SpaceShell } from '@/components/space-shell';
import { getManifest, getMyGrades } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { formatScore, PASSING_SCORE } from '@/lib/grades';
import { portalRequest } from '@/lib/request';

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
  const terms = await getMyGrades(host, accessToken);

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
      <p className="small muted">Le relevé officiel au format PDF sera disponible prochainement.</p>
    </SpaceShell>
  );
}
