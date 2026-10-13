import { randomBytes } from 'node:crypto';
import { ChargeRequest, ChargeResult, InvalidSignatureError, PaymentProvider, ProviderEvent } from './provider';
import { verifyTimestampedSignature } from './signature';

export const SANDBOX_SIGNATURE_HEADER = 'x-sandbox-signature';

/**
 * Mobile Money simulé, pour le développement et les démonstrations : la
 * demande part « vers le téléphone » et la confirmation arrive par un webhook
 * signé, exactement comme chez un vrai agrégateur. Jamais actif en production.
 */
export class SandboxProvider implements PaymentProvider {
  readonly key = 'sandbox' as const;
  readonly label = 'Mobile Money (simulation)';
  readonly requiresPhone = true;

  prepareSecrets(): Record<string, string> {
    return { webhookSecret: `sbx_whsec_${randomBytes(24).toString('hex')}` };
  }

  async createCharge(_secrets: Record<string, string>, request: ChargeRequest): Promise<ChargeResult> {
    return {
      providerRef: `sbx_${request.paymentId}`,
      instructions: `Une demande de paiement a été envoyée au ${request.phone}. Validez-la avec votre code secret Mobile Money.`,
    };
  }

  parseWebhook(secrets: Record<string, string>, rawBody: Buffer, headers: Record<string, string | undefined>): ProviderEvent {
    verifyTimestampedSignature(headers[SANDBOX_SIGNATURE_HEADER], secrets.webhookSecret, rawBody);
    let body: {
      id?: unknown;
      type?: unknown;
      data?: { reference?: unknown; amount_minor?: unknown; currency?: unknown; reason?: unknown };
    };
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new InvalidSignatureError('Corps illisible');
    }
    if (typeof body.id !== 'string' || typeof body.type !== 'string') throw new InvalidSignatureError('Événement incomplet');
    const outcome = body.type === 'payment.succeeded' ? 'succeeded' : body.type === 'payment.failed' ? 'failed' : 'ignored';
    return {
      eventId: body.id,
      type: body.type,
      providerRef: typeof body.data?.reference === 'string' ? body.data.reference : null,
      outcome,
      amountMinor: typeof body.data?.amount_minor === 'number' ? body.data.amount_minor : undefined,
      currency: typeof body.data?.currency === 'string' ? body.data.currency : undefined,
      failureReason: typeof body.data?.reason === 'string' ? body.data.reason : undefined,
    };
  }
}
