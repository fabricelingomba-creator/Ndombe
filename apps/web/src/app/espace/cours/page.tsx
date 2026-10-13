import type { Metadata } from 'next';
import { AccessDenied, SpaceShell } from '@/components/space-shell';
import { getManifest, getMyCourses } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { portalRequest } from '@/lib/request';

export const metadata: Metadata = { title: 'Mes cours' };

export default async function MyCoursesPage() {
  const { host } = await portalRequest();
  const manifest = (await getManifest(host))!;
  const { me, accessToken } = await requireUser(host, '/espace/cours');
  if (!me.permissions.includes('self:courses:read')) {
    return (
      <SpaceShell manifest={manifest} title="Mes cours">
        <AccessDenied />
      </SpaceShell>
    );
  }
  const courses = await getMyCourses(host, accessToken);

  return (
    <SpaceShell manifest={manifest} title="Mes cours">
      {courses.length === 0 ? (
        <p className="muted">Vous n&apos;êtes inscrit à aucun cours pour le moment.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Cours</th>
                <th scope="col">Période</th>
                <th scope="col" className="num">Crédits</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {courses.map((c) => (
                <tr key={c.enrollmentId}>
                  <td>
                    <strong>{c.courseCode}</strong> {c.courseTitle}
                    {c.section !== 'A' && <span className="muted"> · section {c.section}</span>}
                  </td>
                  <td>{c.termName}</td>
                  <td className="num">{c.credits}</td>
                  <td>{c.gradesPublished ? <a href="/espace/notes">Publiées</a> : <span className="muted">En attente</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SpaceShell>
  );
}
