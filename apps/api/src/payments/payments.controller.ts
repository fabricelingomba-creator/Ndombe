import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser, Public, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { DatabaseService } from '../db/database.service';
import { CurrentTenant } from '../tenancy/current-tenant.decorator';
import { Tenant } from '../tenancy/tenant';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
import { CURRENCIES, toMinor } from './money';
import { PAYMENT_COLUMNS, PaymentsService } from './payments.service';
import { InvalidSignatureError, PROVIDER_KEYS, ProviderKey } from './providers/provider';
import { SANDBOX_SIGNATURE_HEADER } from './providers/sandbox.provider';
import { signPayload } from './providers/signature';

const providerSettingsSchema = z.looseObject({ enabled: z.boolean().default(true) });

const feeStructureSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
  amount: z.number().positive().max(100_000_000),
  currency: z.enum(CURRENCIES),
  termId: z.uuid().optional(),
  dueOn: z.iso.date(),
});

const startPaymentSchema = z.object({
  provider: z.enum(PROVIDER_KEYS),
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9][0-9]{7,14}$/, 'Numéro au format international, par exemple +243812345678')
    .optional(),
  returnUrl: z.url({ protocol: /^https?$/ }),
});

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

const FEE_COLUMNS = `id, code, name, amount_minor::int AS "amountMinor", currency, term_id AS "termId",
  to_char(due_on, 'YYYY-MM-DD') AS "dueOn"`;

const INVOICE_COLUMNS = `i.id, f.code AS "feeCode", f.name AS "feeName", i.amount_minor::int AS "amountMinor", i.currency,
  i.status, to_char(i.due_on, 'YYYY-MM-DD') AS "dueOn", i.paid_at AS "paidAt",
  (SELECT COALESCE(sum(p.amount_minor), 0)::int FROM payments p WHERE p.invoice_id = i.id AND p.status = 'succeeded') AS "paidMinor"`;

/** Configuration des prestataires, frais et factures (administration). */
@Controller('v1')
export class PaymentsAdminController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
  ) {}

  @Get('payment-providers')
  @RequirePermission('tenant:config:write')
  providers(@CurrentTenant() tenant: Tenant) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const rows = await tx.query<{ provider: string; enabled: boolean; updated_at: Date }>(
        'SELECT provider, enabled, updated_at FROM tenant_payment_providers ORDER BY provider',
      );
      return rows.rows.map((r) => ({
        provider: r.provider,
        enabled: r.enabled,
        updatedAt: r.updated_at,
        webhookUrl: `/webhooks/payments/${r.provider}/${tenant.slug}`,
      }));
    });
  }

  /**
   * Active un prestataire et enregistre ses secrets (chiffrés). Pour le
   * sandbox, le secret de webhook est généré et renvoyé une seule fois.
   */
  @Put('payment-providers/:provider')
  @RequirePermission('tenant:config:write')
  configure(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('provider') key: string,
    @Body(new ZodPipe(providerSettingsSchema)) body: z.infer<typeof providerSettingsSchema>,
    @Req() req: Request,
  ) {
    const provider = this.payments.provider(key);
    return this.db.withTenant(tenant.id, async (tx) => {
      const { enabled, ...input } = body;
      const secrets = await this.payments.configureProvider(tx, tenant.id, provider.key, input, enabled);
      await this.audit.record(tx, tenant.id, {
        actorUserId: user.id,
        action: 'payment_provider.configured',
        entityType: 'payment_provider',
        entityId: provider.key,
        // Jamais les secrets dans l'audit.
        after: { enabled },
        ip: req.ip,
      });
      return {
        provider: provider.key,
        enabled,
        webhookUrl: `/webhooks/payments/${provider.key}/${tenant.slug}`,
        ...(provider.key === 'sandbox' ? { webhookSecret: secrets.webhookSecret } : {}),
      };
    });
  }

  @Get('fee-structures')
  @RequirePermission('finance:read')
  feeStructures(@CurrentTenant() tenant: Tenant) {
    return this.db.withTenant(tenant.id, async (tx) => {
      return (await tx.query(`SELECT ${FEE_COLUMNS} FROM fee_structures ORDER BY due_on DESC, code`)).rows;
    });
  }

  @Post('fee-structures')
  @RequirePermission('fees:structures:write')
  createFeeStructure(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodPipe(feeStructureSchema)) body: z.infer<typeof feeStructureSchema>,
    @Req() req: Request,
  ) {
    const amountMinor = toMinor(body.amount);
    if (amountMinor === null) throw new BadRequestException('Montant invalide (deux décimales au plus)');
    return this.db.withTenant(tenant.id, async (tx) => {
      const fee = (
        await tx.query(
          `INSERT INTO fee_structures (tenant_id, code, name, amount_minor, currency, term_id, due_on)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${FEE_COLUMNS}`,
          [tenant.id, body.code, body.name, amountMinor, body.currency, body.termId ?? null, body.dueOn],
        )
      ).rows[0];
      await this.audit.record(tx, tenant.id, {
        actorUserId: user.id,
        action: 'fee_structure.created',
        entityType: 'fee_structure',
        entityId: fee.id,
        after: fee,
        ip: req.ip,
      });
      return fee;
    });
  }

  /** Émet une facture pour chaque étudiant actif qui n'en a pas encore pour ce frais. */
  @Post('fee-structures/:feeId/invoices')
  @RequirePermission('fees:structures:write')
  issueInvoices(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('feeId', ParseUUIDPipe) feeId: string,
    @Req() req: Request,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const fee = await tx.query('SELECT 1 FROM fee_structures WHERE id = $1', [feeId]);
      if (!fee.rowCount) throw new NotFoundException('Frais introuvable');
      // Étudiant = compte actif détenant self:payments:write.
      const created = await tx.query(
        `INSERT INTO invoices (tenant_id, fee_structure_id, student_user_id, amount_minor, currency, due_on)
         SELECT f.tenant_id, f.id, u.id, f.amount_minor, f.currency, f.due_on
           FROM fee_structures f, users u
          WHERE f.id = $1 AND u.deleted_at IS NULL AND u.status <> 'disabled'
            AND EXISTS (SELECT 1 FROM role_assignments ra JOIN role_permissions rp ON rp.role_id = ra.role_id
                         WHERE ra.user_id = u.id AND rp.permission = 'self:payments:write')
         ON CONFLICT (fee_structure_id, student_user_id) DO NOTHING
         RETURNING id`,
        [feeId],
      );
      await this.audit.record(tx, tenant.id, {
        actorUserId: user.id,
        action: 'invoices.issued',
        entityType: 'fee_structure',
        entityId: feeId,
        after: { created: created.rowCount },
        ip: req.ip,
      });
      return { created: created.rowCount };
    });
  }

  @Get('invoices')
  @RequirePermission('finance:read')
  invoices(@CurrentTenant() tenant: Tenant, @Query('status') status?: string) {
    if (status && !['open', 'paid', 'cancelled'].includes(status)) throw new BadRequestException('Statut invalide');
    return this.db.withTenant(tenant.id, async (tx) => {
      return (
        await tx.query(
          `SELECT ${INVOICE_COLUMNS}, u.full_name AS "studentName", u.email AS "studentEmail"
             FROM invoices i
             JOIN fee_structures f ON f.id = i.fee_structure_id
             JOIN users u ON u.id = i.student_user_id
            WHERE ($1::text IS NULL OR i.status = $1)
            ORDER BY i.due_on, u.full_name
            LIMIT 500`,
          [status ?? null],
        )
      ).rows;
    });
  }
}

/** Factures et paiements de l'étudiant connecté. */
@Controller('v1/me')
export class MyPaymentsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly payments: PaymentsService,
    private readonly resolver: TenantResolverService,
  ) {}

  @Get('payment-options')
  @RequirePermission('self:payments:write')
  options(@CurrentTenant() tenant: Tenant) {
    return this.db.withTenant(tenant.id, async (tx) =>
      (await this.payments.enabledProviders(tx)).map((p) => ({ provider: p.key, label: p.label, requiresPhone: p.requiresPhone })),
    );
  }

  @Get('invoices')
  @RequirePermission('self:payments:write')
  invoices(@CurrentTenant() tenant: Tenant, @CurrentUser() user: AuthenticatedUser) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const invoices = (
        await tx.query<{ id: string }>(
          `SELECT ${INVOICE_COLUMNS}
             FROM invoices i JOIN fee_structures f ON f.id = i.fee_structure_id
            WHERE i.student_user_id = $1 AND i.status <> 'cancelled'
            ORDER BY i.status = 'paid', i.due_on`,
          [user.id],
        )
      ).rows;
      const payments = (
        await tx.query<{ invoiceId: string }>(
          `SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.student_user_id = $1 ORDER BY p.created_at DESC`,
          [user.id],
        )
      ).rows;
      return invoices.map((i) => ({ ...i, payments: payments.filter((p) => p.invoiceId === i.id) }));
    });
  }

  /**
   * Lance un paiement. L'en-tête Idempotency-Key est obligatoire : un double
   * clic ou une nouvelle tentative réseau renvoie le même paiement.
   */
  @Post('invoices/:invoiceId/payments')
  @RequirePermission('self:payments:write')
  async pay(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodPipe(startPaymentSchema)) body: z.infer<typeof startPaymentSchema>,
  ) {
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new BadRequestException("En-tête Idempotency-Key requis (8 à 128 caractères)");
    }
    // Le retour après paiement ne peut viser que le portail de cette université.
    const target = await this.resolver.resolveHost(new URL(body.returnUrl).host);
    if (target?.id !== tenant.id) throw new UnprocessableEntityException('Adresse de retour invalide');

    const { replayed, ...payment } = await this.payments.startPayment(tenant, user.id, invoiceId, {
      provider: body.provider,
      phone: body.phone,
      idempotencyKey,
      returnUrl: body.returnUrl,
    });
    return { ...payment, replayed };
  }

  @Get('payments/:paymentId')
  @RequirePermission('self:payments:write')
  payment(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const row = (
        await tx.query(`SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.id = $1 AND p.student_user_id = $2`, [
          paymentId,
          user.id,
        ])
      ).rows[0];
      if (!row) throw new NotFoundException('Paiement introuvable');
      return row;
    });
  }

  /**
   * Hors production : simule la réponse de l'étudiant sur son téléphone en
   * envoyant au webhook un événement signé, comme le ferait l'agrégateur.
   */
  @Post('payments/:paymentId/sandbox-confirm')
  @HttpCode(200)
  @RequirePermission('self:payments:write')
  async sandboxConfirm(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body(new ZodPipe(z.object({ outcome: z.enum(['succeeded', 'failed']) }))) body: { outcome: 'succeeded' | 'failed' },
  ) {
    const sandbox = this.payments.provider('sandbox');
    const { payment, secret } = await this.db.withTenant(tenant.id, async (tx) => {
      const payment = (
        await tx.query<{ provider_ref: string | null; amount_minor: string; currency: string; provider: string }>(
          'SELECT provider, provider_ref, amount_minor, currency FROM payments WHERE id = $1 AND student_user_id = $2',
          [paymentId, user.id],
        )
      ).rows[0];
      if (!payment) throw new NotFoundException('Paiement introuvable');
      if (payment.provider !== sandbox.key || !payment.provider_ref) throw new ForbiddenException('Paiement non simulable');
      const secret = await tx.query<{ secrets_ciphertext: string }>(
        "SELECT secrets_ciphertext FROM tenant_payment_providers WHERE provider = 'sandbox'",
      );
      return { payment, secret: secret.rows[0] };
    });
    if (!secret) throw new NotFoundException('Prestataire non activé pour cette université');
    const secrets = this.payments.sandboxSecrets(tenant.id, secret.secrets_ciphertext);
    const rawBody = Buffer.from(
      JSON.stringify({
        id: `sbx_evt_${paymentId}_${body.outcome}`,
        type: `payment.${body.outcome}`,
        data: {
          reference: payment.provider_ref,
          amount_minor: Number(payment.amount_minor),
          currency: payment.currency,
          ...(body.outcome === 'failed' ? { reason: 'Refusé sur le téléphone' } : {}),
        },
      }),
    );
    const t = Math.floor(Date.now() / 1000);
    const outcome = await this.payments.handleWebhook(tenant, sandbox.key, rawBody, {
      [SANDBOX_SIGNATURE_HEADER]: `t=${t},v1=${signPayload(secrets.webhookSecret, t, rawBody)}`,
    });
    return { outcome };
  }
}

/**
 * Notifications des prestataires. Publiques mais signées : l'université vient
 * de l'URL, le secret de vérification de sa configuration chiffrée.
 */
@Controller('webhooks/payments')
export class PaymentWebhooksController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly resolver: TenantResolverService,
  ) {}

  @Public()
  @Post(':provider/:tenantSlug')
  @HttpCode(200)
  async receive(@Param('provider') key: string, @Param('tenantSlug') slug: string, @Req() req: Request) {
    if (!(PROVIDER_KEYS as readonly string[]).includes(key) || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
      throw new NotFoundException();
    }
    const tenant = await this.resolver.resolveSlug(slug);
    if (!tenant) throw new NotFoundException();
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody?.length) throw new BadRequestException('Corps vide');
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(',') : v]),
    );
    try {
      return { received: true, outcome: await this.payments.handleWebhook(tenant, key as ProviderKey, rawBody, headers) };
    } catch (err) {
      if (err instanceof InvalidSignatureError) throw new BadRequestException('Signature invalide');
      throw err;
    }
  }
}
