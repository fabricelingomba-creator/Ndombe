import { BadRequestException, BadGatewayException } from '@nestjs/common';
import {
  ChargeRequest,
  ChargeResult,
  InvalidSignatureError,
  PaymentFetch,
  PaymentProvider,
  ProviderEvent,
} from './provider';
import { verifyTimestampedSignature } from './signature';

const STRIPE_API = 'https://api.stripe.com/v1';

interface CheckoutSession {
  id: string;
  url?: string;
  payment_status?: string;
  amount_total?: number;
  currency?: string;
  client_reference_id?: string | null;
  metadata?: Record<string, string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Paiement par carte via Stripe Checkout : page de paiement hébergée par
 * Stripe (aucune donnée de carte ne transite par Elongo), confirmation par
 * webhook signé. Appels REST directs, sans SDK.
 */
export class StripeProvider implements PaymentProvider {
  readonly key = 'stripe' as const;
  readonly label = 'Carte bancaire (Stripe)';
  readonly requiresPhone = false;

  constructor(private readonly fetch: PaymentFetch) {}

  prepareSecrets(input: Record<string, unknown>): Record<string, string> {
    const { secretKey, webhookSecret } = input;
    if (typeof secretKey !== 'string' || !/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(secretKey)) {
      throw new BadRequestException('Clé secrète Stripe invalide (sk_live_… ou sk_test_…)');
    }
    if (typeof webhookSecret !== 'string' || !/^whsec_[A-Za-z0-9]{10,}$/.test(webhookSecret)) {
      throw new BadRequestException('Secret de webhook Stripe invalide (whsec_…)');
    }
    return { secretKey, webhookSecret };
  }

  async createCharge(secrets: Record<string, string>, request: ChargeRequest): Promise<ChargeResult> {
    const returnUrl = new URL(request.returnUrl);
    returnUrl.searchParams.set('paiement', request.paymentId);
    const form = new URLSearchParams({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': request.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(request.amountMinor),
      'line_items[0][price_data][product_data][name]': request.description,
      success_url: returnUrl.toString(),
      cancel_url: returnUrl.toString(),
      client_reference_id: request.paymentId,
      'metadata[payment_id]': request.paymentId,
      'metadata[tenant]': request.tenantSlug,
      // Délai minimal accepté par Stripe : au-delà, la session expire et le paiement échoue.
      expires_at: String(Math.floor(Date.now() / 1000) + 31 * 60),
    });
    let res: Response;
    try {
      res = await this.fetch(`${STRIPE_API}/checkout/sessions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${secrets.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          // Un nouvel essai réseau ne crée pas une seconde session.
          'idempotency-key': `elongo-${request.paymentId}`,
        },
        body: form,
      });
    } catch {
      throw new BadGatewayException('Stripe injoignable');
    }
    const session = (await res.json().catch(() => ({}))) as CheckoutSession & { error?: { message?: string } };
    if (!res.ok || !session.id || !session.url) {
      throw new BadGatewayException(`Stripe a refusé la demande : ${session.error?.message ?? res.status}`);
    }
    return { providerRef: session.id, redirectUrl: session.url };
  }

  parseWebhook(secrets: Record<string, string>, rawBody: Buffer, headers: Record<string, string | undefined>): ProviderEvent {
    verifyTimestampedSignature(headers['stripe-signature'], secrets.webhookSecret, rawBody);
    let event: { id?: string; type?: string; data?: { object?: CheckoutSession } };
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new InvalidSignatureError('Corps illisible');
    }
    if (!event.id || !event.type) throw new InvalidSignatureError('Événement incomplet');
    const session = event.data?.object;
    const base = {
      eventId: event.id,
      type: event.type,
      providerRef: session?.id ?? null,
      paymentId: session?.client_reference_id && UUID.test(session.client_reference_id) ? session.client_reference_id : undefined,
      amountMinor: session?.amount_total,
      currency: session?.currency?.toUpperCase(),
    };
    switch (event.type) {
      case 'checkout.session.completed':
        // Paiement différé (virement…) : on attend async_payment_succeeded.
        return { ...base, outcome: session?.payment_status === 'paid' ? 'succeeded' : 'ignored' };
      case 'checkout.session.async_payment_succeeded':
        return { ...base, outcome: 'succeeded' };
      case 'checkout.session.async_payment_failed':
        return { ...base, outcome: 'failed', failureReason: 'Paiement refusé' };
      case 'checkout.session.expired':
        return { ...base, outcome: 'failed', failureReason: 'Session de paiement expirée' };
      default:
        return { ...base, outcome: 'ignored' };
    }
  }
}
