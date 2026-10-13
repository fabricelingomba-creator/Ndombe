import 'server-only';
import { apiDownload } from './api';
import { UUID } from './grades';
import { portalRequest } from './request';
import { readAccess } from './session';

/**
 * Relaie un PDF de l'API au navigateur, avec le jeton de la session : le
 * navigateur n'appelle jamais l'API directement.
 */
export async function proxyTranscriptPdf(transcriptId: string, apiPath: (id: string) => string): Promise<Response> {
  if (!UUID.test(transcriptId)) return new Response('Introuvable', { status: 404 });
  const { host } = await portalRequest();
  const session = await readAccess(host);
  if (!session) return new Response('Session expirée', { status: 401 });

  const upstream = await apiDownload(host, apiPath(transcriptId), session.accessToken);
  if (!upstream.ok || !upstream.body) {
    return new Response(upstream.status === 404 ? 'Relevé introuvable' : 'Téléchargement impossible', {
      status: upstream.status === 404 ? 404 : 502,
    });
  }
  return new Response(upstream.body, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': upstream.headers.get('content-disposition') ?? 'attachment; filename="releve.pdf"',
      'cache-control': 'private, no-store',
    },
  });
}
