import { Inject, Injectable } from '@nestjs/common';
import { ENV, Env, emailTransport } from '../config/env';
import type { Tx } from '../db/database.service';
import { RbacService } from '../rbac/rbac.service';
import { Scope, UNIVERSITY_SCOPE } from '../rbac/scope';
import type { NotificationMessage } from './catalog';

/**
 * Point d'entrée unique pour notifier. À appeler dans la transaction de
 * l'événement : la notification n'existe que si l'action est enregistrée, et
 * l'e-mail part ensuite, hors transaction, via la file notification_deliveries.
 */
@Injectable()
export class NotificationsService {
  private readonly emailEnabled: boolean;

  constructor(
    @Inject(ENV) env: Env,
    private readonly rbac: RbacService,
  ) {
    this.emailEnabled = emailTransport(env) !== 'none';
  }

  /** Crée la notification pour chaque destinataire (sauf doublon de dedupKey) ; renvoie le nombre créé. */
  async notify(tx: Tx, tenantId: string, userIds: readonly string[], message: NotificationMessage): Promise<number> {
    const recipients = [...new Set(userIds)];
    if (recipients.length === 0) return 0;
    const created = await tx.query<{ id: string }>(
      `INSERT INTO notifications (tenant_id, user_id, kind, category, title, body, link, dedup_key)
       SELECT $1, u.id, $3, $4, $5, $6, $7, $8
         FROM users u
        WHERE u.id = ANY($2::uuid[]) AND u.deleted_at IS NULL AND u.status <> 'disabled'
       ON CONFLICT (tenant_id, user_id, dedup_key) DO NOTHING
       RETURNING id`,
      [tenantId, recipients, message.kind, message.category, message.title, message.body, message.link, message.dedupKey ?? null],
    );
    if (created.rowCount && this.emailEnabled) {
      await tx.query(
        `INSERT INTO notification_deliveries (tenant_id, notification_id, channel, recipient)
         SELECT n.tenant_id, n.id, 'email', u.email
           FROM notifications n JOIN users u ON u.id = n.user_id
          WHERE n.id = ANY($1::uuid[])
            AND NOT EXISTS (SELECT 1 FROM notification_preferences p
                             WHERE p.user_id = n.user_id AND p.category = n.category AND p.channel = 'email' AND NOT p.enabled)`,
        [created.rows.map((r) => r.id)],
      );
    }
    return created.rowCount ?? 0;
  }

  /**
   * Utilisateurs actifs détenant une permission sur la portée visée (ou l'une
   * de ses portées parentes). Par défaut : sur toute l'université.
   */
  async holders(tx: Tx, permission: string, target: Scope = UNIVERSITY_SCOPE, exclude: string[] = []): Promise<string[]> {
    const chain = await this.rbac.scopeChain(tx, target);
    const rows = await tx.query<{ user_id: string }>(
      `SELECT DISTINCT ra.user_id
         FROM role_assignments ra
         JOIN role_permissions rp ON rp.role_id = ra.role_id
         JOIN users u ON u.id = ra.user_id
        WHERE rp.permission = $1 AND u.deleted_at IS NULL AND u.status <> 'disabled'
          AND (ra.scope_type, COALESCE(ra.scope_id, '00000000-0000-0000-0000-000000000000'::uuid)) IN (
                SELECT s.type, COALESCE(s.id, '00000000-0000-0000-0000-000000000000'::uuid)
                  FROM jsonb_to_recordset($2::jsonb) AS s(type text, id uuid))
          AND NOT (ra.user_id = ANY($3::uuid[]))`,
      [permission, JSON.stringify(chain), exclude],
    );
    return rows.rows.map((r) => r.user_id);
  }
}
