import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { ENV, Env } from '../config/env';
import { DatabaseService } from '../db/database.service';
import { KeycloakAdminService } from '../keycloak/keycloak-admin.service';
import { SYSTEM_ROLES } from '../rbac/system-roles';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const provisionTenantSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().trim().min(2).max(200),
  plan: z.enum(['standard', 'premium']).default('standard'),
  defaultLocale: z.enum(['fr', 'en']).default('fr'),
  customDomains: z.array(z.string().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).default([]),
  branding: z
    .object({
      logoUrl: z.string().url().optional(),
      faviconUrl: z.string().url().optional(),
      primaryColor: hexColor.optional(),
      secondaryColor: hexColor.optional(),
    })
    .default({}),
  rector: z.object({
    email: z.string().email().toLowerCase(),
    fullName: z.string().trim().min(2).max(200),
  }),
});
export type ProvisionTenantInput = z.infer<typeof provisionTenantSchema>;

export interface KeycloakSyncResult {
  realm: 'created' | 'exists' | 'skipped';
  rectorInvitation: { emailSent: boolean } | { error: string } | null;
}

/**
 * Onboarding d'une université :
 *   1. realm Keycloak univ-<slug> (idempotent), avant la base pour qu'un échec
 *      Keycloak n'y laisse rien ;
 *   2. une transaction : tenant, domaines, marque, rôles système, Recteur invité ;
 *   3. invitation du Recteur dans Keycloak (e-mail de définition du mot de passe et de la MFA).
 * Si l'étape 3 échoue, l'université existe déjà : syncKeycloak() la rejoue.
 */
@Injectable()
export class TenantProvisioningService {
  private readonly logger = new Logger(TenantProvisioningService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly resolver: TenantResolverService,
    private readonly keycloak: KeycloakAdminService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async provision(input: ProvisionTenantInput, actorExternalId: string) {
    const realm = `univ-${input.slug}`;
    const domains = [`${input.slug}.${this.env.BASE_DOMAIN}`, ...input.customDomains];

    const taken = await this.db.withPlatform(null, (tx) => tx.query('SELECT 1 FROM tenants WHERE slug = $1', [input.slug]));
    if (taken.rowCount) throw new ConflictException(`Le slug ${input.slug} est déjà pris`);

    const realmStatus = this.keycloak.enabled
      ? await this.keycloak.ensureRealm({ realm, displayName: input.name, domains, locale: input.defaultLocale })
      : 'skipped';

    const result = await this.db.withPlatform(null, async (tx) => {
      const existing = await tx.query('SELECT 1 FROM tenants WHERE slug = $1', [input.slug]);
      if (existing.rowCount) throw new ConflictException(`Le slug ${input.slug} est déjà pris`);

      const tenant = (
        await tx.query<{ id: string; keycloak_realm: string }>(
          `INSERT INTO tenants (slug, name, plan, keycloak_realm, default_locale)
           VALUES ($1, $2, $3, $4, $5) RETURNING id, keycloak_realm`,
          [input.slug, input.name, input.plan, realm, input.defaultLocale],
        )
      ).rows[0];

      for (const [i, domain] of domains.entries()) {
        await tx.query(
          // Le sous-domaine Elongo est vérifié d'office ; un domaine personnalisé attend sa vérification DNS.
          `INSERT INTO tenant_domains (tenant_id, domain, is_primary, verified_at)
           VALUES ($1, $2, $3, CASE WHEN $3 THEN now() END)`,
          [tenant.id, domain, i === 0],
        );
      }

      // À partir d'ici on écrit dans les tables de l'université : la RLS s'applique.
      await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);

      await tx.query(
        `INSERT INTO tenant_branding (tenant_id, logo_url, favicon_url, primary_color, secondary_color)
         VALUES ($1, $2, $3, COALESCE($4, '#1D4ED8'), COALESCE($5, '#F59E0B'))`,
        [
          tenant.id,
          input.branding.logoUrl ?? null,
          input.branding.faviconUrl ?? null,
          input.branding.primaryColor ?? null,
          input.branding.secondaryColor ?? null,
        ],
      );

      const roleIds = new Map<string, string>();
      for (const role of SYSTEM_ROLES) {
        const roleId = (
          await tx.query<{ id: string }>(
            `INSERT INTO roles (tenant_id, key, name, is_system) VALUES ($1, $2, $3, true) RETURNING id`,
            [tenant.id, role.key, role.name],
          )
        ).rows[0].id;
        roleIds.set(role.key, roleId);
        await tx.query(
          `INSERT INTO role_permissions (tenant_id, role_id, permission) SELECT $1, $2, unnest($3::text[])`,
          [tenant.id, roleId, role.permissions],
        );
      }

      const rectorId = (
        await tx.query<{ id: string }>(
          `INSERT INTO users (tenant_id, email, full_name, status) VALUES ($1, $2, $3, 'invited') RETURNING id`,
          [tenant.id, input.rector.email, input.rector.fullName],
        )
      ).rows[0].id;
      await tx.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type) VALUES ($1, $2, $3, 'university')`,
        [tenant.id, rectorId, roleIds.get('rector')],
      );

      await this.audit.record(tx, tenant.id, {
        actorUserId: null,
        action: 'tenant.provisioned',
        entityType: 'tenant',
        entityId: tenant.id,
        after: { slug: input.slug, name: input.name, plan: input.plan, domains, provisionedBy: actorExternalId },
      });

      return { id: tenant.id, slug: input.slug, keycloakRealm: tenant.keycloak_realm, domains, rectorUserId: rectorId };
    });
    this.resolver.invalidate();

    const rectorInvitation = await this.inviteRector(realm, input.rector);
    const keycloak: KeycloakSyncResult = { realm: realmStatus, rectorInvitation };
    return { ...result, keycloak };
  }

  /** Rejoue la partie Keycloak d'un onboarding (realm et invitation du Recteur). */
  async syncKeycloak(slug: string): Promise<KeycloakSyncResult> {
    const row = await this.db.withPlatform(null, async (tx) => {
      const tenant = (
        await tx.query<{ id: string; name: string; keycloak_realm: string; default_locale: string }>(
          'SELECT id, name, keycloak_realm, default_locale FROM tenants WHERE slug = $1',
          [slug],
        )
      ).rows[0];
      if (!tenant) throw new NotFoundException(`Université ${slug} inconnue`);
      const domains = (
        await tx.query<{ domain: string }>('SELECT domain FROM tenant_domains WHERE tenant_id = $1 ORDER BY is_primary DESC, domain', [tenant.id])
      ).rows.map((d) => d.domain);
      await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);
      const rector = (
        await tx.query<{ email: string; full_name: string }>(
          `SELECT u.email, u.full_name FROM users u
             JOIN role_assignments ra ON ra.user_id = u.id
             JOIN roles r ON r.id = ra.role_id
            WHERE r.key = 'rector' AND u.status = 'invited' AND u.deleted_at IS NULL
            ORDER BY u.created_at LIMIT 1`,
        )
      ).rows[0];
      return { tenant, domains, rector };
    });

    if (!this.keycloak.enabled) return { realm: 'skipped', rectorInvitation: null };
    const realm = await this.keycloak.ensureRealm({
      realm: row.tenant.keycloak_realm,
      displayName: row.tenant.name,
      domains: row.domains,
      locale: row.tenant.default_locale,
    });
    const rectorInvitation = row.rector
      ? await this.inviteRector(row.tenant.keycloak_realm, { email: row.rector.email, fullName: row.rector.full_name })
      : null;
    return { realm, rectorInvitation };
  }

  private async inviteRector(realm: string, rector: { email: string; fullName: string }) {
    if (!this.keycloak.enabled) return null;
    try {
      const { emailSent } = await this.keycloak.inviteUser(realm, { ...rector, requireMfa: true });
      return { emailSent };
    } catch (err) {
      this.logger.error(`Invitation du Recteur dans ${realm} échouée : ${(err as Error).message}`);
      return { error: (err as Error).message };
    }
  }

  async list() {
    return this.db.withPlatform(null, async (tx) => {
      return (
        await tx.query(
          `SELECT t.id, t.slug, t.name, t.status, t.plan, t.created_at AS "createdAt",
                  s.users_total::int AS "usersTotal", s.users_active::int AS "usersActive",
                  s.faculties_total::int AS "facultiesTotal"
             FROM tenants t JOIN app.platform_tenant_stats() s ON s.tenant_id = t.id
            ORDER BY t.created_at`,
        )
      ).rows;
    });
  }
}
