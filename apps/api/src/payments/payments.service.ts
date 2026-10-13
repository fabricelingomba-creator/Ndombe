import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ENV, Env, sandboxPaymentsEnabled } from '../config/env';
import { DatabaseService, Tx } from '../db/database.service';
import { Tenant } from '../tenancy/tenant';
import type { Currency } from './money';
import { PAYMENT_FETCH, PaymentFetch, PaymentProvider, ProviderEvent, ProviderKey } from './providers/provider';
import { SandboxProvider } from './providers/sandbox.provider';
import { StripeProvider } from './providers/stripe.provider';
import { openSecrets, sealSecrets } from './secret-box';

/** Un paiement en attente plus récent que ce délai bloque un nouvel essai (anti double paiement). */
export const PENDING_LOCK_MINUTES = 30;

export const PAYMENT_COLUMNS = `p.id, p.invoice_id AS "invoiceId", p.provider, p.amount_minor::int AS "amountMinor",
  p.currency, p.status, p.redirect_url AS "redirectUrl", p.failure_reason AS "failureReason",
  p.created_at AS "createdAt", p.completed_at AS "completedAt"`;

interface PaymentRow {
  id: string;
  invoiceId: string;
  provider: ProviderKey;
  amountMinor: number;
  currency: Currency;
  status: 'pending' | 'succeeded' | 'failed';
  redirectUrl: string | null;
  failureReason: string | null;
}

export type WebhookOutcome = 'applied' | 'duplicate' | 'ignored' | 'unknown_payment' | 'already_final' | 'amount_mismatch';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly providers: Map<ProviderKey, PaymentProvider>;
  private readonly key: Buffer | null;

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
    @Inject(PAYMENT_FETCH) fetch: PaymentFetch,
  ) {
    this.key = env.PAYMENT_SECRETS_KEY ? Buffer.from(env.PAYMENT_SECRETS_KEY, 'base64') : null;
    const all: PaymentProvider[] = [new StripeProvider(fetch)];
    if (sandboxPaymentsEnabled(env)) all.push(new SandboxProvider());
    this.providers = new Map(all.map((p) => [p.key, p]));
  }

  provider(key: string): PaymentProvider {
    const provider = this.providers.get(key as ProviderKey);
    if (!provider) throw new NotFoundException('Prestataire de paiement inconnu');
    return provider;
  }

  private secretKey(): Buffer {
    if (!this.key) throw new ServiceUnavailableException('Paiements non configurés sur cette plateforme');
    return this.key;
  }

  private context(tenantId: string, provider: ProviderKey) {
    return `${tenantId}:${provider}`;
  }

  /** Enregistre (chiffrés) les secrets d'un prestataire pour une université. */
  async configureProvider(tx: Tx, tenantId: string, key: ProviderKey, input: Record<string, unknown>, enabled: boolean) {
    const provider = this.provider(key);
    const secrets = provider.prepareSecrets(input);
    const sealed = sealSecrets(this.secretKey(), this.context(tenantId, key), secrets);
    await tx.query(
      `INSERT INTO tenant_payment_providers (tenant_id, provider, enabled, secrets_ciphertext) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, provider) DO UPDATE
         SET enabled = EXCLUDED.enabled, secrets_ciphertext = EXCLUDED.secrets_ciphertext, updated_at = now()`,
      [tenantId, key, enabled, sealed],
    );
    return secrets;
  }

  async enabledProviders(tx: Tx): Promise<PaymentProvider[]> {
    const rows = await tx.query<{ provider: ProviderKey }>(
      'SELECT provider FROM tenant_payment_providers WHERE enabled ORDER BY provider',
    );
    return rows.rows.map((r) => this.providers.get(r.provider)).filter((p): p is PaymentProvider => !!p);
  }

  private async secretsFor(tx: Tx, tenantId: string, key: ProviderKey): Promise<Record<string, string>> {
    const row = (
      await tx.query<{ secrets_ciphertext: string }>(
        'SELECT secrets_ciphertext FROM tenant_payment_providers WHERE provider = $1 AND enabled',
        [key],
      )
    ).rows[0];
    if (!row) throw new NotFoundException('Prestataire non activé pour cette université');
    return openSecrets(this.secretKey(), this.context(tenantId, key), row.secrets_ciphertext);
  }

  /** Secrets du sandbox (simulation de confirmation, hors production). */
  sandboxSecrets(tenantId: string, ciphertext: string): Record<string, string> {
    return openSecrets(this.secretKey(), this.context(tenantId, 'sandbox'), ciphertext);
  }

  /**
   * Lance le paiement d'une facture par l'étudiant. Rejouer la même clé
   * d'idempotence renvoie le même paiement au lieu d'en créer un second.
   */
  async startPayment(
    tenant: Tenant,
    studentId: string,
    invoiceId: string,
    input: { provider: ProviderKey; phone?: string; idempotencyKey: string; returnUrl: string },
  ): Promise<PaymentRow & { instructions?: string; replayed: boolean }> {
    const provider = this.provider(input.provider);
    if (provider.requiresPhone && !input.phone) throw new UnprocessableEntityException('Numéro Mobile Money requis');

    type Prepared = { replay: PaymentRow } | { payment: PaymentRow; description: string };
    const prepared = await this.db.withTenant<Prepared>(tenant.id, async (tx) => {
      const invoice = (
        await tx.query<{ id: string; status: string; amount_minor: string; currency: Currency; fee_name: string }>(
          `SELECT i.id, i.status, i.amount_minor, i.currency, f.name AS fee_name
             FROM invoices i JOIN fee_structures f ON f.id = i.fee_structure_id
            WHERE i.id = $1 AND i.student_user_id = $2
            FOR UPDATE OF i`,
          [invoiceId, studentId],
        )
      ).rows[0];
      if (!invoice) throw new NotFoundException('Facture introuvable');

      const replay = (
        await tx.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.idempotency_key = $1`, [
          input.idempotencyKey,
        ])
      ).rows[0];
      if (replay) {
        if (replay.invoiceId !== invoiceId) throw new ConflictException("Clé d'idempotence déjà utilisée pour une autre facture");
        return { replay };
      }

      if (invoice.status !== 'open') throw new ConflictException('Facture déjà réglée ou annulée');
      const pending = await tx.query(
        `SELECT 1 FROM payments WHERE invoice_id = $1 AND status = 'pending'
            AND created_at > now() - make_interval(mins => $2)`,
        [invoiceId, PENDING_LOCK_MINUTES],
      );
      if (pending.rowCount) throw new ConflictException('Un paiement est déjà en cours pour cette facture');
      await this.secretsFor(tx, tenant.id, provider.key); // prestataire bien activé

      const paid = await tx.query<{ total: string }>(
        `SELECT COALESCE(sum(amount_minor), 0) AS total FROM payments WHERE invoice_id = $1 AND status = 'succeeded'`,
        [invoiceId],
      );
      const balance = Number(invoice.amount_minor) - Number(paid.rows[0].total);
      const payment = (
        await tx.query<PaymentRow>(
          `INSERT INTO payments AS p (tenant_id, invoice_id, student_user_id, provider, amount_minor, currency, idempotency_key, phone)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${PAYMENT_COLUMNS}`,
          [tenant.id, invoiceId, studentId, provider.key, balance, invoice.currency, input.idempotencyKey, input.phone ?? null],
        )
      ).rows[0];
      await this.audit.record(tx, tenant.id, {
        actorUserId: studentId,
        action: 'payment.started',
        entityType: 'payment',
        entityId: payment.id,
        after: { invoiceId, provider: provider.key, amountMinor: balance, currency: invoice.currency },
      });
      return { payment, description: invoice.fee_name };
    });

    if ('replay' in prepared) return { ...prepared.replay, replayed: true };
    const { payment, description } = prepared;

    // Appel au prestataire hors transaction : on ne garde pas de verrou pendant un appel réseau.
    try {
      const secrets = await this.db.withTenant(tenant.id, (tx) => this.secretsFor(tx, tenant.id, provider.key));
      const charge = await provider.createCharge(secrets, {
        paymentId: payment.id,
        tenantSlug: tenant.slug,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        description,
        phone: input.phone,
        returnUrl: input.returnUrl,
      });
      await this.db.withTenant(tenant.id, (tx) =>
        // Le webhook a pu conclure le paiement entre-temps : on ne touche qu'un paiement en attente.
        tx.query(`UPDATE payments SET provider_ref = $2, redirect_url = $3 WHERE id = $1 AND status = 'pending'`, [
          payment.id,
          charge.providerRef,
          charge.redirectUrl ?? null,
        ]),
      );
      return { ...payment, redirectUrl: charge.redirectUrl ?? null, instructions: charge.instructions, replayed: false };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Erreur du prestataire';
      await this.db.withTenant(tenant.id, (tx) =>
        tx.query(
          `UPDATE payments SET status = 'failed', failure_reason = $2, completed_at = now() WHERE id = $1 AND status = 'pending'`,
          [payment.id, reason.slice(0, 500)],
        ),
      );
      if (err instanceof BadGatewayException) throw err;
      throw new BadGatewayException('Le prestataire de paiement est indisponible');
    }
  }

  /** Vérifie puis traite une notification de prestataire. Rejouée, elle ne change rien. */
  async handleWebhook(
    tenant: Tenant,
    key: string,
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): Promise<WebhookOutcome> {
    const provider = this.provider(key);
    return this.db.withTenant(tenant.id, async (tx) => {
      const secrets = await this.secretsFor(tx, tenant.id, provider.key);
      const event = provider.parseWebhook(secrets, rawBody, headers);
      return this.applyEvent(tx, tenant.id, provider.key, event, JSON.parse(rawBody.toString('utf8')));
    });
  }

  async applyEvent(tx: Tx, tenantId: string, key: ProviderKey, event: ProviderEvent, payload: unknown): Promise<WebhookOutcome> {
    const seen = await tx.query('SELECT 1 FROM payment_events WHERE provider = $1 AND event_id = $2', [key, event.eventId]);
    if (seen.rowCount) return 'duplicate';

    // Par référence du prestataire, ou par identifiant Elongo si le webhook précède l'enregistrement de la référence.
    const payment =
      event.providerRef || event.paymentId
        ? (
            await tx.query<PaymentRow>(
              `SELECT ${PAYMENT_COLUMNS} FROM payments p
                WHERE p.provider = $1
                  AND (p.provider_ref = $2 OR (p.id = $3::uuid AND (p.provider_ref IS NULL OR p.provider_ref = $2)))
                LIMIT 1 FOR UPDATE`,
              [key, event.providerRef, event.paymentId ?? null],
            )
          ).rows[0]
        : undefined;

    let outcome: WebhookOutcome;
    if (event.outcome === 'ignored') outcome = 'ignored';
    else if (!payment) outcome = 'unknown_payment';
    else if (payment.status !== 'pending') outcome = 'already_final';
    else if (
      event.outcome === 'succeeded' &&
      (event.amountMinor !== payment.amountMinor || (event.currency && event.currency !== payment.currency))
    ) {
      outcome = 'amount_mismatch';
    } else {
      outcome = 'applied';
    }

    await tx.query(
      `INSERT INTO payment_events (tenant_id, provider, event_id, event_type, payment_id, outcome, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (tenant_id, provider, event_id) DO NOTHING`,
      [tenantId, key, event.eventId, event.type, payment?.id ?? null, outcome, payload],
    );
    if (outcome === 'amount_mismatch') {
      this.logger.warn(`Montant incohérent pour le paiement ${payment!.id} (événement ${event.eventId})`);
    }
    if (outcome !== 'applied' || !payment) return outcome;

    if (event.outcome === 'failed') {
      await tx.query(
        `UPDATE payments SET status = 'failed', failure_reason = $2, completed_at = now(),
                provider_ref = COALESCE(provider_ref, $3) WHERE id = $1`,
        [payment.id, event.failureReason ?? 'Paiement refusé', event.providerRef],
      );
    } else {
      await tx.query(
        `UPDATE payments SET status = 'succeeded', completed_at = now(), provider_ref = COALESCE(provider_ref, $2) WHERE id = $1`,
        [payment.id, event.providerRef],
      );
      await this.settleInvoice(tx, payment.invoiceId);
    }
    await this.audit.record(tx, tenantId, {
      actorUserId: null,
      action: event.outcome === 'failed' ? 'payment.failed' : 'payment.succeeded',
      entityType: 'payment',
      entityId: payment.id,
      after: { provider: key, eventId: event.eventId, amountMinor: payment.amountMinor, currency: payment.currency },
    });
    return outcome;
  }

  /** La facture passe à « payée » quand les paiements aboutis couvrent son montant. */
  private async settleInvoice(tx: Tx, invoiceId: string) {
    await tx.query(
      `UPDATE invoices i SET status = 'paid', paid_at = now()
        WHERE i.id = $1 AND i.status = 'open'
          AND (SELECT COALESCE(sum(amount_minor), 0) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'succeeded')
              >= i.amount_minor`,
      [invoiceId],
    );
  }
}
