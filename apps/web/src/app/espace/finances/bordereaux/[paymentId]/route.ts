import { apiDownload } from '@/lib/api';
import { UUID } from '@/lib/grades';
import { portalRequest } from '@/lib/request';
import { readAccess } from '@/lib/session';

const SLIP_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

/**
 * Affiche un bordereau téléversé, avec le jeton de la session. Le fichier vient
 * d'un étudiant : il est servi dans un bac à sable, sans script possible.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params;
  if (!UUID.test(paymentId)) return new Response('Introuvable', { status: 404 });
  const { host } = await portalRequest();
  const session = await readAccess(host);
  if (!session) return new Response('Session expirée', { status: 401 });

  const upstream = await apiDownload(host, `/v1/bank-payments/${paymentId}/slip`, session.accessToken, SLIP_TYPES.join(', '));
  const type = upstream.headers.get('content-type') ?? '';
  if (!upstream.ok || !upstream.body || !SLIP_TYPES.includes(type)) {
    const status = upstream.status === 404 || upstream.status === 403 ? 404 : 502;
    return new Response(status === 404 ? 'Bordereau introuvable' : 'Affichage impossible', { status });
  }
  // Un PDF est téléchargé (le lecteur PDF du navigateur refuse le bac à sable) ;
  // une photo s'affiche directement, sans script possible.
  const disposition = upstream.headers.get('content-disposition') ?? 'inline';
  return new Response(upstream.body, {
    headers: {
      'content-type': type,
      'content-disposition': type === 'application/pdf' ? disposition.replace(/^inline/, 'attachment') : disposition,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    },
  });
}
