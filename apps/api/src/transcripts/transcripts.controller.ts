import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { publishedGradesByTerm } from '../academic/published-grades';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser, Public, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { DatabaseService, Tx } from '../db/database.service';
import { messages } from '../notifications/catalog';
import { NotificationsService } from '../notifications/notifications.service';
import { CurrentTenant } from '../tenancy/current-tenant.decorator';
import { Tenant } from '../tenancy/tenant';
import { buildSnapshot, newVerificationCode, normalizeVerificationCode, snapshotHash, TranscriptSnapshot } from './transcript';
import { renderTranscriptPdf } from './transcript-pdf';

const rejectSchema = z.object({ reason: z.string().trim().min(3).max(2000) });

const LIST_COLUMNS = `t.id, t.status, t.requested_at AS "requestedAt", t.decided_at AS "decidedAt",
  t.reject_reason AS "rejectReason", t.verification_code AS "verificationCode"`;

async function sendPdf(
  tx: Tx,
  tenantId: string,
  row: { snapshot: TranscriptSnapshot; content_hash: string },
  res: Response,
): Promise<StreamableFile> {
  const branding = await tx.query<{ primary_color: string }>('SELECT primary_color FROM tenant_branding WHERE tenant_id = $1', [
    tenantId,
  ]);
  const pdf = await renderTranscriptPdf(row.snapshot, {
    primaryColor: branding.rows[0]?.primary_color ?? '#1D4ED8',
    contentHash: row.content_hash,
  });
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="releve-${row.snapshot.verificationCode}.pdf"`,
    'Cache-Control': 'private, no-store',
  });
  return new StreamableFile(pdf);
}

/** Relevés de l'étudiant connecté : demande, suivi et téléchargement. */
@Controller('v1/me/transcripts')
export class MyTranscriptsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get()
  @RequirePermission('self:transcripts:download')
  list(@CurrentTenant() tenant: Tenant, @CurrentUser() user: AuthenticatedUser) {
    return this.db.withTenant(tenant.id, async (tx) => {
      return (
        await tx.query(`SELECT ${LIST_COLUMNS} FROM transcripts t WHERE t.student_user_id = $1 ORDER BY t.requested_at DESC`, [
          user.id,
        ])
      ).rows;
    });
  }

  @Post()
  @RequirePermission('self:transcripts:download')
  request(@CurrentTenant() tenant: Tenant, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const published = await publishedGradesByTerm(tx, user.id);
      if (published.length === 0) throw new UnprocessableEntityException('Aucune note publiée : rien à certifier pour le moment');
      const pending = await tx.query("SELECT 1 FROM transcripts WHERE student_user_id = $1 AND status = 'requested'", [user.id]);
      if (pending.rowCount) throw new ConflictException('Une demande de relevé est déjà en cours');
      const transcript = (
        await tx.query(
          `INSERT INTO transcripts AS t (tenant_id, student_user_id) VALUES ($1, $2) RETURNING ${LIST_COLUMNS}`,
          [tenant.id, user.id],
        )
      ).rows[0];
      await this.audit.record(tx, tenant.id, {
        actorUserId: user.id,
        action: 'transcript.requested',
        entityType: 'transcript',
        entityId: transcript.id,
        ip: req.ip,
      });
      await this.notifications.notify(
        tx,
        tenant.id,
        await this.notifications.holders(tx, 'transcripts:validate', undefined, [user.id]),
        messages.transcriptRequested(user.fullName),
      );
      return transcript;
    });
  }

  @Get(':transcriptId/pdf')
  @RequirePermission('self:transcripts:download')
  pdf(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('transcriptId', ParseUUIDPipe) transcriptId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const row = (
        await tx.query<{ snapshot: TranscriptSnapshot; content_hash: string }>(
          `SELECT snapshot, content_hash FROM transcripts
            WHERE id = $1 AND student_user_id = $2 AND status = 'validated'`,
          [transcriptId, user.id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Relevé introuvable');
      return sendPdf(tx, tenant.id, row, res);
    });
  }
}

/** Traitement des demandes par le secrétariat académique. */
@Controller('v1/transcripts')
export class TranscriptsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get()
  @RequirePermission('transcripts:validate')
  list(@CurrentTenant() tenant: Tenant, @Query('status') status: string = 'requested') {
    if (!['requested', 'validated', 'rejected'].includes(status)) throw new UnprocessableEntityException('Statut invalide');
    return this.db.withTenant(tenant.id, async (tx) => {
      return (
        await tx.query(
          `SELECT ${LIST_COLUMNS}, u.id AS "studentId", u.full_name AS "studentName", u.email AS "studentEmail"
             FROM transcripts t JOIN users u ON u.id = t.student_user_id
            WHERE t.status = $1
            ORDER BY t.requested_at
            LIMIT 200`,
          [status],
        )
      ).rows;
    });
  }

  /** Fige les notes publiées à cet instant et émet le relevé officiel. */
  @Post(':transcriptId/validate')
  @HttpCode(200)
  @RequirePermission('transcripts:validate')
  validate(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('transcriptId', ParseUUIDPipe) transcriptId: string,
    @Req() req: Request,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const pending = await this.lockPending(tx, transcriptId);
      const student = (
        await tx.query<{ id: string; full_name: string; email: string }>('SELECT id, full_name, email FROM users WHERE id = $1', [
          pending.student_user_id,
        ])
      ).rows[0];
      const terms = await publishedGradesByTerm(tx, student.id);
      if (terms.length === 0) throw new UnprocessableEntityException('Aucune note publiée pour cet étudiant');
      const domain = await tx.query<{ domain: string }>(
        'SELECT domain FROM tenant_domains WHERE tenant_id = $1 ORDER BY is_primary DESC, created_at LIMIT 1',
        [tenant.id],
      );
      const code = newVerificationCode();
      const snapshot = buildSnapshot({
        university: { name: tenant.name, slug: tenant.slug },
        student: { id: student.id, fullName: student.full_name, email: student.email },
        terms,
        issuedAt: new Date(),
        verificationCode: code,
        verifyUrl: `https://${domain.rows[0]?.domain ?? tenant.slug}/verifier`,
      });
      const hash = snapshotHash(snapshot);
      await tx.query(
        `UPDATE transcripts SET status = 'validated', decided_by = $2, decided_at = $3, snapshot = $4,
                content_hash = $5, verification_code = $6
          WHERE id = $1`,
        [transcriptId, user.id, snapshot.issuedAt, snapshot, hash, code],
      );
      await this.audit.record(tx, tenant.id, {
        actorUserId: user.id,
        action: 'transcript.validated',
        entityType: 'transcript',
        entityId: transcriptId,
        after: { studentId: student.id, verificationCode: code, contentHash: hash },
        ip: req.ip,
      });
      await this.notifications.notify(tx, tenant.id, [student.id], messages.transcriptValidated());
      return { id: transcriptId, status: 'validated', verificationCode: code, contentHash: hash };
    });
  }

  @Post(':transcriptId/reject')
  @HttpCode(200)
  @RequirePermission('transcripts:validate')
  reject(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('transcriptId', ParseUUIDPipe) transcriptId: string,
    @Body(new ZodPipe(rejectSchema)) body: z.infer<typeof rejectSchema>,
    @Req() req: Request,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const pending = await this.lockPending(tx, transcriptId);
      await tx.query(
        `UPDATE transcripts SET status = 'rejected', decided_by = $2, decided_at = now(), reject_reason = $3 WHERE id = $1`,
        [transcriptId, user.id, body.reason],
      );
      await this.audit.record(tx, tenant.id, {
        actorUserId: user.id,
        action: 'transcript.rejected',
        entityType: 'transcript',
        entityId: transcriptId,
        after: { reason: body.reason },
        ip: req.ip,
      });
      await this.notifications.notify(tx, tenant.id, [pending.student_user_id], messages.transcriptRejected(body.reason));
      return { id: transcriptId, status: 'rejected' };
    });
  }

  @Get(':transcriptId/pdf')
  @RequirePermission('transcripts:validate')
  pdf(
    @CurrentTenant() tenant: Tenant,
    @Param('transcriptId', ParseUUIDPipe) transcriptId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const row = (
        await tx.query<{ snapshot: TranscriptSnapshot; content_hash: string }>(
          `SELECT snapshot, content_hash FROM transcripts WHERE id = $1 AND status = 'validated'`,
          [transcriptId],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Relevé introuvable');
      return sendPdf(tx, tenant.id, row, res);
    });
  }

  private async lockPending(tx: Tx, transcriptId: string) {
    const row = (
      await tx.query<{ status: string; student_user_id: string }>(
        'SELECT status, student_user_id FROM transcripts WHERE id = $1 FOR UPDATE',
        [transcriptId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException('Demande introuvable');
    if (row.status !== 'requested') throw new ConflictException(`Demande déjà traitée (${row.status})`);
    return row;
  }
}

/**
 * Vérification publique d'un relevé, par exemple par un employeur : le code
 * imprimé sur le document donne le nom, la date et l'empreinte attendue.
 */
@Controller('v1/public/transcripts')
export class TranscriptVerificationController {
  constructor(private readonly db: DatabaseService) {}

  @Public()
  @Get('verify/:code')
  async verify(@CurrentTenant() tenant: Tenant, @Param('code') raw: string) {
    const code = normalizeVerificationCode(raw);
    if (!code) throw new NotFoundException('Code inconnu');
    const row = (
      await this.db.query<{
        tenant_id: string;
        student_name: string;
        issued_at: Date;
        content_hash: string;
        credits_earned: string | null;
        cumulative_average: string | null;
      }>('SELECT * FROM app.verify_transcript($1)', [code])
    ).rows[0];
    // Un code d'une autre université ne se vérifie pas ici.
    if (!row || row.tenant_id !== tenant.id) throw new NotFoundException('Code inconnu');
    return {
      valid: true,
      university: tenant.name,
      verificationCode: code,
      studentName: row.student_name,
      issuedAt: row.issued_at,
      creditsEarned: row.credits_earned === null ? null : Number(row.credits_earned),
      average: row.cumulative_average === null ? null : Number(row.cumulative_average),
      contentHash: row.content_hash,
    };
  }
}
