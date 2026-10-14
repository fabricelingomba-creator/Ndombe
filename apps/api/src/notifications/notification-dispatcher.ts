import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ENV, Env, emailFrom } from '../config/env';
import { DatabaseService, Tx } from '../db/database.service';
import { messages } from './catalog';
import { EMAIL_TRANSPORT, EmailTransport, headerSafe, renderEmail } from './email';
import { NotificationsService } from './notifications.service';
import { PUSH_TRANSPORT, PushTransport } from './push';

/** Délais avant chaque nouvel essai d'envoi ; au-delà, l'envoi est abandonné. */
export const RETRY_DELAYS_MINUTES = [1, 5, 30, 120] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MINUTES.length + 1;
/** Un envoi réservé mais non conclu (processus arrêté) redevient disponible après ce délai. */
const LEASE_MINUTES = 5;
const BATCH_SIZE = 50;
const SCHEDULED_EVERY_MS = 5 * 60_000;
/** Une facture échue depuis plus longtemps ne déclenche plus de rappel (évite une rafale au déploiement). */
const OVERDUE_WINDOW_DAYS = 30;
const DUE_SOON_DAYS = 3;

interface ClaimedDelivery {
  id: string;
  recipient: string;
  attempts: number;
  title: string;
  body: string;
  link: string | null;
}

interface ClaimedPush {
  id: string;
  attempts: number;
  notification_id: string;
  user_id: string;
  title: string;
  body: string;
  link: string | null;
}

/** Au-delà, les plus anciens téléphones d'un compte ne sont plus servis. */
const MAX_DEVICES_PER_USER = 10;

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
}

export function retryDelayMinutes(attempts: number): number | null {
  return attempts >= MAX_ATTEMPTS ? null : RETRY_DELAYS_MINUTES[Math.max(attempts, 1) - 1];
}

/**
 * Boucle d'arrière-plan : envoie les e-mails et notifications push en attente et produit les
 * notifications planifiées (rappels de factures, annonces programmées).
 * Plusieurs instances de l'API peuvent tourner : chaque envoi est réservé
 * (FOR UPDATE SKIP LOCKED) avant l'appel réseau, fait hors transaction.
 */
@Injectable()
export class NotificationDispatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NotificationDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastScheduledAt = 0;

  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
    @Inject(EMAIL_TRANSPORT) private readonly transport: EmailTransport | null,
    @Inject(PUSH_TRANSPORT) private readonly push: PushTransport | null,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap() {
    if (this.env.NOTIFICATIONS_INTERVAL_MS === 0) return;
    this.timer = setInterval(() => void this.tick(), this.env.NOTIFICATIONS_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  private tick() {
    if (this.running) return this.running;
    this.running = this.runOnce({ scheduled: Date.now() - this.lastScheduledAt >= SCHEDULED_EVERY_MS })
      .then(() => undefined)
      .catch((err) => this.logger.error(`Échec de la boucle de notifications : ${(err as Error).message}`))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** Un passage complet ; appelé par la boucle, ou directement par les tests. */
  async runOnce(options: { scheduled?: boolean; today?: string } = {}): Promise<{ sent: number; failed: number }> {
    const tenants = (
      await this.db.query<TenantRow>(
        `SELECT t.id, t.slug, t.name,
                (SELECT d.domain FROM tenant_domains d WHERE d.tenant_id = t.id ORDER BY d.is_primary DESC, d.created_at LIMIT 1) AS domain
           FROM tenants t WHERE t.status = 'active' ORDER BY t.created_at`,
      )
    ).rows;
    if (options.scheduled ?? true) {
      this.lastScheduledAt = Date.now();
      for (const tenant of tenants) {
        try {
          await this.db.withTenant(tenant.id, async (tx) => {
            await this.invoiceReminders(tx, tenant.id, options.today);
            await this.announcements(tx, tenant.id);
          });
        } catch (err) {
          this.logger.error(`Notifications planifiées de ${tenant.id} : ${(err as Error).message}`);
        }
      }
    }
    const total = { sent: 0, failed: 0 };
    for (const tenant of tenants) {
      for (const [channel, deliver] of [
        ['e-mail', this.transport ? () => this.deliverEmail(tenant) : null],
        ['push', this.push ? () => this.deliverPush(tenant) : null],
      ] as const) {
        if (!deliver) continue;
        try {
          const result = await deliver();
          total.sent += result.sent;
          total.failed += result.failed;
        } catch (err) {
          this.logger.error(`Envoi ${channel} des notifications de ${tenant.id} : ${(err as Error).message}`);
        }
      }
    }
    return total;
  }

  /** Envoi réussi ; ou nouvel essai plus tard, et abandon après le dernier (renvoie true si abandonné). */
  private async conclude(tenantId: string, id: string, attempts: number, error: string | null): Promise<boolean> {
    if (error === null) {
      await this.db.withTenant(tenantId, (tx) =>
        tx.query(`UPDATE notification_deliveries SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1`, [id]),
      );
      return false;
    }
    const delay = retryDelayMinutes(attempts);
    const message = error.slice(0, 500);
    await this.db.withTenant(tenantId, (tx) =>
      tx.query(
        `UPDATE notification_deliveries
            SET status = CASE WHEN $2::int IS NULL THEN 'failed' ELSE 'pending' END,
                next_attempt_at = now() + make_interval(mins => COALESCE($2::int, 0)), last_error = $3
          WHERE id = $1`,
        [id, delay, message],
      ),
    );
    if (delay === null) this.logger.warn(`Notification abandonnée après ${attempts} essais (envoi ${id}) : ${message}`);
    return delay === null;
  }

  /** Échec définitif sans nouvel essai (plus aucun téléphone à joindre). */
  private async drop(tenantId: string, id: string, reason: string) {
    await this.db.withTenant(tenantId, (tx) =>
      tx.query(`UPDATE notification_deliveries SET status = 'failed', last_error = $2 WHERE id = $1`, [id, reason]),
    );
  }

  private async deliverPush(tenant: TenantRow) {
    const transport = this.push!;
    const claimed = await this.db.withTenant(tenant.id, async (tx) =>
      (
        await tx.query<ClaimedPush>(
          `UPDATE notification_deliveries d
              SET attempts = d.attempts + 1, next_attempt_at = now() + make_interval(mins => $1)
             FROM notifications n
            WHERE n.id = d.notification_id
              AND d.id IN (SELECT id FROM notification_deliveries
                            WHERE status = 'pending' AND channel = 'push' AND next_attempt_at <= now()
                            ORDER BY next_attempt_at LIMIT $2 FOR UPDATE SKIP LOCKED)
            RETURNING d.id, d.attempts, n.id AS notification_id, n.user_id, n.title, n.body, n.link`,
          [LEASE_MINUTES, BATCH_SIZE],
        )
      ).rows,
    );

    const result = { sent: 0, failed: 0 };
    for (const d of claimed) {
      const tokens = await this.db.withTenant(tenant.id, async (tx) =>
        (
          await tx.query<{ token: string }>(
            'SELECT token FROM push_devices WHERE user_id = $1 ORDER BY last_seen_at DESC LIMIT $2',
            [d.user_id, MAX_DEVICES_PER_USER],
          )
        ).rows.map((r) => r.token),
      );
      if (tokens.length === 0) {
        await this.drop(tenant.id, d.id, 'Aucun téléphone enregistré');
        continue;
      }
      let error: string | null;
      try {
        const tickets = await transport.send({
          to: tokens,
          title: d.title,
          body: d.body,
          // L'app ouvre l'écran lié et marque la notification lue ; jamais de donnée au-delà.
          data: { notificationId: d.notification_id, link: d.link, tenant: tenant.slug },
        });
        const gone = tickets.filter((t) => t.unregistered).map((t) => t.token);
        if (gone.length) {
          await this.db.withTenant(tenant.id, (tx) =>
            tx.query('DELETE FROM push_devices WHERE token = ANY($1::text[])', [gone]),
          );
        }
        if (tickets.some((t) => t.ok)) error = null;
        else if (gone.length === tickets.length) {
          await this.drop(tenant.id, d.id, 'Application désinstallée de tous les téléphones');
          continue;
        } else error = tickets.find((t) => !t.ok && !t.unregistered)?.error ?? 'Envoi refusé';
      } catch (err) {
        error = (err as Error).message ?? 'Erreur inconnue';
      }
      if (await this.conclude(tenant.id, d.id, d.attempts, error)) result.failed++;
      else if (error === null) result.sent++;
    }
    return result;
  }

  private async deliverEmail(tenant: TenantRow) {
    const transport = this.transport!;
    const { claimed, color } = await this.db.withTenant(tenant.id, async (tx) => {
      const claimed = (
        await tx.query<ClaimedDelivery>(
          `UPDATE notification_deliveries d
              SET attempts = d.attempts + 1, next_attempt_at = now() + make_interval(mins => $1)
             FROM notifications n
            WHERE n.id = d.notification_id
              AND d.id IN (SELECT id FROM notification_deliveries
                            WHERE status = 'pending' AND channel = 'email' AND next_attempt_at <= now()
                            ORDER BY next_attempt_at LIMIT $2 FOR UPDATE SKIP LOCKED)
            RETURNING d.id, d.recipient, d.attempts, n.title, n.body, n.link`,
          [LEASE_MINUTES, BATCH_SIZE],
        )
      ).rows;
      const branding = await tx.query<{ primary_color: string }>('SELECT primary_color FROM tenant_branding');
      return { claimed, color: branding.rows[0]?.primary_color ?? '#1D4ED8' };
    });

    const result = { sent: 0, failed: 0 };
    const portal = `https://${tenant.domain ?? `${tenant.slug}.${this.env.BASE_DOMAIN}`}`;
    for (const d of claimed) {
      const content = renderEmail({
        university: tenant.name,
        primaryColor: color,
        title: d.title,
        body: d.body,
        url: d.link ? `${portal}${d.link}` : null,
        preferencesUrl: `${portal}/espace/notifications`,
      });
      let error: string | null = null;
      try {
        await transport.send({ from: { name: headerSafe(tenant.name), address: emailFrom(this.env) }, to: d.recipient, ...content });
      } catch (err) {
        error = (err as Error).message ?? 'Erreur inconnue';
      }
      if (await this.conclude(tenant.id, d.id, d.attempts, error)) result.failed++;
      else if (error === null) result.sent++;
    }
    return result;
  }

  /** Rappel avant échéance et relance après échéance, une seule fois chacun par facture. */
  private async invoiceReminders(tx: Tx, tenantId: string, today?: string) {
    const rows = await tx.query<{
      id: string;
      student_user_id: string;
      fee_name: string;
      balance: string;
      currency: string;
      due_on: string;
      overdue: boolean;
    }>(
      `WITH d AS (SELECT COALESCE($1::date, current_date) AS today)
       SELECT i.id, i.student_user_id, f.name AS fee_name, i.currency, i.due_on::text AS due_on,
              i.amount_minor - COALESCE((SELECT sum(p.amount_minor) FROM payments p
                                          WHERE p.invoice_id = i.id AND p.status = 'succeeded'), 0) AS balance,
              i.due_on < d.today AS overdue
         FROM invoices i JOIN fee_structures f ON f.id = i.fee_structure_id, d
        WHERE i.status = 'open'
          AND i.due_on BETWEEN d.today - $2::int AND d.today + $3::int
          -- Un paiement en cours (bordereau à valider, Mobile Money en attente) suspend le rappel.
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.status = 'pending')
          AND NOT EXISTS (SELECT 1 FROM notifications n
                           WHERE n.user_id = i.student_user_id
                             AND n.dedup_key = CASE WHEN i.due_on < d.today THEN 'invoice.overdue:' ELSE 'invoice.due_soon:' END || i.id)`,
      [today ?? null, OVERDUE_WINDOW_DAYS, DUE_SOON_DAYS],
    );
    for (const r of rows.rows) {
      const info = { feeName: r.fee_name, amountMinor: r.balance, currency: r.currency, dueOn: r.due_on };
      const message = r.overdue ? messages.invoiceOverdue(r.id, info) : messages.invoiceDueSoon(r.id, info);
      await this.notifications.notify(tx, tenantId, [r.student_user_id], message);
    }
  }

  /** Diffuse chaque annonce à tous les comptes actifs, une fois publiée. */
  private async announcements(tx: Tx, tenantId: string) {
    const due = await tx.query<{ id: string; title: string; body: string; created_by: string | null }>(
      `SELECT id, title, body, created_by FROM announcements
        WHERE notified_at IS NULL AND deleted_at IS NULL AND published_at <= now()
        ORDER BY published_at FOR UPDATE SKIP LOCKED`,
    );
    for (const a of due.rows) {
      const users = await tx.query<{ id: string }>(
        `SELECT id FROM users WHERE deleted_at IS NULL AND status <> 'disabled' AND id IS DISTINCT FROM $1`,
        [a.created_by],
      );
      await this.notifications.notify(
        tx,
        tenantId,
        users.rows.map((u) => u.id),
        messages.announcement(a.id, a.title, a.body),
      );
      await tx.query('UPDATE announcements SET notified_at = now() WHERE id = $1', [a.id]);
    }
  }
}
