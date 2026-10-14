import {
  BadRequestException,
  Body,
  ConflictException,
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
  Res,
  UnprocessableEntityException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { DatabaseError } from 'pg';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { DatabaseService } from '../db/database.service';
import { CurrentTenant } from '../tenancy/current-tenant.decorator';
import { Tenant } from '../tenancy/tenant';
import { CURRENCIES, toMinor } from './money';
import { PAYMENT_COLUMNS, PaymentsService } from './payments.service';
import { detectSlipType, isPlausibleDepositDate, SLIP_EXTENSIONS, SLIP_MAX_BYTES, SlipType } from './slip-file';

const bankAccountSchema = z.object({
  bankName: z.string().trim().min(2).max(100),
  accountName: z.string().trim().min(2).max(200),
  accountNumber: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9 -]{3,63}$/, 'Numéro de compte invalide'),
  currency: z.enum(CURRENCIES),
});

const declarationSchema = z.object({
  bankAccountId: z.uuid(),
  reference: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9/._-]{2,63}$/, 'Numéro de bordereau invalide'),
  paidOn: z.iso.date(),
  // Champ de formulaire multipart : texte, « 250 » ou « 250.50 ».
  amount: z.coerce.number().positive().max(100_000_000),
});

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

const ACCOUNT_COLUMNS = `id, bank_name AS "bankName", account_name AS "accountName", account_number AS "accountNumber",
  currency, enabled`;

/** Fichier reçu par multer (stockage en mémoire). */
interface UploadedSlip {
  buffer: Buffer;
  size: number;
}

/** Comptes bancaires de l'université (où les étudiants déposent les frais). */
@Controller('v1/bank-accounts')
export class BankAccountsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('finance:read')
  list(@CurrentTenant() tenant: Tenant) {
    return this.db.withTenant(tenant.id, async (tx) =>
      (await tx.query(`SELECT ${ACCOUNT_COLUMNS} FROM bank_accounts ORDER BY currency, bank_name`)).rows,
    );
  }

  @Post()
  @RequirePermission('tenant:config:write')
  create(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodPipe(bankAccountSchema)) body: z.infer<typeof bankAccountSchema>,
    @Req() req: Request,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const account = (
        await tx.query<{ id: string }>(
          `INSERT INTO bank_accounts (tenant_id, bank_name, account_name, account_number, currency)
           VALUES ($1, $2, $3, $4, $5) RETURNING ${ACCOUNT_COLUMNS}`,
          [tenant.id, body.bankName, body.accountName, body.accountNumber.toUpperCase(), body.currency],
        )
      ).rows[0];
      await this.audit.record(tx, tenant.id, {
        actorUserId: user.id,
        action: 'bank_account.created',
        entityType: 'bank_account',
        entityId: account.id,
        after: account,
        ip: req.ip,
      });
      return account;
    });
  }

  @Put(':accountId')
  @RequirePermission('tenant:config:write')
  update(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body(new ZodPipe(z.object({ enabled: z.boolean() }))) body: { enabled: boolean },
    @Req() req: Request,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const account = (
        await tx.query(`UPDATE bank_accounts SET enabled = $2 WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`, [
          accountId,
          body.enabled,
        ])
      ).rows[0];
      if (!account) throw new NotFoundException('Compte introuvable');
      await this.audit.record(tx, tenant.id, {
        actorUserId: user.id,
        action: body.enabled ? 'bank_account.enabled' : 'bank_account.disabled',
        entityType: 'bank_account',
        entityId: accountId,
        after: { enabled: body.enabled },
        ip: req.ip,
      });
      return account;
    });
  }
}

/** L'étudiant déclare un dépôt bancaire en téléversant son bordereau. */
@Controller('v1/me')
export class MyBankPaymentsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  @Get('bank-accounts')
  @RequirePermission('self:payments:write')
  accounts(@CurrentTenant() tenant: Tenant) {
    return this.db.withTenant(tenant.id, async (tx) =>
      (
        await tx.query(
          `SELECT id, bank_name AS "bankName", account_name AS "accountName", account_number AS "accountNumber", currency
             FROM bank_accounts WHERE enabled ORDER BY currency, bank_name`,
        )
      ).rows,
    );
  }

  @Post('invoices/:invoiceId/bank-payments')
  @RequirePermission('self:payments:write')
  @UseInterceptors(FileInterceptor('slip', { limits: { fileSize: SLIP_MAX_BYTES, files: 1, fields: 10 } }))
  async declare(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodPipe(declarationSchema)) body: z.infer<typeof declarationSchema>,
    @UploadedFile() file: UploadedSlip | undefined,
    @Req() req: Request,
  ) {
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new BadRequestException('En-tête Idempotency-Key requis (8 à 128 caractères)');
    }
    if (!file?.size) throw new BadRequestException('Joignez la photo ou le PDF du bordereau');
    const fileType = detectSlipType(file.buffer);
    if (!fileType) throw new UnprocessableEntityException('Bordereau illisible : PDF, JPEG ou PNG uniquement');
    if (!isPlausibleDepositDate(body.paidOn)) throw new UnprocessableEntityException('Date de dépôt invalide');
    const amountMinor = toMinor(body.amount);
    if (amountMinor === null) throw new BadRequestException('Montant invalide (deux décimales au plus)');
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const reference = body.reference.toUpperCase();

    try {
      return await this.db.withTenant(tenant.id, async (tx) => {
        const invoice = (
          await tx.query<{ status: string; amount_minor: string; currency: string }>(
            `SELECT status, amount_minor, currency FROM invoices WHERE id = $1 AND student_user_id = $2 FOR UPDATE`,
            [invoiceId, user.id],
          )
        ).rows[0];
        if (!invoice) throw new NotFoundException('Facture introuvable');

        const replay = (
          await tx.query<{ invoiceId: string }>(`SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.idempotency_key = $1`, [
            idempotencyKey,
          ])
        ).rows[0];
        if (replay) {
          if (replay.invoiceId !== invoiceId) throw new ConflictException("Clé d'idempotence déjà utilisée pour une autre facture");
          return { ...replay, replayed: true };
        }
        if (invoice.status !== 'open') throw new ConflictException('Facture déjà réglée ou annulée');

        const account = (
          await tx.query<{ currency: string }>('SELECT currency FROM bank_accounts WHERE id = $1 AND enabled', [
            body.bankAccountId,
          ])
        ).rows[0];
        if (!account) throw new NotFoundException('Compte bancaire introuvable');
        if (account.currency !== invoice.currency) {
          throw new UnprocessableEntityException(`Ce compte est en ${account.currency}, la facture en ${invoice.currency}`);
        }

        const pending = await tx.query(
          `SELECT 1 FROM payments WHERE invoice_id = $1 AND status = 'pending'
              AND (provider = 'bank' OR created_at > now() - interval '30 minutes')`,
          [invoiceId],
        );
        if (pending.rowCount) throw new ConflictException('Un paiement est déjà en attente pour cette facture');

        const paid = await tx.query<{ total: string }>(
          `SELECT COALESCE(sum(amount_minor), 0) AS total FROM payments WHERE invoice_id = $1 AND status = 'succeeded'`,
          [invoiceId],
        );
        const balance = Number(invoice.amount_minor) - Number(paid.rows[0].total);
        if (amountMinor > balance) throw new UnprocessableEntityException('Montant supérieur au reste à payer');

        const payment = (
          await tx.query<{ id: string }>(
            `INSERT INTO payments AS p (tenant_id, invoice_id, student_user_id, provider, amount_minor, currency, idempotency_key)
             VALUES ($1, $2, $3, 'bank', $4, $5, $6) RETURNING ${PAYMENT_COLUMNS}`,
            [tenant.id, invoiceId, user.id, amountMinor, invoice.currency, idempotencyKey],
          )
        ).rows[0];
        await tx.query(
          `INSERT INTO bank_slips (payment_id, tenant_id, bank_account_id, reference, paid_on, file, file_type, file_size, file_sha256)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [payment.id, tenant.id, body.bankAccountId, reference, body.paidOn, file.buffer, fileType, file.size, sha256],
        );
        await this.audit.record(tx, tenant.id, {
          actorUserId: user.id,
          action: 'bank_payment.declared',
          entityType: 'payment',
          entityId: payment.id,
          after: { invoiceId, bankAccountId: body.bankAccountId, reference, paidOn: body.paidOn, amountMinor, fileSha256: sha256 },
          ip: req.ip,
        });
        return { ...payment, replayed: false };
      });
    } catch (err) {
      // Bordereau déjà utilisé : même numéro sur ce compte, ou même fichier.
      if (err instanceof DatabaseError && err.code === '23505') {
        if (err.constraint === 'bank_slips_reference_key') throw new ConflictException('Ce bordereau a déjà été soumis');
        if (err.constraint === 'bank_slips_file_key') throw new ConflictException('Ce fichier de bordereau a déjà été soumis');
      }
      throw err;
    }
  }
}

/** Le service financier contrôle les bordereaux et les valide ou les refuse. */
@Controller('v1/bank-payments')
export class BankPaymentsReviewController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
  ) {}

  @Get()
  @RequirePermission('payments:validate')
  list(@CurrentTenant() tenant: Tenant, @Query('status') status = 'pending') {
    const filter = { pending: 's.decision IS NULL', accepted: "s.decision = 'accepted'", rejected: "s.decision = 'rejected'" }[
      status
    ];
    if (!filter) throw new BadRequestException('Statut invalide');
    return this.db.withTenant(tenant.id, async (tx) => {
      return (
        await tx.query(
          `SELECT p.id, p.amount_minor::int AS "amountMinor", p.currency, p.status, p.failure_reason AS "failureReason",
                  s.reference, to_char(s.paid_on, 'YYYY-MM-DD') AS "paidOn", s.file_type AS "fileType", s.decision,
                  s.created_at AS "submittedAt", s.reviewed_at AS "reviewedAt",
                  a.bank_name AS "bankName", a.account_number AS "accountNumber",
                  u.full_name AS "studentName", u.email AS "studentEmail", f.name AS "feeName",
                  i.amount_minor::int AS "invoiceAmountMinor", r.full_name AS "reviewerName"
             FROM bank_slips s
             JOIN payments p ON p.id = s.payment_id
             JOIN bank_accounts a ON a.id = s.bank_account_id
             JOIN users u ON u.id = p.student_user_id
             JOIN invoices i ON i.id = p.invoice_id
             JOIN fee_structures f ON f.id = i.fee_structure_id
             LEFT JOIN users r ON r.id = s.reviewed_by
            WHERE ${filter}
            ORDER BY s.created_at ${status === 'pending' ? 'ASC' : 'DESC'}
            LIMIT 200`,
        )
      ).rows;
    });
  }

  /** Le bordereau tel que téléversé, pour contrôle visuel. */
  @Get(':paymentId/slip')
  @RequirePermission('payments:validate')
  async slip(
    @CurrentTenant() tenant: Tenant,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Res() res: Response,
  ) {
    const slip = await this.db.withTenant(tenant.id, async (tx) => {
      return (
        await tx.query<{ file: Buffer; file_type: SlipType; reference: string }>(
          'SELECT file, file_type, reference FROM bank_slips WHERE payment_id = $1',
          [paymentId],
        )
      ).rows[0];
    });
    if (!slip) throw new NotFoundException('Bordereau introuvable');
    res.set({
      'content-type': slip.file_type,
      'content-disposition': `inline; filename="bordereau-${slip.reference.replace(/[^A-Za-z0-9_-]/g, '_')}.${SLIP_EXTENSIONS[slip.file_type]}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    });
    res.send(slip.file);
  }

  @Post(':paymentId/accept')
  @HttpCode(200)
  @RequirePermission('payments:validate')
  accept(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Req() req: Request,
  ) {
    return this.decide(tenant, user, paymentId, 'accepted', null, req.ip);
  }

  @Post(':paymentId/reject')
  @HttpCode(200)
  @RequirePermission('payments:validate')
  reject(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body(new ZodPipe(z.object({ reason: z.string().trim().min(3).max(500) }))) body: { reason: string },
    @Req() req: Request,
  ) {
    return this.decide(tenant, user, paymentId, 'rejected', body.reason, req.ip);
  }

  private decide(
    tenant: Tenant,
    user: AuthenticatedUser,
    paymentId: string,
    decision: 'accepted' | 'rejected',
    reason: string | null,
    ip: string | undefined,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const row = (
        await tx.query<{ decision: string | null; status: string; student_user_id: string; invoice_id: string; amount_minor: string; reference: string }>(
          `SELECT s.decision, p.status, p.student_user_id, p.invoice_id, p.amount_minor, s.reference
             FROM bank_slips s JOIN payments p ON p.id = s.payment_id
            WHERE s.payment_id = $1
            FOR UPDATE OF s, p`,
          [paymentId],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Bordereau introuvable');
      if (row.decision !== null || row.status !== 'pending') throw new ConflictException('Bordereau déjà traité');
      // Personne ne valide son propre paiement.
      if (row.student_user_id === user.id) throw new ForbiddenException('Vous ne pouvez pas traiter votre propre bordereau');

      await tx.query(`UPDATE bank_slips SET decision = $2, reviewed_by = $3, reviewed_at = now() WHERE payment_id = $1`, [
        paymentId,
        decision,
        user.id,
      ]);
      if (decision === 'accepted') {
        await tx.query(`UPDATE payments SET status = 'succeeded', completed_at = now() WHERE id = $1`, [paymentId]);
        await this.payments.settleInvoice(tx, row.invoice_id);
      } else {
        await tx.query(`UPDATE payments SET status = 'failed', failure_reason = $2, completed_at = now() WHERE id = $1`, [
          paymentId,
          reason,
        ]);
      }
      await this.audit.record(tx, tenant.id, {
        actorUserId: user.id,
        action: decision === 'accepted' ? 'bank_payment.accepted' : 'bank_payment.rejected',
        entityType: 'payment',
        entityId: paymentId,
        after: { reference: row.reference, amountMinor: Number(row.amount_minor), ...(reason ? { reason } : {}) },
        ip,
      });
      const invoice = (await tx.query<{ status: string }>('SELECT status FROM invoices WHERE id = $1', [row.invoice_id]))
        .rows[0];
      return { decision, invoiceStatus: invoice.status };
    });
  }
}
