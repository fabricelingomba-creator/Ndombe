import { createHmac, timingSafeEqual } from 'node:crypto';
import { InvalidSignatureError } from './provider';

/** Tolérance d'horloge et fenêtre de rejeu des webhooks. */
export const SIGNATURE_TOLERANCE_S = 300;

export function signPayload(secret: string, timestamp: number, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

/**
 * Vérifie un en-tête au format Stripe : « t=<horodatage>,v1=<hmac>[,v1=…] ».
 * HMAC-SHA256 de « t.corps », comparé en temps constant, horodatage récent.
 */
export function verifyTimestampedSignature(
  header: string | undefined,
  secret: string,
  rawBody: Buffer,
  now = Math.floor(Date.now() / 1000),
): void {
  if (!header) throw new InvalidSignatureError('Signature absente');
  const parts = header.split(',').map((p) => p.trim().split('=', 2) as [string, string]);
  const timestamp = Number(parts.find(([k]) => k === 't')?.[1]);
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isInteger(timestamp) || signatures.length === 0) throw new InvalidSignatureError('Signature mal formée');
  if (Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_S) throw new InvalidSignatureError('Signature expirée');
  const expected = Buffer.from(signPayload(secret, timestamp, rawBody), 'hex');
  const ok = signatures.some((s) => {
    const given = Buffer.from(s, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) throw new InvalidSignatureError('Signature invalide');
}
