import { randomBytes } from 'node:crypto';
import { loadEnv } from '../config/env';
import { fromMinor, toMinor } from './money';
import { InvalidSignatureError } from './providers/provider';
import { signPayload, verifyTimestampedSignature } from './providers/signature';
import { StripeProvider } from './providers/stripe.provider';
import { openSecrets, sealSecrets } from './secret-box';

describe('Montants', () => {
  it('convertit en unités mineures sans arrondi silencieux', () => {
    expect(toMinor(250.5)).toBe(25050);
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(toMinor(19.99)).toBe(1999);
    expect(toMinor(12.345)).toBeNull();
    expect(toMinor(0)).toBeNull();
    expect(toMinor(-5)).toBeNull();
    expect(toMinor(Number.NaN)).toBeNull();
    expect(fromMinor('25050')).toBe(250.5);
  });
});

describe('Coffre à secrets (AES-256-GCM)', () => {
  const key = randomBytes(32);
  const secrets = { secretKey: 'sk_test_123', webhookSecret: 'whsec_456' };

  it('chiffre puis déchiffre, sans laisser le secret en clair', () => {
    const sealed = sealSecrets(key, 't1:stripe', secrets);
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain('sk_test');
    expect(openSecrets(key, 't1:stripe', sealed)).toEqual(secrets);
    // IV aléatoire : deux chiffrements diffèrent.
    expect(sealSecrets(key, 't1:stripe', secrets)).not.toBe(sealed);
  });

  it("refuse une autre clé, une autre université ou un chiffré altéré", () => {
    const sealed = sealSecrets(key, 't1:stripe', secrets);
    expect(() => openSecrets(randomBytes(32), 't1:stripe', sealed)).toThrow();
    expect(() => openSecrets(key, 't2:stripe', sealed)).toThrow();
    const parts = sealed.split('.');
    parts[3] = Buffer.from('x'.repeat(10)).toString('base64url');
    expect(() => openSecrets(key, 't1:stripe', parts.join('.'))).toThrow();
    expect(() => openSecrets(key, 't1:stripe', 'v0.a.b.c')).toThrow('Secrets illisibles');
  });
});

describe('Signature des webhooks', () => {
  const now = 1_800_000_000;
  const body = Buffer.from('{"id":"evt_1"}');
  const header = (secret = 's3cret', t = now) => `t=${t},v1=${signPayload(secret, t, body)}`;

  it('accepte une signature valide, y compris parmi plusieurs', () => {
    expect(() => verifyTimestampedSignature(header(), 's3cret', body, now)).not.toThrow();
    expect(() => verifyTimestampedSignature(`${header()},v1=00ff`, 's3cret', body, now)).not.toThrow();
  });

  it('rejette absence, mauvais secret, corps modifié et horodatage hors fenêtre', () => {
    expect(() => verifyTimestampedSignature(undefined, 's3cret', body, now)).toThrow(InvalidSignatureError);
    expect(() => verifyTimestampedSignature('n_importe_quoi', 's3cret', body, now)).toThrow(InvalidSignatureError);
    expect(() => verifyTimestampedSignature(header('autre'), 's3cret', body, now)).toThrow('Signature invalide');
    expect(() => verifyTimestampedSignature(header(), 's3cret', Buffer.from('{"id":"evt_2"}'), now)).toThrow(
      'Signature invalide',
    );
    expect(() => verifyTimestampedSignature(header('s3cret', now - 301), 's3cret', body, now)).toThrow('Signature expirée');
  });
});

describe('Stripe', () => {
  const stripe = new StripeProvider(async () => new Response('{}'));
  const secrets = { secretKey: 'sk_test_x', webhookSecret: 'whsec_abc' };
  const event = (type: string, object: Record<string, unknown>) => {
    const raw = Buffer.from(JSON.stringify({ id: 'evt_1', type, data: { object } }));
    const t = Math.floor(Date.now() / 1000);
    return stripe.parseWebhook(secrets, raw, { 'stripe-signature': `t=${t},v1=${signPayload(secrets.webhookSecret, t, raw)}` });
  };
  const paymentId = '6f1c1b8e-6a51-4b5e-9d1a-3f6b8c2d1e0f';

  it('traduit les événements Checkout', () => {
    const session = { id: 'cs_1', client_reference_id: paymentId, amount_total: 1000, currency: 'usd' };
    expect(event('checkout.session.completed', { ...session, payment_status: 'paid' })).toMatchObject({
      outcome: 'succeeded',
      providerRef: 'cs_1',
      paymentId,
      amountMinor: 1000,
      currency: 'USD',
    });
    expect(event('checkout.session.completed', { ...session, payment_status: 'unpaid' }).outcome).toBe('ignored');
    expect(event('checkout.session.async_payment_succeeded', session).outcome).toBe('succeeded');
    expect(event('checkout.session.expired', session)).toMatchObject({ outcome: 'failed', failureReason: 'Session de paiement expirée' });
    expect(event('customer.created', {}).outcome).toBe('ignored');
    expect(event('checkout.session.completed', { ...session, client_reference_id: 'pas-un-uuid' }).paymentId).toBeUndefined();
  });

  it('valide le format des secrets saisis', () => {
    expect(() => stripe.prepareSecrets({ secretKey: 'pk_test_abcdefghijkl', webhookSecret: 'whsec_abcdefghijkl' })).toThrow();
    expect(() => stripe.prepareSecrets({ secretKey: 'sk_test_abcdefghijkl', webhookSecret: 'abc' })).toThrow();
    expect(stripe.prepareSecrets({ secretKey: 'sk_test_abcdefghijkl', webhookSecret: 'whsec_abcdefghijkl', x: 1 })).toEqual({
      secretKey: 'sk_test_abcdefghijkl',
      webhookSecret: 'whsec_abcdefghijkl',
    });
  });
});

describe('Configuration des paiements', () => {
  const base = {
    DATABASE_URL: 'postgres://a@b/c',
    PLATFORM_DATABASE_URL: 'postgres://a@b/c',
    KEYCLOAK_URL: 'https://auth.example',
    BASE_DOMAIN: 'example.test',
  };

  it('refuse une clé de chiffrement qui ne fait pas 32 octets', () => {
    expect(() => loadEnv({ ...base, PAYMENT_SECRETS_KEY: randomBytes(16).toString('base64') })).toThrow();
    expect(() => loadEnv({ ...base, PAYMENT_SECRETS_KEY: randomBytes(32).toString('base64') })).not.toThrow();
  });

  it('interdit le Mobile Money simulé en production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', PAYMENTS_SANDBOX: 'true' })).toThrow();
  });
});
