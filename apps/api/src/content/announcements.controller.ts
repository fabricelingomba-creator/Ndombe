import { Body, Controller, DefaultValuePipe, Get, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { DatabaseService } from '../db/database.service';
import { CurrentTenant } from '../tenancy/current-tenant.decorator';
import { Tenant } from '../tenancy/tenant';

const createAnnouncementSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
  visibility: z.enum(['public', 'campus']),
  publishedAt: z.coerce.date().optional(),
});

export const ANNOUNCEMENT_COLUMNS = `id, title, body, visibility, published_at AS "publishedAt"`;

@Controller('v1/announcements')
export class AnnouncementsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Fil des annonces publiées (publiques et campus) pour un utilisateur connecté. */
  @Get()
  @RequirePermission('announcements:read')
  list(@CurrentTenant() tenant: Tenant, @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number) {
    return this.db.withTenant(tenant.id, async (tx) => {
      return (
        await tx.query(
          `SELECT ${ANNOUNCEMENT_COLUMNS} FROM announcements
            WHERE deleted_at IS NULL AND published_at <= now()
            ORDER BY published_at DESC LIMIT $1`,
          [Math.min(Math.max(limit, 1), 100)],
        )
      ).rows;
    });
  }

  @Post()
  @RequirePermission('announcements:write')
  create(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodPipe(createAnnouncementSchema)) body: z.infer<typeof createAnnouncementSchema>,
    @Req() req: Request,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const announcement = (
        await tx.query(
          `INSERT INTO announcements (tenant_id, title, body, visibility, published_at, created_by)
           VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6) RETURNING ${ANNOUNCEMENT_COLUMNS}`,
          [tenant.id, body.title, body.body, body.visibility, body.publishedAt ?? null, user.id],
        )
      ).rows[0];
      await this.audit.record(tx, tenant.id, {
        actorUserId: user.id,
        action: 'announcement.created',
        entityType: 'announcement',
        entityId: announcement.id,
        after: announcement,
        ip: req.ip,
      });
      return announcement;
    });
  }
}
