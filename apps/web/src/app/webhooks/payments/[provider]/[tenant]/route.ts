import { relayPaymentWebhook } from '@/lib/api';

/** En-têtes utiles à la vérification ; les autres (cookies…) ne sont pas relayés. */
const FORWARDED = ['content-type', 'stripe-signature', 'x-sandbox-signature'];
const MAX_BODY = 256 * 1024;

/**
 * Point de réception des notifications des prestataires (Stripe, agrégateur
 * Mobile Money) sur le domaine du portail. L'API vérifie la signature.
 */
export async function POST(request: Request, { params }: { params: Promise<{ provider: string; tenant: string }> }) {
  const { provider, tenant } = await params;
  if (!/^[a-z]{2,20}$/.test(provider) || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(tenant)) {
    return new Response('Introuvable', { status: 404 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_BODY) return new Response('Corps invalide', { status: 400 });
  const headers: Record<string, string> = {};
  for (const name of FORWARDED) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  try {
    const upstream = await relayPaymentWebhook(`/webhooks/payments/${provider}/${tenant}`, body, headers);
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    });
  } catch {
    // Le prestataire renverra la notification plus tard.
    return new Response('API indisponible', { status: 503 });
  }
}
