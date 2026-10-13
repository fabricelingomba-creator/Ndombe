import type { Metadata } from 'next';
import { FormattedDate } from '@/components/date';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { getManifest, verifyTranscript } from '@/lib/api';
import { formatScore } from '@/lib/grades';
import { portalRequest } from '@/lib/request';

export const metadata: Metadata = { title: 'Vérifier un relevé' };

/**
 * Page publique : un employeur ou une autre université saisit le code imprimé
 * sur un relevé et voit ce que l'université a réellement émis.
 */
export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ code?: string | string[] }> }) {
  const { code: raw } = await searchParams;
  const code = typeof raw === 'string' ? raw.trim().slice(0, 32) : '';
  const { host } = await portalRequest();
  const manifest = (await getManifest(host))!;
  const result = code ? await verifyTranscript(host, code) : null;

  return (
    <>
      <SiteHeader manifest={manifest} />
      <main className="container section narrow">
        <h1>Vérifier un relevé de notes</h1>
        <p className="muted">Saisissez le code de vérification imprimé en bas du relevé.</p>
        <form method="get" className="verify-form">
          <label htmlFor="code">Code de vérification</label>
          <div className="actions">
            <input id="code" name="code" defaultValue={code} placeholder="XXXX-XXXX-XXXX" autoComplete="off" required maxLength={32} />
            <button type="submit" className="button">
              Vérifier
            </button>
          </div>
        </form>

        {code && !result && (
          <p className="alert" role="status">
            Aucun relevé émis par {manifest.name} ne correspond à ce code.
          </p>
        )}
        {result && (
          <div className="notice verify-result" role="status">
            <p>
              <strong>Relevé authentique</strong>, émis par {result.university} le{' '}
              <FormattedDate iso={result.issuedAt} locale={manifest.locale} />.
            </p>
            <dl>
              <dt>Étudiant</dt>
              <dd>{result.studentName}</dd>
              <dt>Moyenne cumulée</dt>
              <dd>{result.average === null ? '—' : `${formatScore(result.average)}/20`}</dd>
              <dt>Crédits acquis</dt>
              <dd>{result.creditsEarned ?? '—'}</dd>
              <dt>Empreinte SHA-256</dt>
              <dd className="hash">{result.contentHash}</dd>
            </dl>
            <p className="small">Comparez ces informations et l&apos;empreinte avec celles du document reçu.</p>
          </div>
        )}
      </main>
      <SiteFooter manifest={manifest} />
    </>
  );
}
