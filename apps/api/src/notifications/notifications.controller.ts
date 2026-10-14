import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { DatabaseService, Tx } from '../db/database.service';
import { CurrentTenant } from '../tenancy/current-tenant.decorator';
import { Tenant } from '../tenancy/tenant';
import { CATEGORY_LABELS, NOTIFICATION_CATEGORIES, NotificationCategory } from './catalog';

const listQuerySchema = z.object({
  unread: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** Pagination : notifications plus anciennes que cette date. */
  before: z.iso.datetime({ offset: true }).optional(),
});

const preferencesSchema = z.object({
  email: z.partialRecord(z.enum(NOTIFICATION_CATEGORIES), z.boolean()),
});

const COLUMNS = `id, kind, category, title, body, link, created_at AS "createdAt", read_at AS "readAt"`;

/**
 * Boîte de réception de l'utilisateur connecté (web et mobile). Chacun ne voit
 * et ne modifie que ses propres notifications ; tout compte connecté y a accès.
 */
@Controller('v1/me')
export class MyNotificationsController {
  constructor(private readonly db: DatabaseService) {}

  @Get('notifications')
  list(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const items = await tx.query(
        `SELECT ${COLUMNS} FROM notifications
          WHERE user_id = $1 AND ($2::boolean IS NOT TRUE OR read_at IS NULL)
            AND ($3::timestamptz IS NULL OR created_at < $3)
          ORDER BY created_at DESC, id DESC LIMIT $4`,
        [user.id, query.unread === 'true', query.before ?? null, query.limit],
      );
      const unread = await tx.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
        [user.id],
      );
      return { items: items.rows, unreadCount: unread.rows[0].count };
    });
  }

  @Get('notifications/unread-count')
  unreadCount(@CurrentTenant() tenant: Tenant, @CurrentUser() user: AuthenticatedUser) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const res = await tx.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
        [user.id],
      );
      return { count: res.rows[0].count };
    });
  }

  @Post('notifications/:notificationId/read')
  @HttpCode(200)
  markRead(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const res = await tx.query(
        `UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`,
        [notificationId, user.id],
      );
      if (!res.rowCount) throw new NotFoundException('Notification introuvable');
      return res.rows[0];
    });
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  markAllRead(@CurrentTenant() tenant: Tenant, @CurrentUser() user: AuthenticatedUser) {
    return this.db.withTenant(tenant.id, async (tx) => {
      const res = await tx.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [user.id]);
      return { updated: res.rowCount };
    });
  }

  @Get('notification-preferences')
  preferences(@CurrentTenant() tenant: Tenant, @CurrentUser() user: AuthenticatedUser) {
    return this.db.withTenant(tenant.id, (tx) => this.loadPreferences(tx, user.id));
  }

  @Put('notification-preferences')
  updatePreferences(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodPipe(preferencesSchema)) body: z.infer<typeof preferencesSchema>,
  ) {
    return this.db.withTenant(tenant.id, async (tx) => {
      for (const [category, enabled] of Object.entries(body.email)) {
        await tx.query(
          `INSERT INTO notification_preferences (tenant_id, user_id, category, channel, enabled) VALUES ($1, $2, $3, 'email', $4)
           ON CONFLICT (tenant_id, user_id, category, channel) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
          [tenant.id, user.id, category, enabled],
        );
      }
      // Les e-mails déjà en file pour une catégorie désactivée ne partent plus.
      await tx.query(
        `UPDATE notification_deliveries d SET status = 'failed', last_error = 'Désactivé par l''utilisateur'
           FROM notifications n, notification_preferences p
          WHERE n.id = d.notification_id AND d.status = 'pending' AND n.user_id = $1
            AND p.user_id = n.user_id AND p.category = n.category AND p.channel = d.channel AND NOT p.enabled`,
        [user.id],
      );
      return this.loadPreferences(tx, user.id);
    });
  }

  private async loadPreferences(tx: Tx, userId: string) {
    const rows = await tx.query<{ category: NotificationCategory; enabled: boolean }>(
      `SELECT category, enabled FROM notification_preferences WHERE user_id = $1 AND channel = 'email'`,
      [userId],
    );
    const disabled = new Set(rows.rows.filter((r) => !r.enabled).map((r) => r.category));
    return NOTIFICATION_CATEGORIES.map((category) => ({
      category,
      label: CATEGORY_LABELS[category],
      email: !disabled.has(category),
    }));
  }
}
